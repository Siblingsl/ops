package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ops/internal/cxcanonicaljson"
	"ops/internal/cxrendercontract"
	"ops/internal/markdownsyntax"
)

func TestCX02RejectsUnregisteredRendererVersion(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "排版版本混用拒绝验收"}, &work)

	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"wechat_html"}, "options": map[string]any{}, "client": "desktop",
		"renderer_contract_version": "ops.wechat-html/v0",
	})
	if status != 409 || !bytes.Contains(body, []byte("renderer_version_mismatch")) {
		t.Fatalf("unregistered renderer version: status=%d body=%s", status, body)
	}
	var builds int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM work_build WHERE work_id=$1`, work.ID).Scan(&builds); err != nil {
		t.Fatal(err)
	}
	if builds != 0 {
		t.Fatalf("unregistered renderer version created %d build rows", builds)
	}
}

func TestCX02BuildSnapshotIdempotencyAndCurrentness(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "构建快照验收"}, &work)
	initialRevision := work.Revision

	create := func(targets []string, client string) (int, cxBuildCreateResponse) {
		t.Helper()
		var response cxBuildCreateResponse
		status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
			"basis_revision": work.Revision, "targets": targets, "options": map[string]any{}, "client": client,
			"renderer_contract_version": cxrendercontract.WechatHTMLV1,
		})
		if status != 201 && status != 202 {
			t.Fatalf("create build: status=%d body=%s", status, body)
		}
		if err := json.Unmarshal(body, &response); err != nil {
			t.Fatalf("decode create response: %v; body=%s", err, body)
		}
		return status, response
	}

	status, first := create([]string{"wechat_html"}, "desktop")
	if status != 201 || first.Status != "running" || first.Reused {
		t.Fatalf("new build response = status %d, %+v", status, first)
	}
	snapshotValue, err := cxcanonicaljson.Parse(first.SourceSnapshot)
	if err != nil {
		t.Fatalf("decode frozen source snapshot: %v", err)
	}
	gotHash, err := cxcanonicaljson.Hash(snapshotValue)
	if err != nil || gotHash != first.SourceHash {
		t.Fatalf("source hash mismatch: got %q, want %q, err=%v", gotHash, first.SourceHash, err)
	}
	paramsHash, err := cxcanonicaljson.Hash(map[string]any{
		"targets": []any{"wechat_html"}, "options": map[string]any{},
		"renderer_contract_version": cxrendercontract.WechatHTMLV1, "rules_version": markdownsyntax.RulesVersion,
	})
	if err != nil || paramsHash != first.ParamsHash {
		t.Fatalf("params hash mismatch: got %q, want %q, err=%v", paramsHash, first.ParamsHash, err)
	}

	status, reused := create([]string{"wechat_html", "wechat_html"}, "web")
	if status != 202 || reused.BuildID != first.BuildID || !reused.Reused || reused.ParamsHash != first.ParamsHash {
		t.Fatalf("normalized retry was not idempotent: status=%d first=%+v retry=%+v", status, first, reused)
	}
	var buildCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM work_build WHERE work_id=$1`, work.ID).Scan(&buildCount); err != nil {
		t.Fatal(err)
	}
	if buildCount != 1 {
		t.Fatalf("duplicate build rows = %d, want 1", buildCount)
	}
	var currentDetail struct {
		IsCurrent bool `json:"is_current"`
	}
	env.mustJSON(t, "GET", "/api/v1/builds/"+first.BuildID.String(), nil, &currentDetail)
	if !currentDetail.IsCurrent {
		t.Fatal("new build must be marked current")
	}

	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"title": "快照创建后改名", "base_revision": initialRevision,
	}, &work)
	if work.Revision == initialRevision {
		t.Fatal("work revision did not advance after edit")
	}
	var detail struct {
		IsCurrent bool `json:"is_current"`
	}
	env.mustJSON(t, "GET", "/api/v1/builds/"+first.BuildID.String(), nil, &detail)
	if detail.IsCurrent {
		t.Fatal("historical build must be marked non-current after source change")
	}
	status, body := env.do("POST", "/api/v1/builds/"+first.BuildID.String()+"/complete", cxBuildCompletionForTest(t, first.BuildID.String()))
	if status != 409 || !strings.Contains(string(body), `"build_stale"`) {
		t.Fatalf("stale build completion must be rejected: status=%d body=%s", status, body)
	}
	var state, errorCode string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code FROM work_build WHERE id=$1`, first.BuildID).Scan(&state, &errorCode); err != nil || state != "failed" || errorCode != "build_stale" {
		t.Fatalf("stale build was not retained as failed history: status=%q error=%q err=%v", state, errorCode, err)
	}
	_, cancelBuild := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	var firstCancel struct {
		Status string `json:"status"`
	}
	env.mustJSON(t, "POST", "/api/v1/builds/"+cancelBuild.BuildID.String()+"/cancel", map[string]any{}, &firstCancel)
	if firstCancel.Status != "failed" {
		t.Fatalf("first cancel response = %+v", firstCancel)
	}
	var cancelled struct {
		Status    string `json:"status"`
		ErrorCode string `json:"error_code"`
	}
	env.mustJSON(t, "POST", "/api/v1/builds/"+cancelBuild.BuildID.String()+"/cancel", map[string]any{}, &cancelled)
	if cancelled.Status != "failed" || cancelled.ErrorCode != "build_cancelled" {
		t.Fatalf("repeat cancel changed terminal state: %+v", cancelled)
	}

	env.expectErr(t, "POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": initialRevision, "targets": []string{"wechat_html"}, "options": map[string]any{}, "client": "desktop",
		"renderer_contract_version": cxrendercontract.WechatHTMLV1,
	}, "version_conflict")
}

func TestCX02BuildSyntaxPreflightAndCursor(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "构建语法预检"}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"viewpoint": "我会说明脚注在发布排版中的兼容性。", "base_revision": work.Revision,
	}, &work)
	var outline Work
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{
		"confirm": true, "base_revision": work.Revision,
		"items": []map[string]any{{"heading": "脚注", "key_point": "验证交付前扫描", "material_ids": []string{}}},
	}, &outline)
	section := outline.Sections[0]
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{
		"content_md": "脚注测试[^1]\n\n[^1]: 来源", "base_revision": section.Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"wechat_html"}, "options": map[string]any{}, "client": "desktop",
		"renderer_contract_version": cxrendercontract.WechatHTMLV1,
	})
	if status != 422 || !strings.Contains(string(body), `"render_unsupported_syntax"`) || !strings.Contains(string(body), `"footnote"`) {
		t.Fatalf("build must rerun syntax scan and block unsupported syntax: status=%d body=%s", status, body)
	}
	var count int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM work_build WHERE work_id=$1`, work.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("syntax-blocked build created %d rows", count)
	}
	section = work.Sections[0]
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{
		"content_md": "这是可排版的正文。", "base_revision": section.Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)

	_, first := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	_, second := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"stable_html"})
	var page struct {
		Items      []map[string]any `json:"items"`
		NextCursor *string          `json:"next_cursor"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String()+"/builds?limit=1", nil, &page)
	if len(page.Items) != 1 || page.NextCursor == nil {
		t.Fatalf("first build page = %+v", page)
	}
	var next struct {
		Items []map[string]any `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String()+"/builds?limit=1&cursor="+url.QueryEscape(*page.NextCursor), nil, &next)
	if len(next.Items) != 1 {
		t.Fatalf("second build page = %+v", next)
	}
	ids := map[string]bool{}
	for _, item := range append(page.Items, next.Items...) {
		ids[fmt.Sprint(item["id"])] = true
	}
	if !ids[first.BuildID.String()] || !ids[second.BuildID.String()] {
		t.Fatalf("cursor pages skipped or repeated a build: ids=%v first=%s second=%s", ids, first.BuildID, second.BuildID)
	}
	if _, err := url.ParseRequestURI("/api/v1/works/" + work.ID.String() + "/builds?cursor=not-a-cursor"); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "GET", "/api/v1/works/"+work.ID.String()+"/builds?cursor=not-a-cursor", nil, "validation_failed")
}

