package app

// DEV-AG07 附件契约测试（16 文档第 8 节、第 11.1 节、第 13 节）。

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// agentAttachmentPath 返回附件接口路径。
func agentAttachmentPath(id uuid.UUID) string {
	return "/api/v1/agent/attachments/" + id.String()
}

// agentUploadAttachment 以 multipart 上传附件（本人）；convID 为空表示不带对话。
func agentUploadAttachment(t *testing.T, name string, data []byte, convID string) (int, agentAttachmentView, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	if convID != "" {
		_ = mw.WriteField("conversation_id", convID)
	}
	_ = mw.Close()
	resp := env.request("POST", "/api/v1/agent/attachments", &buf, mw.FormDataContentType())
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var view agentAttachmentView
	if resp.StatusCode == 200 {
		if err := json.Unmarshal(b, &view); err != nil {
			t.Fatalf("上传响应解析失败：%v (%s)", err, b)
		}
	}
	return resp.StatusCode, view, b
}

// agentUploadAttachmentAs 以另一会话（访客客户端）上传附件。
func agentUploadAttachmentAs(t *testing.T, c *guestClient, name string, data []byte) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	c.use()
	resp := c.parent.request("POST", "/api/v1/agent/attachments", &buf, mw.FormDataContentType())
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	c.csrf = c.parent.csrf
	return resp.StatusCode, b
}

// agentAttachmentFileBytes 读取附件文件（本人）；variant 为空表示 original。
func agentAttachmentFileBytes(t *testing.T, id uuid.UUID, variant string) (int, []byte) {
	t.Helper()
	path := agentAttachmentPath(id) + "/file"
	if variant != "" {
		path += "?variant=" + variant
	}
	return env.do("GET", path, nil)
}

// agentErrCodeOf 解析错误响应中的错误码。
func agentErrCodeOf(t *testing.T, body []byte) string {
	t.Helper()
	var e struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("错误体解析失败：%v (%s)", err, body)
	}
	return e.Error.Code
}

