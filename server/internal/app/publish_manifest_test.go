package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ops/internal/cxcanonicaljson"
)

func publishTestPayload(platform string) PublishManifestPayload {
	cover := uuid.New()
	title := "测试发布标题"
	tags := []string{"测试", "发布"}
	if platform == "xhs" {
		tags = []string{"测试"}
	}
	if platform == "toutiao" {
		tags = []string{}
	}
	return PublishManifestPayload{
		SchemaVersion: 1,
		Platform:      platform,
		Fields: PublishManifestFields{
			Title:        title,
			BodyMD:       "这是发布正文，用于校验标题、正文、标签和封面。",
			BodyText:     "这是发布正文，用于校验标题、正文、标签和封面。",
			Tags:         tags,
			CoverAssetID: &cover,
			PlatformFields: map[string]any{
				"summary": "测试摘要",
			},
			ScheduleAt: nil,
			SkipReason: "",
		},
		Assets: []PublishManifestAsset{{
			AssetID: cover, Role: "cover", SHA256: strings.Repeat("a", 64), Width: 900, Height: 1200,
		}},
		Source: PublishManifestSource{WorkRevision: 1, PublishRevision: 1, AccountProfileRevision: 0},
	}
}

func publishCodes(validation PublishValidation, code string, ok bool) []PublishCheck {
	out := []PublishCheck{}
	for _, check := range validation.Checks {
		if check.Code == code && check.OK == ok {
			out = append(out, check)
		}
	}
	return out
}

func TestP1PlatformRulesAreIndependent(t *testing.T) {
	for _, platform := range []string{"wechat_mp", "xhs", "toutiao"} {
		payload := publishTestPayload(platform)
		validation := validatePublishManifest(platform, payload, publishValidationContext{Options: publishValidationOptions{Now: time.Now()}})
		if state := publishValidationState(validation); state != "valid" {
			t.Fatalf("%s valid payload => %s, checks=%+v", platform, state, validation.Checks)
		}
	}

	cases := []struct {
		name      string
		platform  string
		mutate    func(*PublishManifestPayload)
		opts      publishValidationOptions
		wantCode  string
		wantField string
	}{
		{"wechat title too long", "wechat_mp", func(p *PublishManifestPayload) { p.Fields.Title = strings.Repeat("长", 65) }, publishValidationOptions{}, "length", "title"},
		{"xhs title too long", "xhs", func(p *PublishManifestPayload) { p.Fields.Title = strings.Repeat("长", 21) }, publishValidationOptions{}, "length", "title"},
		{"toutiao title too long", "toutiao", func(p *PublishManifestPayload) { p.Fields.Title = strings.Repeat("长", 31) }, publishValidationOptions{}, "length", "title"},
		{"xhs body too long", "xhs", func(p *PublishManifestPayload) { p.Fields.BodyText = strings.Repeat("文", 1001) }, publishValidationOptions{}, "length", "body_text"},
		{"xhs no tags", "xhs", func(p *PublishManifestPayload) { p.Fields.Tags = nil }, publishValidationOptions{}, "tag_count", "tags"},
		{"xhs too many tags", "xhs", func(p *PublishManifestPayload) {
			p.Fields.Tags = []string{"一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一"}
		}, publishValidationOptions{}, "tag_count", "tags"},
		{"toutiao too many tags", "toutiao", func(p *PublishManifestPayload) {
			p.Fields.Tags = []string{"一", "二", "三", "四", "五", "六"}
		}, publishValidationOptions{}, "tag_count", "tags"},
		{"wechat too many tags", "wechat_mp", func(p *PublishManifestPayload) {
			p.Fields.Tags = []string{"一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一"}
		}, publishValidationOptions{}, "tag_count", "tags"},
		{"wechat summary too long", "wechat_mp", func(p *PublishManifestPayload) {
			p.Fields.PlatformFields["summary"] = strings.Repeat("摘", 121)
		}, publishValidationOptions{}, "length", "platform_fields.summary"},
		{"missing cover", "wechat_mp", func(p *PublishManifestPayload) { p.Fields.CoverAssetID = nil; p.Assets = nil }, publishValidationOptions{}, "required", "cover_asset_id"},
		{"xhs cover ratio", "xhs", func(p *PublishManifestPayload) { p.Assets[0].Width = 900; p.Assets[0].Height = 500 }, publishValidationOptions{}, "cover_ratio", "cover_asset_id"},
		{"toutiao cover ratio", "toutiao", func(p *PublishManifestPayload) { p.Assets[0].Width = 1200; p.Assets[0].Height = 1200 }, publishValidationOptions{}, "cover_ratio", "cover_asset_id"},
		{"banned word", "wechat_mp", func(p *PublishManifestPayload) { p.Fields.Title = "包含违规词" }, publishValidationOptions{}, "banned_word", "title/body_text"},
		{"xhs contact", "xhs", func(p *PublishManifestPayload) { p.Fields.BodyText = "想合作加微信 abc123" }, publishValidationOptions{}, "banned_word", "body_text"},
		{"xhs qr code", "xhs", func(p *PublishManifestPayload) { p.Fields.BodyText = "文末扫码进群" }, publishValidationOptions{}, "banned_word", "body_text"},
		{"xhs external link", "xhs", func(p *PublishManifestPayload) { p.Fields.BodyText = "详见 https://evil.example/x" }, publishValidationOptions{}, "banned_word", "body_text"},
		{"schedule past", "xhs", func(p *PublishManifestPayload) {
			past := time.Now().Add(-time.Hour)
			p.Fields.ScheduleAt = &past
		}, publishValidationOptions{}, "schedule_past", "schedule_at"},
		{"skip without reason", "toutiao", func(p *PublishManifestPayload) { p.Fields.SkipReason = "" }, publishValidationOptions{SkipRequested: true}, "skip_reason_required", "skip_reason"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := publishTestPayload(tc.platform)
			tc.mutate(&payload)
			ctx := publishValidationContext{BannedWords: []string{"违规词"}, Options: tc.opts}
			validation := validatePublishManifest(tc.platform, payload, ctx)
			if state := publishValidationState(validation); state != "invalid" {
				t.Fatalf("want invalid, got %s checks=%+v", state, validation.Checks)
			}
			found := false
			for _, check := range validation.Checks {
				if check.Code == tc.wantCode && check.Field == tc.wantField && check.Severity == "block" && !check.OK {
					found = true
				}
			}
			if !found {
				t.Fatalf("missing block %s/%s checks=%+v", tc.wantCode, tc.wantField, validation.Checks)
			}
		})
	}
}

