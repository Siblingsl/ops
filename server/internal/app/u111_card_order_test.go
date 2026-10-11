package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ops/internal/wechat"

	"github.com/google/uuid"
)

func TestU111ImageCompletionAfterReorder(t *testing.T) {
	_, wk := buildCardWork(t, "xhs")
	ctx := context.Background()
	var providerID uuid.UUID
	var originalURL string
	if err := env.srv.db.QueryRow(ctx, `SELECT p.id,p.base_url FROM model_route r JOIN model_provider p ON p.id=r.provider_id WHERE r.workspace_id=(SELECT workspace_id FROM platform_account WHERE id=$1) AND r.task_type IN ('default','image_gen') ORDER BY (r.task_type='image_gen') DESC LIMIT 1`, wk.AccountID).Scan(&providerID, &originalURL); err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		env.llm.Handler().ServeHTTP(w, r)
	}))
	defer model.Close()
	defer unblock()
	if _, err := env.srv.db.Exec(ctx, `UPDATE model_provider SET base_url=$2 WHERE id=$1`, providerID, model.URL+"/v1"); err != nil {
		t.Fatal(err)
	}
	defer env.srv.db.Exec(ctx, `UPDATE model_provider SET base_url=$2 WHERE id=$1`, providerID, originalURL)
	finished := make(chan int, 1)
	go func() {
		status, _ := env.do("POST", "/api/v1/works/"+wk.ID.String()+"/cards/"+wk.Sections[0].ID.String()+"/generate-image", map[string]string{"prompt": "并发排序测试插画"})
		finished <- status
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("生图请求未到模型")
	}
	ids := make([]uuid.UUID, len(wk.Sections))
	for i, sec := range wk.Sections {
		ids[len(ids)-i-1] = sec.ID
	}
	env.mustJSON(t, "PUT", "/api/v1/works/"+wk.ID.String()+"/sections/order", map[string]any{"ids": ids}, nil)
	unblock()
	select {
	case status := <-finished:
		if status != 200 {
			t.Fatalf("生图失败: %d", status)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("生图未完成")
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	for i, card := range wk.Cards {
		if card.SectionID != ids[i] || card.Position != i {
			t.Fatalf("生图回写了排序前位置: %+v", wk.Cards)
		}
	}
}

func TestU111ReorderDuringSectionSave(t *testing.T) {
	_, wk := buildCardWork(t, "xhs")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	writer, err := env.srv.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	var writerPID int
	if err := writer.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&writerPID); err != nil {
		t.Fatal(err)
	}
	// 复现自动保存/AI 落稿的段落→作品锁顺序；内容更新尚未提交。
	if _, err := writer.Exec(ctx, `UPDATE work_section SET content_md='协作者的新正文' WHERE id=$1`, wk.Sections[0].ID); err != nil {
		t.Fatal(err)
	}
	ids := make([]uuid.UUID, len(wk.Sections))
	for i, sec := range wk.Sections {
		ids[len(ids)-i-1] = sec.ID
	}
	finished := make(chan int, 1)
	go func() {
		status, _ := env.do("PUT", "/api/v1/works/"+wk.ID.String()+"/sections/order", map[string]any{"ids": ids})
		finished <- status
	}()
	// 直到排序确实等在上述段落锁，才让保存继续 touchContent。
	for {
		var blocked bool
		if err := env.srv.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, writerPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("排序没有进入预期交错点")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := env.srv.touchContent(ctx, writer, wk.ID); err != nil {
		t.Fatalf("保存与排序锁顺序冲突: %v", err)
	}
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case status := <-finished:
		if status != 200 {
			t.Fatalf("并发排序失败: %d", status)
		}
	case <-ctx.Done():
		t.Fatal("保存提交后排序未完成")
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	if wk.Sections[len(wk.Sections)-1].ContentMD != "协作者的新正文" {
		t.Fatal("丢失协作者保存")
	}
	for i, card := range wk.Cards {
		if card.SectionID != ids[i] || card.Position != i {
			t.Fatal("保存期间排序不一致")
		}
	}
}

func TestU111CardOrderAndImageRetention(t *testing.T) {
	_, wk := buildCardWork(t, "xhs")
	id := wk.ID.String()
	// 不同尺寸的本地图片保证字节/hash 不同，能真正检测打包顺序。
	for i, card := range wk.Cards {
		a := env.upload(t, id, testPNG(120+i, 100))
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE work_card SET image_asset_id=$2 WHERE id=$1`, card.ID, a.ID); err != nil {
			t.Fatal(err)
		}
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	ids := make([]uuid.UUID, len(wk.Sections))
	for i, sec := range wk.Sections {
		ids[len(ids)-i-1] = sec.ID
	}
	oldImage := *wk.Cards[0].ImageAssetID
	env.mustJSON(t, "PUT", "/api/v1/works/"+id+"/sections/order", map[string]any{"ids": ids}, &wk)
	for i, card := range wk.Cards {
		if card.SectionID != ids[i] || card.Position != i || wk.Sections[i].ID != ids[i] {
			t.Fatalf("卡片与段落顺序不一致: %d %+v", i, card)
		}
	}
	env.expectErr(t, "PUT", "/api/v1/works/"+id+"/sections/order", map[string]any{"ids": ids[:1]}, "validation_failed")
	bad := append([]uuid.UUID{}, ids...)
	bad[0] = bad[1]
	env.expectErr(t, "PUT", "/api/v1/works/"+id+"/sections/order", map[string]any{"ids": bad}, "validation_failed")
	bad[0] = uuid.New()
	env.expectErr(t, "PUT", "/api/v1/works/"+id+"/sections/order", map[string]any{"ids": bad}, "validation_failed")
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/cards/"+ids[len(ids)-1].String()+"/generate-image", map[string]string{"prompt": "信息卡片插画：清晨的绿色书桌、笔记本和咖啡，保持留白，不绘制文字"}, nil)
	// 重新生成不删除旧资产，可继续从图片库访问。
	resp := env.request("GET", "/api/v1/assets/"+oldImage.String()+"/file", nil, "")
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal("重新生成删除了旧资产")
	}
	env.confirmChecks(t, id)
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/xhs/pack", nil, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	resp = env.request("GET", "/api/v1/works/"+id+"/xhs/pack.zip", nil, "")
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	imageIndex := 0
	for _, file := range zr.File {
		rc, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(rc)
		rc.Close()
		if strings.HasSuffix(file.Name, ".txt") {
			text := string(data)
			if strings.Index(text, wk.Cards[0].Heading) > strings.Index(text, wk.Cards[1].Heading) {
				t.Fatal("打包文案未按卡片排序")
			}
			continue
		}
		assetResp := env.request("GET", wk.Cards[imageIndex].ImageURL, nil, "")
		want, _ := io.ReadAll(assetResp.Body)
		assetResp.Body.Close()
		if !bytes.Equal(data, want) {
			t.Fatalf("第 %d 张打包图片顺序错误", imageIndex+1)
		}
		imageIndex++
	}
	if imageIndex != len(wk.Cards) {
		t.Fatal("打包缺少卡片图片")
	}
	var stored int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work_card c JOIN work_section s ON s.id=c.section_id WHERE c.work_id=$1 AND c.position=s.position`, wk.ID).Scan(&stored); err != nil || stored != len(ids) {
		t.Fatalf("数据库排序未同步: %d %v", stored, err)
	}
}

func TestU111WechatCardImageOrder(t *testing.T) {
	a, wk := buildCardWork(t, "wechat_mp")
	id := wk.ID.String()
	ids := make([]uuid.UUID, len(wk.Sections))
	for i, card := range wk.Cards {
		asset := env.upload(t, id, testPNG(150+i, 100))
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE work_card SET image_asset_id=$2 WHERE id=$1`, card.ID, asset.ID); err != nil {
			t.Fatal(err)
		}
		ids[len(ids)-i-1] = card.SectionID
	}
	env.mustJSON(t, "PUT", "/api/v1/works/"+id+"/sections/order", map[string]any{"ids": ids}, &wk)
	env.confirmChecks(t, id)
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	env.reauth(t)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx1234567890", "app_secret": "local-u111-mock-secret"}, nil)
	ev := lastEvent(t, env.sse(t, "/api/v1/works/"+id+"/wechat/push", map[string]any{"revision": wk.Revision, "fields": wk.WechatFields}))
	if ev.Name != "done" {
		t.Fatalf("mock 图片消息草稿失败: %s %s", ev.Name, ev.Data)
	}
	var done struct {
		MediaID string `json:"draft_media_id"`
	}
	if err := json.Unmarshal([]byte(ev.Data), &done); err != nil {
		t.Fatal(err)
	}
	token, err := env.srv.accessToken(context.Background(), a.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"media_id": done.MediaID})
	resp, err := http.Post(fmt.Sprintf("%s/cgi-bin/draft/get?access_token=%s", env.mock.URL, token), "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var result struct {
		Items []wechat.Article `json:"news_item"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].ImageInfo == nil || len(result.Items[0].ImageInfo.ImageList) != len(ids) {
		t.Fatal("mock 草稿图片清单不完整")
	}
	for i, image := range result.Items[0].ImageInfo.ImageList {
		var want string
		err := env.srv.db.QueryRow(context.Background(), `SELECT c.media_id FROM wechat_media_cache c JOIN asset a ON a.sha256=c.sha256 WHERE c.account_id=$1 AND c.kind='image' AND a.id=$2`, a.ID, wk.Cards[i].ImageAssetID).Scan(&want)
		if err != nil || image.ImageMediaID != want {
			t.Fatalf("图片消息第 %d 张顺序错误: %s != %s (%v)", i, image.ImageMediaID, want, err)
		}
	}
}