// agentAttachmentStoragePath 取附件的 storage_path。
func agentAttachmentStoragePath(t *testing.T, id uuid.UUID) string {
	t.Helper()
	var p string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT storage_path FROM agent_attachment WHERE id=$1`, id).Scan(&p); err != nil {
		t.Fatal(err)
	}
	return p
}

// jpegWithFakeExif 生成一张带假 EXIF 段的 JPEG，用于验证“存储前去除 EXIF”。
func jpegWithFakeExif(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for y := 0; y < 48; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 3), uint8(y * 4), 90, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	payload := []byte("Exif\x00\x00FAKE-EXIF-PAYLOAD-0123456789")
	seg := []byte{0xFF, 0xE1, byte((len(payload) + 2) >> 8), byte((len(payload) + 2) & 0xFF)}
	seg = append(seg, payload...)
	out := append([]byte{}, raw[:2]...) // SOI
	out = append(out, seg...)
	out = append(out, raw[2:]...)
	return out
}

// hugeHeaderPNG 生成只含合法 IHDR 的 PNG 头，声明超大像素（解码前检查用）。
func hugeHeaderPNG(w, h int) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], uint32(w))
	binary.BigEndian.PutUint32(ihdr[4:8], uint32(h))
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // RGBA
	buf.Write([]byte{0, 0, 0, 13})
	buf.WriteString("IHDR")
	buf.Write(ihdr)
	crc := crc32.NewIEEE()
	crc.Write([]byte("IHDR"))
	crc.Write(ihdr)
	var tail [4]byte
	binary.BigEndian.PutUint32(tail[:], crc.Sum32())
	buf.Write(tail[:])
	return buf.Bytes()
}

// 判据 1（第 8.1、8.2 节）：图片上传生成原图、model 变体（1568 JPEG）与 256 缩略图。
func TestAG07UploadImageAndVariants(t *testing.T) {
	env.ensureToolModel(t)
	conv := env.createConversation(t, map[string]any{})
	defer deleteConversations(t, conv.ID)

	code, view, body := agentUploadAttachment(t, "photo.png", testPNG(2000, 1200), conv.ID.String())
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	if view.Kind != "image" || view.Width == nil || *view.Width != 2000 || view.Height == nil || *view.Height != 1200 {
		t.Fatalf("元数据错误：%+v", view)
	}
	if view.Bytes <= 0 {
		t.Fatalf("bytes 应为正数：%+v", view)
	}
	if want := "/api/v1/agent/attachments/" + view.ID.String() + "/file?conversation_id=" + conv.ID.String(); view.URL != want {
		t.Fatalf("URL 错误：%s != %s", view.URL, want)
	}

	// original：保持原始尺寸、可解码、无 EXIF。
	st, orig := agentAttachmentFileBytes(t, view.ID, "original")
	if st != 200 {
		t.Fatalf("original 读取失败：%d", st)
	}
	img, _, err := image.Decode(bytes.NewReader(orig))
	if err != nil {
		t.Fatalf("original 应为有效图片：%v", err)
	}
	if img.Bounds().Dx() != 2000 || img.Bounds().Dy() != 1200 {
		t.Fatalf("original 尺寸错误：%v", img.Bounds())
	}
	if bytes.Contains(orig, []byte("Exif\x00\x00")) {
		t.Fatal("original 不应包含 EXIF")
	}

	// model：JPEG，长边 1568。
	st, modelBytes := agentAttachmentFileBytes(t, view.ID, "model")
	if st != 200 {
		t.Fatalf("model 读取失败：%d", st)
	}
	if _, format, err := image.DecodeConfig(bytes.NewReader(modelBytes)); err != nil || format != "jpeg" {
		t.Fatalf("model 应为 JPEG：%v %s", err, format)
	}
	mimg, _, err := image.Decode(bytes.NewReader(modelBytes))
	if err != nil {
		t.Fatalf("model 应可解码：%v", err)
	}
	if max(mimg.Bounds().Dx(), mimg.Bounds().Dy()) != 1568 {
		t.Fatalf("model 长边应为 1568：%v", mimg.Bounds())
	}

	// thumb：JPEG，长边 256。
	st, thumb := agentAttachmentFileBytes(t, view.ID, "thumb")
	if st != 200 {
		t.Fatalf("thumb 读取失败：%d", st)
	}
	timg, _, err := image.Decode(bytes.NewReader(thumb))
	if err != nil {
		t.Fatalf("thumb 应可解码：%v", err)
	}
	if max(timg.Bounds().Dx(), timg.Bounds().Dy()) != 256 {
		t.Fatalf("thumb 长边应为 256：%v", timg.Bounds())
	}

	// 文件落盘：原图与两个变体。
	storagePath := agentAttachmentStoragePath(t, view.ID)
	for _, p := range []string{storagePath, storagePath + ".model.jpg", storagePath + ".thumb.jpg"} {
		if _, err := os.Stat(env.srv.agentAttachmentFile(p)); err != nil {
			t.Fatalf("文件应存在：%s %v", p, err)
		}
	}
}

// 判据 2（第 8.1 节）：存储前去除 EXIF。
func TestAG07StripExifOnJpeg(t *testing.T) {
	env.ensureToolModel(t)
	raw := jpegWithFakeExif(t)
	if !bytes.Contains(raw, []byte("Exif\x00\x00")) {
		t.Fatal("测试样本应含 EXIF 标记")
	}
	code, view, body := agentUploadAttachment(t, "shot.jpg", raw, "")
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	if view.Mime != "image/jpeg" {
		t.Fatalf("mime 应为 image/jpeg：%s", view.Mime)
	}
	st, stored := agentAttachmentFileBytes(t, view.ID, "original")
	if st != 200 {
		t.Fatalf("original 读取失败：%d", st)
	}
	if bytes.Contains(stored, []byte("Exif\x00\x00")) || bytes.Contains(stored, []byte("FAKE-EXIF")) {
		t.Fatal("存储前应去除 EXIF")
	}
	if _, format, err := image.DecodeConfig(bytes.NewReader(stored)); err != nil || format != "jpeg" {
		t.Fatalf("original 应为 JPEG：%v %s", err, format)
	}
}

// 判据 3（第 8.1、8.2 节）：文本附件清洗（BOM、控制字符）并保存全文。
func TestAG07UploadText(t *testing.T) {
	env.ensureToolModel(t)
	raw := []byte("\uFEFF# 标题\n正文\x00\x07\x1b带控制字符\t制表")
	code, view, body := agentUploadAttachment(t, "note.md", raw, "")
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	if view.Kind != "text" {
		t.Fatalf("kind 应为 text：%+v", view)
	}
	want := "# 标题\n正文带控制字符\t制表"
	st, stored := agentAttachmentFileBytes(t, view.ID, "original")
	if st != 200 || string(stored) != want {
		t.Fatalf("存储文本应清洗：%d %q", st, stored)
	}
	var textContent string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT coalesce(text_content,'') FROM agent_attachment WHERE id=$1`, view.ID).Scan(&textContent); err != nil {
		t.Fatal(err)
	}
	if textContent != want {
		t.Fatalf("text_content 应清洗：%q", textContent)
	}
	// 文本附件没有图片变体。
	if st, _ := agentAttachmentFileBytes(t, view.ID, "model"); st != 404 {
		t.Fatalf("文本附件不应有 model 变体：%d", st)
	}
	if st, _ := agentAttachmentFileBytes(t, view.ID, "thumb"); st != 404 {
		t.Fatalf("文本附件不应有 thumb 变体：%d", st)
	}
}