func TestP1ContentHashStableAndChanges(t *testing.T) {
	payload := publishTestPayload("wechat_mp")
	first, err := cxcanonicaljson.Hash(payload)
	if err != nil {
		t.Fatal(err)
	}
	second, err := cxcanonicaljson.Hash(payload)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || len(first) != 64 {
		t.Fatalf("hash not stable: %q %q", first, second)
	}
	payload.Fields.Title = "改过的标题"
	changed, err := cxcanonicaljson.Hash(payload)
	if err != nil {
		t.Fatal(err)
	}
	if changed == first || len(changed) != 64 {
		t.Fatalf("hash did not change: %q %q", first, changed)
	}
}

func publishTestWork(t *testing.T, a Account, title string, coverW, coverH int, tags []string) Work {
	t.Helper()
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": title}, &wk)
	asset := env.upload(t, wk.ID.String(), testPNG(coverW, coverH))
	patch := map[string]any{"title": title, "cover_asset_id": asset.ID, "tags": tags}
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), patch, nil)
	ctx := context.Background()
	_, err := env.srv.db.Exec(ctx, `INSERT INTO work_section (work_id, position, heading, content_md, origin)
		VALUES ($1,0,'正文',$2,'human')`, wk.ID, "这是发布正文，包含足够的内容用于 manifest 校验。")
	if err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	return wk
}

func publishBuild(t *testing.T, workID, platform string) PublishManifest {
	t.Helper()
	var m PublishManifest
	env.mustJSON(t, "POST", "/api/v1/works/"+workID+"/publish-manifests/"+platform, nil, &m)
	return m
}

func expectStatusErr(t *testing.T, method, path string, in any, status int, code string) apiError {
	t.Helper()
	st, body := env.do(method, path, in)
	var ae apiError
	_ = json.Unmarshal(body, &ae)
	if st != status || ae.Error.Code != code {
		t.Fatalf("%s %s: want %d/%s, got %d %s", method, path, status, code, st, body)
	}
	return ae
}