func TestCX02ConcurrentBuildCreateUsesOneIdempotencyRow(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "并发构建幂等"}, &work)
	input := map[string]any{
		"basis_revision": work.Revision, "targets": []string{"wechat_html"}, "options": map[string]any{}, "client": "desktop",
		"renderer_contract_version": cxrendercontract.WechatHTMLV1,
	}
	type result struct {
		status int
		body   []byte
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", input)
			results <- result{status: status, body: body}
		}()
	}
	close(start)
	var responses []cxBuildCreateResponse
	for i := 0; i < 2; i++ {
		result := <-results
		if result.status != 201 && result.status != 202 {
			t.Fatalf("concurrent create failed: status=%d body=%s", result.status, result.body)
		}
		var response cxBuildCreateResponse
		if err := json.Unmarshal(result.body, &response); err != nil {
			t.Fatalf("decode concurrent create: %v; body=%s", err, result.body)
		}
		responses = append(responses, response)
	}
	if responses[0].BuildID != responses[1].BuildID {
		t.Fatalf("concurrent idempotent requests returned different IDs: %s and %s", responses[0].BuildID, responses[1].BuildID)
	}
	var count int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM work_build WHERE work_id=$1`, work.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("concurrent idempotent requests created %d rows", count)
	}
}

func TestCX02BuildArtifactUploadIsPrivateIdempotentAndConflictFailsBuild(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "受控产物上传"}, &work)
	_, build := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	content := []byte("<!doctype html><html><body>固定快照</body></html>")
	status, body := cxBuildUploadForTest(t, build.BuildID.String(), "html", "article.html", content, "")
	if status != 200 {
		t.Fatalf("upload artifact: status=%d body=%s", status, body)
	}
	var uploaded struct {
		ArtifactID string `json:"artifact_id"`
		SHA256     string `json:"sha256"`
		Bytes      int    `json:"bytes"`
	}
	if err := json.Unmarshal(body, &uploaded); err != nil {
		t.Fatalf("decode artifact response: %v; body=%s", err, body)
	}
	if uploaded.Bytes != len(content) || uploaded.SHA256 == "" || uploaded.ArtifactID == "" {
		t.Fatalf("artifact metadata incomplete: %+v", uploaded)
	}
	var workspaceID uuid.UUID
	var storagePath string
	var artifactID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `SELECT a.workspace_id FROM work w JOIN platform_account a ON a.id=w.account_id WHERE w.id=$1`, work.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT id,storage_path FROM work_build_artifact WHERE build_id=$1`, build.BuildID).Scan(&artifactID, &storagePath); err != nil {
		t.Fatal(err)
	}
	if storagePath != cxBuildStoragePath(workspaceID, build.BuildID, artifactID) {
		t.Fatalf("artifact path is not server generated: %q", storagePath)
	}
	if _, err := os.Stat(filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storagePath))); err != nil {
		t.Fatalf("uploaded file missing: %v", err)
	}
	status, retryBody := cxBuildUploadForTest(t, build.BuildID.String(), "html", "article.html", content, "")
	var retry struct {
		ArtifactID string `json:"artifact_id"`
	}
	if status != 200 || json.Unmarshal(retryBody, &retry) != nil || retry.ArtifactID != uploaded.ArtifactID {
		t.Fatalf("same-name/same-bytes retry was not idempotent: status=%d body=%s", status, retryBody)
	}
	var artifactCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM work_build_artifact WHERE build_id=$1`, build.BuildID).Scan(&artifactCount); err != nil {
		t.Fatal(err)
	}
	if artifactCount != 1 {
		t.Fatalf("idempotent retry created %d artifact rows", artifactCount)
	}
	status, conflictBody := cxBuildUploadForTest(t, build.BuildID.String(), "html", "article.html", []byte("<html><body>变更</body></html>"), "")
	if status != 409 || !bytes.Contains(conflictBody, []byte(`"artifact_conflict"`)) {
		t.Fatalf("same-name/different-bytes upload must fail the build: status=%d body=%s", status, conflictBody)
	}
	var state, errorCode string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code FROM work_build WHERE id=$1`, build.BuildID).Scan(&state, &errorCode); err != nil {
		t.Fatal(err)
	}
	if state != "failed" || errorCode != "artifact_conflict" {
		t.Fatalf("conflict did not fail whole build: status=%s error=%s", state, errorCode)
	}
	var detail map[string]any
	env.mustJSON(t, "GET", "/api/v1/builds/"+build.BuildID.String(), nil, &detail)
	serialized, _ := json.Marshal(detail)
	if bytes.Contains(serialized, []byte("storage_path")) || bytes.Contains(serialized, []byte("builds/")) {
		t.Fatalf("build detail leaked local storage path: %s", serialized)
	}
}