// 判据 4（第 8.1 节）：大小、像素与格式限制，统一 422 agent_attachment_invalid。
func TestAG07UploadLimits(t *testing.T) {
	env.ensureToolModel(t)

	big := bytes.Repeat([]byte("a"), agentTextBytes+1)
	if code, _, body := agentUploadAttachment(t, "big.md", big, ""); code != 422 || agentErrCodeOf(t, body) != "agent_attachment_invalid" {
		t.Fatalf("超限文本应 422 agent_attachment_invalid：%d %s", code, body)
	}

	huge := bytes.Repeat([]byte{0x89}, agentImageBytes+1)
	if code, _, body := agentUploadAttachment(t, "huge.png", huge, ""); code != 422 || agentErrCodeOf(t, body) != "agent_attachment_invalid" {
		t.Fatalf("超限图片应 422 agent_attachment_invalid：%d %s", code, body)
	}

	if code, _, body := agentUploadAttachment(t, "wide.png", hugeHeaderPNG(5000, 4000), ""); code != 422 || agentErrCodeOf(t, body) != "agent_attachment_invalid" {
		t.Fatalf("超像素应 422 agent_attachment_invalid：%d %s", code, body)
	}

	if code, _, body := agentUploadAttachment(t, "fake.png", []byte("%PDF-1.7 not an image"), ""); code != 422 || agentErrCodeOf(t, body) != "agent_attachment_invalid" {
		t.Fatalf("非法格式应 422 agent_attachment_invalid：%d %s", code, body)
	}

	if code, _, body := agentUploadAttachment(t, "empty.png", nil, ""); code != 422 || agentErrCodeOf(t, body) != "agent_attachment_invalid" {
		t.Fatalf("空文件应 422 agent_attachment_invalid：%d %s", code, body)
	}
}

// 判据 5（第 8.2 节第 5 项、第 9.2 节）：文件读取的隐私边界。
func TestAG07FileAccessPrivacy(t *testing.T) {
	env.ensureToolModel(t)
	code, view, body := agentUploadAttachment(t, "pic.png", testPNG(32, 32), "")
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	if st, _ := agentAttachmentFileBytes(t, uuid.New(), "original"); st != 404 {
		t.Fatalf("未知附件应 404：%d", st)
	}
	if st, _ := env.do("GET", agentAttachmentPath(view.ID)+"/file?variant=bogus", nil); st != 422 {
		t.Fatalf("非法变体应 422：%d", st)
	}

	other := env.registerClient(t, "ag07-privacy-"+uuid.NewString()[:8], testPassword)
	if st, _ := other.do("GET", agentAttachmentPath(view.ID)+"/file", nil); st != 404 {
		t.Fatalf("他人读取应 404：%d", st)
	}
	if st, _ := other.do("DELETE", agentAttachmentPath(view.ID), nil); st != 404 {
		t.Fatalf("他人删除应 404：%d", st)
	}
	other.restore(env)
}

// 判据 6（第 11.1 节）：删除未发送的附件；已发送的拒绝删除。
func TestAG07Delete(t *testing.T) {
	env.ensureToolModel(t)
	code, view, body := agentUploadAttachment(t, "del.png", testPNG(24, 24), "")
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	storagePath := agentAttachmentStoragePath(t, view.ID)
	if st, _ := env.do("DELETE", agentAttachmentPath(view.ID), nil); st != 200 {
		t.Fatalf("删除应成功：%d", st)
	}
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_attachment WHERE id=$1`, view.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("附件行应删除")
	}
	for _, p := range []string{storagePath, storagePath + ".model.jpg", storagePath + ".thumb.jpg"} {
		if _, err := os.Stat(env.srv.agentAttachmentFile(p)); !os.IsNotExist(err) {
			t.Fatalf("文件应删除：%s", p)
		}
	}

	code, view2, body := agentUploadAttachment(t, "sent.png", testPNG(24, 24), "")
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_attachment SET referenced=true WHERE id=$1`, view2.ID); err != nil {
		t.Fatal(err)
	}
	st, respBody := env.do("DELETE", agentAttachmentPath(view2.ID), nil)
	if st != 422 || agentErrCodeOf(t, respBody) != "agent_attachment_invalid" {
		t.Fatalf("已发送附件不应可删：%d %s", st, respBody)
	}
}

