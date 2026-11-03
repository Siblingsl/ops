package app

import (
	"bytes"
	"encoding/json"
	"testing"
)

// DEV-CX10：cover_images 构建（24 §5.2 FR-CX-09）。
// 预设以平台+像素标识，两种 1:1 各自独立；沿用原图与 cover_crops，不建派生 asset。
// Q-CX-03/04 未决：complete 仍停在 scanner_unverified，built 与下载不开放。

func cxTestCreateCoverBuild(t *testing.T, work Work, presets []string) cxBuildCreateResponse {
	t.Helper()
	var created cxBuildCreateResponse
	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"cover_images"},
		"options": map[string]any{"presets": presets},
		"client":  "web", "renderer_contract_version": cxCoverTemplateVersion,
	})
	if status != 201 {
		t.Fatalf("create cover build: status=%d body=%s", status, body)
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("decode build: %v body=%s", err, body)
	}
	return created
}

func cxTestCompleteCoverBuild(t *testing.T, buildID, artifactID, artifactName, sourceHash, paramsHash string) (int, []byte) {
	t.Helper()
	return env.do("POST", "/api/v1/builds/"+buildID+"/complete", map[string]any{
		"source_hash": sourceHash, "params_hash": paramsHash,
		"artifacts": []map[string]any{{"artifact_id": artifactID, "kind": "zip", "name": artifactName}},
		"renderer_receipt": map[string]any{"client": "web", "application_version": "test", "renderer_contract_version": cxCoverTemplateVersion,
			"chromium_version": "test", "font_family": "test-font", "device_scale_factor": 1, "viewport_width": 1280, "viewport_height": 800},
	})
}

// cxTestCoverWork 上传封面并保存 2.35:1 与 1:1 的裁剪，返回带封面的作品。
func cxTestCoverWork(t *testing.T, account Account, title string) Work {
	t.Helper()
	work := env.draftedWork(t, account, title)
	env.upload(t, work.ID.String(), testPNG(1600, 1200))
	// 上传会推进作品修订，CAS 前必须重取当前版本。
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"cover_asset_id": work.Assets[0].ID, "cover_crops": map[string]cropBox{
			"2.35_1": {X1: 0, Y1: 0.1, X2: 1, Y2: 0.6},
			"1_1":    {X1: 0.2, Y1: 0, X2: 0.8, Y2: 1},
		},
		"base_revision": work.Revision,
	}, &work)
	return work
}