func TestCX03CompleteChecksFrozenDOMAndKeepsPrivacyGateClosed(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "服务端完整性校验"}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"viewpoint": "仅验证固定稿件内容和服务端发布闸门。", "base_revision": work.Revision,
	}, &work)
	var outlined Work
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{
		"confirm": true, "base_revision": work.Revision,
		"items": []map[string]any{{"heading": "固定段落", "key_point": "只按当前来源验证", "material_ids": []string{}}},
	}, &outlined)
	section := outlined.Sections[0]
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{
		"content_md": "固定快照中的正文。", "base_revision": section.Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	_, build := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	validHTML := []byte(fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"></head><body><section><div data-section-id="%s"><h2>固定段落</h2><p>固定快照中的正文。</p></div></section></body></html>`, section.ID))
	if status, body := cxBuildUploadForTest(t, build.BuildID.String(), "html", "article.html", validHTML, ""); status != 200 {
		t.Fatalf("upload base html: status=%d body=%s", status, body)
	}
	status, body := env.do("POST", "/api/v1/builds/"+build.BuildID.String()+"/complete", cxBuildCompletionForTest(t, build.BuildID.String()))
	if status != 503 || !bytes.Contains(body, []byte(`"scanner_unverified"`)) || !bytes.Contains(body, []byte(`"Q-CX-03"`)) {
		t.Fatalf("valid HTML must reach the unresolved privacy policy gate: status=%d body=%s", status, body)
	}
	if bytes.Contains(body, []byte("固定快照中的正文")) {
		t.Fatalf("privacy response must not echo exported source text: %s", body)
	}
	var state, errorCode string
	var detail []byte
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code,error_detail FROM work_build WHERE id=$1`, build.BuildID).Scan(&state, &errorCode, &detail); err != nil {
		t.Fatal(err)
	}
	if state != "failed" || errorCode != "scanner_unverified" || !bytes.Contains(detail, []byte("cx-html-1")) {
		t.Fatalf("verified structural report must be retained without falsely building: status=%s error=%s detail=%s", state, errorCode, detail)
	}
	var buildDetail struct {
		Validation   json.RawMessage `json:"validation"`
		DownloadGate map[string]any  `json:"download_gate"`
	}
	env.mustJSON(t, "GET", "/api/v1/builds/"+build.BuildID.String(), nil, &buildDetail)
	if !bytes.Contains(buildDetail.Validation, []byte("report_hash")) || buildDetail.DownloadGate["reason"] != "build_not_complete" {
		t.Fatalf("build detail should expose the safe validation report and closed download state: %+v", buildDetail)
	}

	_, tampered := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	maliciousHTML := []byte(fmt.Sprintf(`<html><head><link rel="stylesheet" href="https://example.invalid/x.css"></head><body><section><div data-section-id="%s"><h2>固定段落</h2><script>wrong</script><p>固定快照中的正文。</p></div></section></body></html>`, section.ID))
	if status, body := cxBuildUploadForTest(t, tampered.BuildID.String(), "html", "article.html", maliciousHTML, ""); status != 200 {
		t.Fatalf("upload untrusted html for independent validation: status=%d body=%s", status, body)
	}
	status, body = env.do("POST", "/api/v1/builds/"+tampered.BuildID.String()+"/complete", cxBuildCompletionForTest(t, tampered.BuildID.String()))
	if status != 422 || !bytes.Contains(body, []byte(`"html_invalid"`)) {
		t.Fatalf("server did not reject unsafe DOM resources: status=%d body=%s", status, body)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code FROM work_build WHERE id=$1`, tampered.BuildID).Scan(&state, &errorCode); err != nil || state != "failed" || errorCode != "html_invalid" {
		t.Fatalf("unsafe artifact did not fail the build: status=%s error=%s err=%v", state, errorCode, err)
	}

	_, stableBuild := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"stable_html"})
	baseHTML := []byte(fmt.Sprintf(`<section><div data-section-id="%s"><h2>固定段落</h2><p>固定快照中的正文。</p></div></section>`, section.ID))
	stableHTML := []byte(fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"><title>服务端完整性校验</title></head><body><section><div data-section-id="%s"><h2>固定段落</h2><p>固定快照中的正文。</p></div></section></body></html>`, section.ID))
	if status, body := cxBuildUploadForTest(t, stableBuild.BuildID.String(), "html", "source.html", baseHTML, ""); status != 200 {
		t.Fatalf("upload stable source html: status=%d body=%s", status, body)
	}
	if status, body := cxBuildUploadForTest(t, stableBuild.BuildID.String(), "stable_html", "ignored-client-name.html", stableHTML, ""); status != 200 {
		t.Fatalf("upload stable output: status=%d body=%s", status, body)
	}
	var stableName string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT name FROM work_build_artifact WHERE build_id=$1 AND kind='stable_html'`, stableBuild.BuildID).Scan(&stableName); err != nil {
		t.Fatal(err)
	}
	if stableName != fmt.Sprintf("服务端完整性校验-r%d-stable.html", stableBuild.BasisRevision) {
		t.Fatalf("stable HTML name must be generated from frozen title and revision: %q", stableName)
	}
	status, body = env.do("POST", "/api/v1/builds/"+stableBuild.BuildID.String()+"/complete", cxBuildCompletionForTest(t, stableBuild.BuildID.String()))
	if status != 503 || !bytes.Contains(body, []byte(`"scanner_unverified"`)) {
		t.Fatalf("stable HTML should pass DOM/source checks then stop at unresolved privacy policy: status=%d body=%s", status, body)
	}
}

func TestCX03StableFilenameIsServerSafeAndBounded(t *testing.T) {
	if got := cxBuildStableArtifactName("CON", 9); got != "work-CON-r9-stable.html" {
		t.Fatalf("reserved title did not get a safe file name: %q", got)
	}
	long := strings.Repeat("稿", 120)
	got := cxBuildStableArtifactName(long, 3)
	if strings.ContainsAny(got, `/\\:*?"<>|`) || len([]rune(strings.Split(got, "-r3-stable.html")[0])) != 80 || !strings.HasSuffix(got, "-r3-stable.html") {
		t.Fatalf("generated file name is unsafe or title was not capped at 80 code points: %q", got)
	}
	if got := cxBuildStableArtifactName("a/b\\c", 1); strings.Contains(got, "/") || strings.Contains(got, "\\") {
		t.Fatalf("path separators survived generated filename: %q", got)
	}
}