func TestP1BuildListGetValidateAndPatch(t *testing.T) {
	a := env.accounts(t).xhs
	wk := publishTestWork(t, a, "小红书发布测试", 900, 1200, []string{"测试"})
	manifest := publishBuild(t, wk.ID.String(), "xhs")
	if manifest.ValidationState != "valid" || manifest.Revision != 1 || len(manifest.ContentHash) != 64 {
		t.Fatalf("build manifest: %+v", manifest)
	}

	var list []PublishManifest
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String()+"/publish-manifests", nil, &list)
	if len(list) != 1 || list[0].Platform != "xhs" || list[0].ValidationState != "valid" {
		t.Fatalf("list manifests: %+v", list)
	}

	// 同输入重建：hash 稳定，revision 递增，旧行进入 history。
	second := publishBuild(t, wk.ID.String(), "xhs")
	if second.ContentHash != manifest.ContentHash || second.Revision != 2 {
		t.Fatalf("rebuild hash/revision: %s/%d vs %s/%d", manifest.ContentHash, manifest.Revision, second.ContentHash, second.Revision)
	}
	var historyCount int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM publish_manifest_revision WHERE manifest_id=$1`, second.ID).Scan(&historyCount); err != nil {
		t.Fatal(err)
	}
	if historyCount != 1 {
		t.Fatalf("want 1 history row after one rebuild, got %d", historyCount)
	}

	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/xhs/validate", nil, &manifest)
	if manifest.ValidationState != "valid" {
		t.Fatalf("validate: %+v", manifest)
	}

	// PATCH 只改平台扩展字段/定时；内容字段必须 422。
	expectStatusErr(t, "PATCH", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/xhs",
		map[string]any{"title": "不能这样改"}, http.StatusUnprocessableEntity, "publish_manifest_content_readonly")
	schedule := time.Now().Add(2 * time.Hour).Format(time.RFC3339)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/xhs",
		map[string]any{"platform_fields": map[string]any{"note_type": "image"}, "schedule_at": schedule}, &manifest)
	if manifest.Revision != 3 || manifest.Payload.Fields.ScheduleAt == nil {
		t.Fatalf("patch manifest: %+v", manifest)
	}
}

func TestP1StaleBlocksTaskCreate(t *testing.T) {
	a := env.accounts(t).xhs
	wk := publishTestWork(t, a, "过期测试作品", 900, 1200, []string{"测试"})
	publishBuild(t, wk.ID.String(), "xhs")

	// 改稿只 bump work.revision；manifest 不重建，读取时必须 stale。
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]any{"title": "改稿后的标题"}, nil)
	var m PublishManifest
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/xhs", nil, &m)
	if m.ValidationState != "stale" {
		t.Fatalf("want stale, got %s", m.ValidationState)
	}
	expectStatusErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/publish-tasks",
		map[string]any{"platforms": []string{"xhs"}, "mode": "desktop"}, http.StatusConflict, "publish_manifest_stale")

	var taskCount int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM publish_task WHERE work_id=$1`, wk.ID).Scan(&taskCount); err != nil {
		t.Fatal(err)
	}
	if taskCount != 0 {
		t.Fatalf("stale manifest must not create tasks, got %d", taskCount)
	}
}

