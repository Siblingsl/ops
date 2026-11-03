package app

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"testing"
)

// FR-CX-11：粘贴入库的同作品 sha256 去重。只复用本作品已有资产，
// 跨作品相同字节不得越权复用，也不得因此推进作品修订。

func cx11Upload(t *testing.T, workID string, data []byte, query string) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "paste.png")
	_, _ = fw.Write(data)
	_ = mw.Close()
	resp := env.request("POST", "/api/v1/works/"+workID+"/assets"+query, &buf, mw.FormDataContentType())
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

func cx11WorkRevision(t *testing.T, workID string) int {
	t.Helper()
	var work Work
	env.mustJSON(t, "GET", "/api/v1/works/"+workID, nil, &work)
	return work.Revision
}

func TestCX11PasteAssetDedupeScopedToWork(t *testing.T) {
	account := env.accounts(t).xhs
	var first, second Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "粘贴去重甲"}, &first)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "粘贴去重乙"}, &second)
	data := testPNG(320, 240)

	status, body := cx11Upload(t, first.ID.String(), data, "?dedupe=sha256")
	if status != 200 {
		t.Fatalf("first paste upload: status=%d body=%s", status, body)
	}
	var created assetUpload
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("decode first upload: %v body=%s", err, body)
	}
	if created.Reused {
		t.Fatal("首次上传不应标记 reused")
	}
	revision := cx11WorkRevision(t, first.ID.String())

	// 同一份字节再粘一次：复用同一条资产，不新增行、不推进修订。
	status, body = cx11Upload(t, first.ID.String(), data, "?dedupe=sha256")
	if status != 200 {
		t.Fatalf("second paste upload: status=%d body=%s", status, body)
	}
	var reused assetUpload
	if err := json.Unmarshal(body, &reused); err != nil {
		t.Fatalf("decode second upload: %v body=%s", err, body)
	}
	if !reused.Reused || reused.ID != created.ID {
		t.Fatalf("同作品重复字节必须复用同一资产: first=%s reused=%v second=%s", created.ID, reused.Reused, reused.ID)
	}
	var after Work
	env.mustJSON(t, "GET", "/api/v1/works/"+first.ID.String(), nil, &after)
	if len(after.Assets) != 1 {
		t.Fatalf("去重后本作品资产应只有 1 条，实际 %d 条", len(after.Assets))
	}
	if after.Revision != revision {
		t.Fatalf("去重复用不得推进作品修订: before=%d after=%d", revision, after.Revision)
	}

	// 另一篇作品的相同字节：不得越权复用，必须各自持有自己的资产。
	status, body = cx11Upload(t, second.ID.String(), data, "?dedupe=sha256")
	if status != 200 {
		t.Fatalf("other work upload: status=%d body=%s", status, body)
	}
	var foreign assetUpload
	if err := json.Unmarshal(body, &foreign); err != nil {
		t.Fatalf("decode other work upload: %v body=%s", err, body)
	}
	if foreign.Reused || foreign.ID == created.ID {
		t.Fatalf("跨作品相同字节不得复用: reused=%v id=%s first=%s", foreign.Reused, foreign.ID, created.ID)
	}
	if foreign.WorkID != second.ID {
		t.Fatalf("复用的资产必须归属当前作品: got=%s want=%s", foreign.WorkID, second.ID)
	}

	// 不带 dedupe 时保持原有行为：每次都新建一行。
	status, body = cx11Upload(t, first.ID.String(), data, "")
	if status != 200 {
		t.Fatalf("plain upload: status=%d body=%s", status, body)
	}
	var plain assetUpload
	if err := json.Unmarshal(body, &plain); err != nil {
		t.Fatalf("decode plain upload: %v body=%s", err, body)
	}
	if plain.Reused || plain.ID == created.ID {
		t.Fatalf("未请求去重时必须新建资产: reused=%v id=%s", plain.Reused, plain.ID)
	}

	// 未知去重方式必须拒绝，不能静默按无去重处理。
	status, body = cx11Upload(t, first.ID.String(), data, "?dedupe=md5")
	if status != 422 || !bytes.Contains(body, []byte("dedupe")) {
		t.Fatalf("invalid dedupe must be rejected: status=%d body=%s", status, body)
	}
}

// 锁定作品不能借粘贴上传写入资产。
func TestCX11PasteAssetRejectsLockedWork(t *testing.T) {
	account := env.accounts(t).xhs
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "粘贴去重锁定"}, &work)
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work SET status='published', locked=true WHERE id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	status, body := cx11Upload(t, work.ID.String(), testPNG(200, 150), "?dedupe=sha256")
	if status != 409 && status != 422 {
		t.Fatalf("locked work must reject upload: status=%d body=%s", status, body)
	}
}