func TestCX02BuiltArtifactReuseRehashesStoredBytes(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "归档产物复用"}, &work)
	_, original := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	content := []byte("<html><body>same length</body></html>")
	if status, body := cxBuildUploadForTest(t, original.BuildID.String(), "html", "archive.html", content, ""); status != 200 {
		t.Fatalf("upload artifact: status=%d body=%s", status, body)
	}
	var artifactID uuid.UUID
	var storagePath string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT id,storage_path FROM work_build_artifact WHERE build_id=$1`, original.BuildID).Scan(&artifactID, &storagePath); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work_build SET status='built',manifest='{}',manifest_sha256=repeat('0',64),finished_at=now(),expires_at=now()+interval '180 days' WHERE id=$1`, original.BuildID); err != nil {
		t.Fatal(err)
	}
	downloadStatus, downloadBody := env.do("GET", "/api/v1/builds/"+original.BuildID.String()+"/artifacts/"+artifactID.String(), nil)
	if downloadStatus != 409 || !bytes.Contains(downloadBody, []byte(`"manifest_invalid"`)) {
		t.Fatalf("direct artifact route must enforce the manifest gate: status=%d body=%s", downloadStatus, downloadBody)
	}
	corrupted := bytes.Replace(content, []byte("same"), []byte("evil"), 1)
	if err := os.WriteFile(filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storagePath)), corrupted, 0o600); err != nil {
		t.Fatal(err)
	}
	_, replacement := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	if replacement.BuildID == original.BuildID || replacement.Reused {
		t.Fatalf("corrupted built file was reused: original=%s replacement=%+v", original.BuildID, replacement)
	}
	var status string
	var reusable bool
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,reusable FROM work_build WHERE id=$1`, original.BuildID).Scan(&status, &reusable); err != nil {
		t.Fatal(err)
	}
	if status != "built" || reusable {
		t.Fatalf("broken historical build should stay built but leave reusable index: status=%s reusable=%v", status, reusable)
	}
}

func TestCX02ArtifactUploadChecksHashAndDeadline(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "上传校验"}, &work)
	_, build := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	status, body := cxBuildUploadForTest(t, build.BuildID.String(), "html", "wrong.html", []byte("<html></html>"), strings.Repeat("0", 64))
	if status != 422 || !bytes.Contains(body, []byte(`"artifact_hash_mismatch"`)) {
		t.Fatalf("forged artifact hash was not rejected: status=%d body=%s", status, body)
	}
	var artifactCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM work_build_artifact WHERE build_id=$1`, build.BuildID).Scan(&artifactCount); err != nil || artifactCount != 0 {
		t.Fatalf("hash mismatch persisted artifact: count=%d err=%v", artifactCount, err)
	}
	var state, errorCode string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code FROM work_build WHERE id=$1`, build.BuildID).Scan(&state, &errorCode); err != nil || state != "failed" || errorCode != "artifact_hash_mismatch" {
		t.Fatalf("hash mismatch did not fail build: status=%s error=%s err=%v", state, errorCode, err)
	}
	_, expiredBuild := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"stable_html"})
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work_build SET created_at=now()-interval '2 hours',deadline_at=now()-interval '1 hour' WHERE id=$1`, expiredBuild.BuildID); err != nil {
		t.Fatal(err)
	}
	status, body = cxBuildUploadForTest(t, expiredBuild.BuildID.String(), "stable_html", "late.html", []byte("<html></html>"), "")
	if status != 409 || !bytes.Contains(body, []byte(`"build_not_running"`)) {
		t.Fatalf("expired build accepted upload: status=%d body=%s", status, body)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code FROM work_build WHERE id=$1`, expiredBuild.BuildID).Scan(&state, &errorCode); err != nil || state != "failed" || errorCode != "build_timeout" {
		t.Fatalf("expired build state = %s/%s, err=%v", state, errorCode, err)
	}
}

func TestCX02BuildCleanupRetainsFailedHistoryAndTimesOutRunningBuilds(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "产物清理"}, &work)
	_, failedBuild := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	if status, body := cxBuildUploadForTest(t, failedBuild.BuildID.String(), "html", "cleanup.html", []byte("<html>staging</html>"), ""); status != 200 {
		t.Fatalf("upload staged artifact: status=%d body=%s", status, body)
	}
	var storagePath string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT storage_path FROM work_build_artifact WHERE build_id=$1`, failedBuild.BuildID).Scan(&storagePath); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work_build SET status='failed',reusable=false,error_code='build_cancelled',finished_at=now()-interval '25 hours' WHERE id=$1`, failedBuild.BuildID); err != nil {
		t.Fatal(err)
	}
	n, err := env.srv.cleanupCXBuilds(context.Background())
	if err != nil || n != 1 {
		t.Fatalf("cleanup expired failed build: count=%d err=%v", n, err)
	}
	if _, err := os.Stat(filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storagePath))); !os.IsNotExist(err) {
		t.Fatalf("staged file still exists after cleanup: err=%v", err)
	}
	var artifactCount int
	var status, cleanupState string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM work_build_artifact WHERE build_id=$1`, failedBuild.BuildID).Scan(&artifactCount); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,cleanup_state FROM work_build WHERE id=$1`, failedBuild.BuildID).Scan(&status, &cleanupState); err != nil {
		t.Fatal(err)
	}
	if artifactCount != 0 || status != "failed" || cleanupState != "done" {
		t.Fatalf("cleanup should keep failed build history but remove file indexes: artifacts=%d status=%s cleanup=%s", artifactCount, status, cleanupState)
	}
	_, running := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"stable_html"})
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work_build SET created_at=now()-interval '2 hours',deadline_at=now()-interval '1 hour' WHERE id=$1`, running.BuildID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.cleanupCXBuilds(context.Background()); err != nil {
		t.Fatal(err)
	}
	var timeoutCode string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code,cleanup_state FROM work_build WHERE id=$1`, running.BuildID).Scan(&status, &timeoutCode, &cleanupState); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || timeoutCode != "build_timeout" || cleanupState != "active" {
		t.Fatalf("timed-out build was not failed and retained for 24h: %s/%s/%s", status, timeoutCode, cleanupState)
	}
}

func TestCX02HardWorkPurgeRemovesBuildFilesBeforeRows(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "作品删除清理"}, &work)
	_, build := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	if status, body := cxBuildUploadForTest(t, build.BuildID.String(), "html", "purge.html", []byte("<html>purge</html>"), ""); status != 200 {
		t.Fatalf("upload purge artifact: status=%d body=%s", status, body)
	}
	var storagePath string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT storage_path FROM work_build_artifact WHERE build_id=$1`, build.BuildID).Scan(&storagePath); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work SET deleted_at=now() WHERE id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.purge(context.Background(), "work", work.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storagePath))); !os.IsNotExist(err) {
		t.Fatalf("purged work artifact still exists: err=%v", err)
	}
	var count int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM work_build WHERE id=$1`, build.BuildID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("hard purging work retained %d build rows", count)
	}
}

func cxBuildUploadForTest(t *testing.T, buildID, kind, name string, data []byte, claimedHash string) (int, []byte) {
	t.Helper()
	var body bytes.Buffer
	multipartWriter := multipart.NewWriter(&body)
	_ = multipartWriter.WriteField("kind", kind)
	if claimedHash != "" {
		_ = multipartWriter.WriteField("sha256", claimedHash)
	}
	file, err := multipartWriter.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := multipartWriter.Close(); err != nil {
		t.Fatal(err)
	}
	response := env.request("POST", "/api/v1/builds/"+buildID+"/artifacts", &body, multipartWriter.FormDataContentType())
	defer response.Body.Close()
	result, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, result
}

func cxBuildCompletionForTest(t *testing.T, buildID string) map[string]any {
	t.Helper()
	tx, err := env.srv.db.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	var sourceHash, paramsHash string
	var targets []string
	if err := tx.QueryRow(t.Context(), `SELECT source_hash,params_hash,targets FROM work_build WHERE id=$1`, buildID).Scan(&sourceHash, &paramsHash, &targets); err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Query(t.Context(), `SELECT id,kind,name FROM work_build_artifact WHERE build_id=$1 ORDER BY kind,name,id`, buildID)
	if err != nil {
		t.Fatal(err)
	}
	byKind := map[string]map[string]any{}
	for rows.Next() {
		var id, kind, name string
		if err := rows.Scan(&id, &kind, &name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		byKind[kind] = map[string]any{"artifact_id": id, "kind": kind, "name": name}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	outputKind := map[string]string{"wechat_html": "html", "stable_html": "stable_html", "long_image": "png", "xhs_cards": "zip"}
	artifacts := []map[string]any{}
	for _, target := range targets {
		if artifact := byKind[outputKind[target]]; artifact != nil {
			artifacts = append(artifacts, artifact)
		}
	}
	return map[string]any{
		"source_hash": sourceHash, "params_hash": paramsHash, "artifacts": artifacts,
		"renderer_receipt": map[string]any{"client": "desktop", "application_version": "test", "renderer_contract_version": cxrendercontract.WechatHTMLV1,
			"chromium_version": "test", "font_family": "test-font", "device_scale_factor": 1, "viewport_width": 1280, "viewport_height": 800},
	}
}

func cxBuildCreateForTest(t *testing.T, workID string, revision int, targets []string) (int, cxBuildCreateResponse) {
	t.Helper()
	var response cxBuildCreateResponse
	status, body := env.do("POST", "/api/v1/works/"+workID+"/builds", map[string]any{
		"basis_revision": revision, "targets": targets, "options": map[string]any{}, "client": "desktop",
		"renderer_contract_version": cxrendercontract.WechatHTMLV1,
	})
	if status != 201 {
		t.Fatalf("create build: status=%d body=%s", status, body)
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode build response: %v; body=%s", err, body)
	}
	return status, response
}