func TestCX10CoverBuildPresetsPixelsAndPrivacyGate(t *testing.T) {
	account := env.accounts(t).wechat
	work := cxTestCoverWork(t, account, "封面比例矩阵验收")
	created := cxTestCreateCoverBuild(t, work, []string{"wechat_235", "wechat_square"})

	// 冻结快照必须带上封面与裁剪，渲染才可复现。
	var snapshot struct {
		Work struct {
			CoverAssetID string         `json:"cover_asset_id"`
			CoverCrops   map[string]any `json:"cover_crops"`
		} `json:"work"`
	}
	if err := json.Unmarshal(created.SourceSnapshot, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Work.CoverAssetID == "" || snapshot.Work.CoverCrops["2.35_1"] == nil || snapshot.Work.CoverCrops["1_1"] == nil {
		t.Fatalf("cover snapshot incomplete: %+v", snapshot.Work)
	}
	var detail map[string]any
	env.mustJSON(t, "GET", "/api/v1/builds/"+created.BuildID.String(), nil, &detail)
	if current, _ := detail["is_current"].(bool); !current {
		t.Fatal("a fresh cover build must be current")
	}

	// 两种 1:1 不共用文件名：条目名带平台与像素，顺序固定为设计顺序。
	names := []string{"cover-wechat_235-900x383.png", "cover-wechat_square-383x383.png"}
	payload := cxTestCardsZIP(t, names, [][]byte{cxTestCardsPNG(t, 900, 383), cxTestCardsPNG(t, 383, 383)})
	if status, body := cxBuildUploadForTest(t, created.BuildID.String(), "zip", "covers.zip", payload, ""); status != 200 {
		t.Fatalf("upload cover zip: status=%d body=%s", status, body)
	}
	artifactID, artifactName := cxTestBuildArtifact(t, created.BuildID.String())
	status, body := cxTestCompleteCoverBuild(t, created.BuildID.String(), artifactID, artifactName, created.SourceHash, created.ParamsHash)
	if status != 503 || !bytes.Contains(body, []byte("scanner_unverified")) {
		t.Fatalf("complete must stay blocked by privacy policy: status=%d body=%s", status, body)
	}
	var buildStatus, errorCode string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code FROM work_build WHERE id=$1`, created.BuildID).Scan(&buildStatus, &errorCode); err != nil || buildStatus != "failed" || errorCode != "scanner_unverified" {
		t.Fatalf("cover build must not reach built: status=%s code=%s err=%v", buildStatus, errorCode, err)
	}
	env.mustJSON(t, "GET", "/api/v1/builds/"+created.BuildID.String(), nil, &detail)
	validation, _ := detail["validation"].(map[string]any)
	covers, _ := validation["covers"].(map[string]any)
	if covers == nil {
		t.Fatalf("complete must record per-preset validation: %+v", validation)
	}
	entries, _ := covers["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("expected 2 cover entries: %+v", covers)
	}
	want := []struct {
		name           string
		width, height  int
	}{{"cover-wechat_235-900x383.png", 900, 383}, {"cover-wechat_square-383x383.png", 383, 383}}
	for index, item := range want {
		entry, _ := entries[index].(map[string]any)
		if entry["name"] != item.name || int(entry["width"].(float64)) != item.width || int(entry["height"].(float64)) != item.height {
			t.Fatalf("entry %d mismatch: %+v want %+v", index, entry, item)
		}
	}
	gate, _ := detail["download_gate"].(map[string]any)
	if allowed, _ := gate["allowed"].(bool); allowed {
		t.Fatalf("download gate must stay closed: %+v", gate)
	}

	// 像素与预设不一致：complete 拒绝并失败整个构建（任何输出失败全组不可下载）。
	second := cxTestCreateCoverBuild(t, work, []string{"wechat_235", "wechat_square"})
	badZIP := cxTestCardsZIP(t, names, [][]byte{cxTestCardsPNG(t, 900, 384), cxTestCardsPNG(t, 383, 383)})
	if status, body := cxBuildUploadForTest(t, second.BuildID.String(), "zip", "covers.zip", badZIP, ""); status != 200 {
		t.Fatalf("upload bad pixel zip: status=%d body=%s", status, body)
	}
	badID, badName := cxTestBuildArtifact(t, second.BuildID.String())
	if status, body := cxTestCompleteCoverBuild(t, second.BuildID.String(), badID, badName, second.SourceHash, second.ParamsHash); status != 422 || !bytes.Contains(body, []byte("cover_image_invalid")) {
		t.Fatalf("bad pixels must be rejected: status=%d body=%s", status, body)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT error_code FROM work_build WHERE id=$1`, second.BuildID).Scan(&errorCode); err != nil || errorCode != "cover_image_invalid" {
		t.Fatalf("bad pixel build must fail: code=%s err=%v", errorCode, err)
	}

	// 构建结果未确认入库：asset 行数与作品形态都不变。
	var count int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM asset WHERE work_id=$1`, work.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("cover build must not create derived assets: count=%d err=%v", count, err)
	}
	var workFormat string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT content_format FROM work WHERE id=$1`, work.ID).Scan(&workFormat); err != nil || workFormat != work.ContentFormat {
		t.Fatalf("cover build must not change content_format: %s/%s err=%v", workFormat, work.ContentFormat, err)
	}
}