func TestP1InvalidBlocksTaskCreate(t *testing.T) {
	a := env.accounts(t).xhs
	wk := publishTestWork(t, a, "这是一条超过二十个字的小红书发布标题用于校验", 900, 1200, []string{"测试"})
	m := publishBuild(t, wk.ID.String(), "xhs")
	if m.ValidationState != "invalid" {
		t.Fatalf("want invalid, got %s checks=%+v", m.ValidationState, m.Validation.Checks)
	}
	ae := expectStatusErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/publish-tasks",
		map[string]any{"platforms": []string{"xhs"}, "mode": "desktop"}, http.StatusUnprocessableEntity, "publish_validation_failed")
	if !strings.Contains(string(ae.Error.Detail), `"checks"`) {
		t.Fatalf("422 detail must carry checks: %s", ae.Error.Detail)
	}
	var taskCount int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM publish_task WHERE work_id=$1`, wk.ID).Scan(&taskCount); err != nil {
		t.Fatal(err)
	}
	if taskCount != 0 {
		t.Fatalf("invalid manifest must not create tasks, got %d", taskCount)
	}
}

func TestP1CrossWorkspaceCrossAccountAndInvalidPlatform(t *testing.T) {
	a := env.accounts(t).wechat
	wk := publishTestWork(t, a, "跨区隔离测试", 900, 900, nil)
	publishBuild(t, wk.ID.String(), "wechat_mp")

	other := env.registerClient(t, "p1-other-"+uuid.NewString()[:8], testPassword)
	other.use()
	status, body := env.do("GET", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/wechat_mp", nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross-workspace manifest: want 404, got %d %s", status, body)
	}
	status, body = env.do("GET", "/api/v1/works/"+wk.ID.String()+"/publish-manifests", nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross-workspace manifest list: want 404, got %d %s", status, body)
	}
	other.restore(env)

	// 同工作区但 manifest.account_id 与 work.account_id 不一致：查询也不得返回。
	xhsAccount := env.accounts(t).xhs
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT a.workspace_id FROM work w
		JOIN platform_account a ON a.id=w.account_id WHERE w.id=$1`, wk.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(publishTestPayload("toutiao"))
	_, err := env.srv.db.Exec(context.Background(), `INSERT INTO publish_manifest
		(workspace_id, account_id, work_id, platform, content_hash, payload, validation, validation_state)
		VALUES ($1,$2,$3,'toutiao',$4,$5,'{}'::jsonb,'valid')`,
		workspaceID, xhsAccount.ID, wk.ID, strings.Repeat("b", 64), payload)
	if err != nil {
		t.Fatal(err)
	}
	status, body = env.do("GET", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/toutiao", nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross-account manifest: want 404, got %d %s", status, body)
	}
	_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM publish_manifest WHERE work_id=$1 AND platform='toutiao'`, wk.ID)

	expectStatusErr(t, "GET", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/weibo",
		nil, http.StatusUnprocessableEntity, "publish_platform_invalid")
}

func TestP1ManifestReadonlyPatchAndSkipReason(t *testing.T) {
	a := env.accounts(t).wechat
	wk := publishTestWork(t, a, "只读字段测试", 900, 900, nil)
	publishBuild(t, wk.ID.String(), "wechat_mp")

	expectStatusErr(t, "PATCH", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/wechat_mp",
		map[string]any{"body_md": "改正文"}, http.StatusUnprocessableEntity, "publish_manifest_content_readonly")
	expectStatusErr(t, "PATCH", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/wechat_mp",
		map[string]any{"tags": []string{"改标签"}}, http.StatusUnprocessableEntity, "publish_manifest_content_readonly")
	expectStatusErr(t, "PATCH", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/wechat_mp",
		map[string]any{"cover_asset_id": uuid.NewString()}, http.StatusUnprocessableEntity, "publish_manifest_content_readonly")

	var m PublishManifest
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String()+"/publish-manifests/wechat_mp",
		map[string]any{"skip_reason": "本期不发布公众号"}, &m)
	if m.Payload.Fields.SkipReason != "本期不发布公众号" || m.Revision != 2 {
		t.Fatalf("skip patch: %+v", m)
	}
}

func TestP1TaskCreateValidCreatesTask(t *testing.T) {
	a := env.accounts(t).wechat
	wk := publishTestWork(t, a, "任务创建测试", 900, 900, nil)
	publishBuild(t, wk.ID.String(), "wechat_mp")
	var result createPublishTasksResult
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/publish-tasks",
		map[string]any{"platforms": []string{"wechat_mp"}, "mode": "desktop"}, &result)
	if len(result.Tasks) != 1 || result.Tasks[0].State != "ready" || result.Tasks[0].Platform != "wechat_mp" {
		t.Fatalf("create task result: %+v", result)
	}
	// 重复创建复用同一任务，不重复插入。
	var again createPublishTasksResult
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/publish-tasks",
		map[string]any{"platforms": []string{"wechat_mp"}, "mode": "desktop"}, &again)
	if len(again.Tasks) != 1 || len(again.Created) != 0 || len(again.Skipped) != 1 {
		t.Fatalf("duplicate create: %+v", again)
	}
}

func TestP1PlatformSpecsCoverAllKnownPlatforms(t *testing.T) {
	for _, platform := range []string{"wechat_mp", "xhs", "toutiao"} {
		spec, ok := publishPlatformSpecFor(platform)
		if !ok || spec.Platform != platform {
			t.Fatalf("missing spec for %s", platform)
		}
	}
	if publishPlatformSupported("weibo") {
		t.Fatal("unknown platform must not be supported")
	}
}