// 判据 7（第 11.2 节）：发送后附件被引用并绑定对话；不能复用；每消息最多 6 个。
func TestAG07MessageLifecycle(t *testing.T) {
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	code, view, body := agentUploadAttachment(t, "note.txt", []byte("你好，这是一段素材"), c.ID.String())
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "保存这条素材", "attachment_ids": []string{view.ID.String()}})

	var ref bool
	var convID *uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT referenced, conversation_id FROM agent_attachment WHERE id=$1`, view.ID).Scan(&ref, &convID); err != nil {
		t.Fatal(err)
	}
	if !ref || convID == nil || *convID != c.ID {
		t.Fatalf("发送后应引用并绑定对话：%v %v", ref, convID)
	}

	env.expectErr(t, "POST", agentRunPath(c, "messages"),
		map[string]any{"text": "再用一次", "attachment_ids": []string{view.ID.String()}}, "agent_attachment_invalid")

	ids := []string{}
	for i := 0; i < 7; i++ {
		ids = append(ids, uuid.NewString())
	}
	env.expectErr(t, "POST", agentRunPath(c, "messages"),
		map[string]any{"text": "七个附件", "attachment_ids": ids}, "agent_attachment_invalid")

	// 属于其他对话的附件不能被本对话引用。
	code, view2, body := agentUploadAttachment(t, "other.txt", []byte("别的对话的素材"), c.ID.String())
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	c2 := env.createConversation(t, map[string]any{})
	defer deleteConversations(t, c2.ID)
	env.expectErr(t, "POST", agentRunPath(c2, "messages"),
		map[string]any{"text": "错对话", "attachment_ids": []string{view2.ID.String()}}, "agent_attachment_invalid")
}

// 判据 8（第 9.5 节、E-28）：消息或文本附件疑似包含密钥时拒绝，内容不保存。
func TestAG07SecretRejection(t *testing.T) {
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	ae := env.expectErr(t, "POST", agentRunPath(c, "messages"),
		map[string]any{"text": "帮我保存 sk-abcdefghijklmnopqrstuvwxyz0123"}, "validation_failed")
	if !strings.Contains(ae.Error.Message, "不要发给智能体") {
		t.Fatalf("提示文案错误：%s", ae.Error.Message)
	}

	code, _, respBody := agentUploadAttachment(t, "secret.txt", []byte("这是密钥：abcdefghijklmnop12345"), "")
	if code != 422 || agentErrCodeOf(t, respBody) != "validation_failed" {
		t.Fatalf("含密钥文本附件应拒绝：%d %s", code, respBody)
	}
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_attachment WHERE coalesce(text_content,'') LIKE '%abcdefghijklmnop12345%'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("被拒绝的附件不应入库")
	}
}

// 判据 9（第 8.4 节）：分发器以附件构造 multipart；附件必须属于本对话与本人。
func TestAG07ToolMultipartDispatch(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "附件分发观点")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	var before int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM asset WHERE work_id=$1`, wk.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}

	code, att, body := agentUploadAttachment(t, "shot.png", testPNG(48, 32), c.ID.String())
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("visual") + "\n#tool assets__upload {\"id\":\"" + wk.ID.String() +
		"\",\"attachment_id\":\"" + att.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 assets__upload 卡片")
	}
	out := env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true})
	done := lastEvent(t, out)
	var payload struct {
		Action struct {
			Status string `json:"status"`
		} `json:"action"`
	}
	if err := json.Unmarshal(done.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if done.Name != "done" || payload.Action.Status != "succeeded" {
		t.Fatalf("卡片应执行成功：%s %+v", done.Name, payload)
	}
	var after int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM asset WHERE work_id=$1`, wk.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before+1 {
		t.Fatalf("应创建一个资产：%d -> %d", before, after)
	}

	// 他人的附件不能用于本对话。
	other := env.registerClient(t, "ag07-dispatch-"+uuid.NewString()[:8], testPassword)
	oc, ob := agentUploadAttachmentAs(t, other, "other.png", testPNG(16, 16))
	other.restore(env)
	if oc != 200 {
		t.Fatalf("他人上传应成功：%d %s", oc, ob)
	}
	var otherView agentAttachmentView
	if err := json.Unmarshal(ob, &otherView); err != nil {
		t.Fatal(err)
	}
	evs2 := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("visual") + "\n#tool assets__upload {\"id\":\"" + wk.ID.String() +
		"\",\"attachment_id\":\"" + otherView.ID.String() + "\"}"})
	action2 := findActionEvent(t, evs2)
	if action2 == nil {
		t.Fatal("应提出卡片（附件校验在执行期）")
	}
	env.expectErr(t, "POST", agentActionPath(action2.ID, "execute"),
		map[string]any{"confirm": true}, "agent_attachment_invalid")
}

// 判据 10（第 8.3 节、E-27）：看图能力决定图片是否发送；最多 4 张；关闭时环境块注明。
func TestAG07VisionRules(t *testing.T) {
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	ids := []string{}
	for i := 0; i < 5; i++ {
		code, v, body := agentUploadAttachment(t, fmt.Sprintf("pic%d.png", i), testPNG(12, 12), c.ID.String())
		if code != 200 {
			t.Fatalf("上传应成功：%d %s", code, body)
		}
		ids = append(ids, v.ID.String())
	}

	env.llm.ResetRequests()
	env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "看看这些图片", "attachment_ids": ids})
	reqs := env.llm.Requests()
	if len(reqs) == 0 {
		t.Fatal("应产生模型请求")
	}
	first := reqs[0]
	if n := strings.Count(first, "data:image/jpeg;base64"); n != agentMaxImagesToModel {
		t.Fatalf("应发送 %d 张图片（model 变体 JPEG）：%d", agentMaxImagesToModel, n)
	}
	if !strings.Contains(first, "[图片 ") {
		t.Fatal("第 5 张应替换为文字占位")
	}

	// 关闭看图：重新自检后不再发送图片，环境块注明。
	env.llm.NoVision = true
	env.mustJSON(t, "POST", "/api/v1/model-providers/"+pid+"/selftest", map[string]any{"model": "mock-writer"}, nil)
	env.llm.NoVision = false

	code, fresh, body := agentUploadAttachment(t, "again.png", testPNG(12, 12), c.ID.String())
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	env.llm.ResetRequests()
	env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "再看看", "attachment_ids": []string{fresh.ID.String()}})
	reqs = env.llm.Requests()
	if len(reqs) == 0 {
		t.Fatal("应产生模型请求")
	}
	again := reqs[0]
	if strings.Contains(again, "data:image") {
		t.Fatal("不支持看图时不应发送图片")
	}
	if !strings.Contains(again, "当前模型不能看图") {
		t.Fatal("环境块应注明当前模型不能看图")
	}
}

// 判据 11（第 9.7 节第 2 项）：孤立附件（含变体文件）由清理任务删除。
func TestAG07CleanupVariants(t *testing.T) {
	ctx := context.Background()
	me := env.me(t)
	wsID := uuid.MustParse(me.Workspace.ID)
	userID := uuid.MustParse(me.UserID)
	attID := uuid.New()
	storagePath := "agent/" + wsID.String() + "/" + userID.String() + "/" + attID.String()
	for _, p := range []string{storagePath, storagePath + ".model.jpg", storagePath + ".thumb.jpg"} {
		full := env.srv.agentAttachmentFile(p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO agent_attachment
		(id, workspace_id, user_id, kind, name, mime, bytes, sha256, storage_path, referenced, created_at)
		VALUES ($1,$2,$3,'image','old.png','image/png',1,'x',$4,false, now() - interval '25 hours')`,
		attID, wsID, userID, storagePath); err != nil {
		t.Fatal(err)
	}
	n, err := env.srv.purgeAgentAttachments(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 {
		t.Fatalf("应清理孤立附件：%d", n)
	}
	var cnt int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM agent_attachment WHERE id=$1`, attID).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 0 {
		t.Fatal("孤立附件行应删除")
	}
	for _, p := range []string{storagePath, storagePath + ".model.jpg", storagePath + ".thumb.jpg"} {
		if _, err := os.Stat(env.srv.agentAttachmentFile(p)); !os.IsNotExist(err) {
			t.Fatalf("变体文件应一并删除：%s", p)
		}
	}
}

// 判据 12（第 10 节说明 3）：删除对话清理附件文件（含变体）。
func TestAG07ConversationDeleteRemovesVariants(t *testing.T) {
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	code, view, body := agentUploadAttachment(t, "bye.png", testPNG(20, 20), c.ID.String())
	if code != 200 {
		t.Fatalf("上传应成功：%d %s", code, body)
	}
	storagePath := agentAttachmentStoragePath(t, view.ID)
	env.mustJSON(t, "DELETE", "/api/v1/agent/conversations/"+c.ID.String()+"?confirm=true", nil, nil)
	for _, p := range []string{storagePath, storagePath + ".model.jpg", storagePath + ".thumb.jpg"} {
		if _, err := os.Stat(env.srv.agentAttachmentFile(p)); !os.IsNotExist(err) {
			t.Fatalf("删除对话应清理附件文件：%s", p)
		}
	}
}