func TestCX10CoverBuildRejectsInvalidPresetsAndMissingCover(t *testing.T) {
	account := env.accounts(t).wechat
	work := env.draftedWork(t, account, "封面构建拒绝验收")
	create := func(presets []string, options map[string]any, contract string) (int, []byte) {
		if options == nil {
			options = map[string]any{"presets": presets}
		}
		if contract == "" {
			contract = cxCoverTemplateVersion
		}
		return env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
			"basis_revision": work.Revision, "targets": []string{"cover_images"},
			"options": options, "client": "web", "renderer_contract_version": contract,
		})
	}

	// 未选封面：cover_missing。
	status, body := create([]string{"wechat_235", "wechat_square"}, nil, "")
	if status != 422 || !bytes.Contains(body, []byte("cover_missing")) {
		t.Fatalf("missing cover: status=%d body=%s", status, body)
	}

	// 选了封面但预设跨平台：invalid_ratio。
	withCover := cxTestCoverWork(t, account, "封面预设平台校验")
	status, body = env.do("POST", "/api/v1/works/"+withCover.ID.String()+"/builds", map[string]any{
		"basis_revision": withCover.Revision, "targets": []string{"cover_images"},
		"options": map[string]any{"presets": []string{"wechat_235", "xhs_34"}},
		"client":  "web", "renderer_contract_version": cxCoverTemplateVersion,
	})
	if status != 422 || !bytes.Contains(body, []byte("invalid_ratio")) {
		t.Fatalf("cross-platform preset: status=%d body=%s", status, body)
	}

	// 未知预设与重复预设：invalid_ratio 落到 presets 字段。
	status, body = create([]string{"wechat_169"}, nil, "")
	if status != 422 || !bytes.Contains(body, []byte("invalid_ratio")) {
		t.Fatalf("unknown preset: status=%d body=%s", status, body)
	}
	status, body = create([]string{"wechat_235", "wechat_235"}, nil, "")
	if status != 422 || !bytes.Contains(body, []byte("invalid_ratio")) {
		t.Fatalf("duplicate preset: status=%d body=%s", status, body)
	}

	// options 未提交或带未登记字段：拒绝。
	status, body = create(nil, map[string]any{}, "")
	if status != 422 || !bytes.Contains(body, []byte("options")) {
		t.Fatalf("missing options: status=%d body=%s", status, body)
	}
	status, body = create(nil, map[string]any{"presets": []string{"wechat_235"}, "ratio": "1:1"}, "")
	if status != 422 || !bytes.Contains(body, []byte("options")) {
		t.Fatalf("unregistered option field: status=%d body=%s", status, body)
	}

	// 封面不能与其他产物目标混合。
	status, body = env.do("POST", "/api/v1/works/"+withCover.ID.String()+"/builds", map[string]any{
		"basis_revision": withCover.Revision, "targets": []string{"cover_images", "wechat_html"},
		"options": map[string]any{"presets": []string{"wechat_235"}},
		"client":  "web", "renderer_contract_version": cxCoverTemplateVersion,
	})
	if status != 422 || !bytes.Contains(body, []byte("封面构建不能与其他产物目标混合")) {
		t.Fatalf("mixed targets: status=%d body=%s", status, body)
	}

	// 契约版本必须与服务端登记一致。
	status, body = create(nil, map[string]any{"presets": []string{"wechat_235"}}, "ops.cover-images/v0")
	if status != 409 || !bytes.Contains(body, []byte("renderer_version_mismatch")) {
		t.Fatalf("unregistered cover contract: status=%d body=%s", status, body)
	}

	// 预设顺序不影响 params_hash：canonical 顺序由服务端固定，同输入直接复用运行中的构建。
	first := cxTestCreateCoverBuild(t, withCover, []string{"wechat_235", "wechat_square"})
	var reversed cxBuildCreateResponse
	status, body = env.do("POST", "/api/v1/works/"+withCover.ID.String()+"/builds", map[string]any{
		"basis_revision": withCover.Revision, "targets": []string{"cover_images"},
		"options": map[string]any{"presets": []string{"wechat_square", "wechat_235"}},
		"client":  "web", "renderer_contract_version": cxCoverTemplateVersion,
	})
	if status != 202 {
		t.Fatalf("reversed presets must reuse the running build: status=%d body=%s", status, body)
	}
	if err := json.Unmarshal(body, &reversed); err != nil {
		t.Fatal(err)
	}
	if reversed.BuildID != first.BuildID || reversed.ParamsHash != first.ParamsHash || !reversed.Reused {
		t.Fatalf("preset order must not change params hash: first=%+v reversed=%+v", first, reversed)
	}

	// 小红书作品使用自己的三个预设（含 1080×1080 的 1:1）。
	xhsAccount := env.accounts(t).xhs
	xhsWork := cxTestCoverWork(t, xhsAccount, "小红书封面预设验收")
	created := cxTestCreateCoverBuild(t, xhsWork, []string{"xhs_916", "xhs_34", "xhs_square"})
	names := []string{"cover-xhs_34-1080x1440.png", "cover-xhs_square-1080x1080.png", "cover-xhs_916-1080x1920.png"}
	payload := cxTestCardsZIP(t, names, [][]byte{cxTestCardsPNG(t, 1080, 1440), cxTestCardsPNG(t, 1080, 1080), cxTestCardsPNG(t, 1080, 1920)})
	if status, body := cxBuildUploadForTest(t, created.BuildID.String(), "zip", "covers.zip", payload, ""); status != 200 {
		t.Fatalf("upload xhs covers: status=%d body=%s", status, body)
	}
	artifactID, artifactName := cxTestBuildArtifact(t, created.BuildID.String())
	if status, body := cxTestCompleteCoverBuild(t, created.BuildID.String(), artifactID, artifactName, created.SourceHash, created.ParamsHash); status != 503 || !bytes.Contains(body, []byte("scanner_unverified")) {
		t.Fatalf("xhs cover complete: status=%d body=%s", status, body)
	}
	var detail map[string]any
	env.mustJSON(t, "GET", "/api/v1/builds/"+created.BuildID.String(), nil, &detail)
	validation, _ := detail["validation"].(map[string]any)
	covers, _ := validation["covers"].(map[string]any)
	entries, _ := covers["entries"].([]any)
	if len(entries) != 3 {
		t.Fatalf("expected 3 xhs cover entries: %+v", covers)
	}
	if entries[0].(map[string]any)["name"] != "cover-xhs_34-1080x1440.png" || entries[2].(map[string]any)["name"] != "cover-xhs_916-1080x1920.png" {
		t.Fatalf("entries must follow canonical preset order: %+v", entries)
	}
}
