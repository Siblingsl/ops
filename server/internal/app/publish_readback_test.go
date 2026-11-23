package app

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func p3ReadbackSample(screenshotID string, ok bool) map[string]any {
	return map[string]any{
		"checked_at":      "2026-11-17T10:00:00+08:00",
		"adapter_version": "xhs-fill-v1",
		"ok":              ok,
		"fields": map[string]any{
			"title": map[string]any{"expected_hash": "aaaa", "actual_hash": "aaaa", "ok": true},
			"body":  map[string]any{"expected_len": 800, "actual_len": 798, "ok": false},
			"tags":  map[string]any{"expected_count": 5, "actual_count": 5, "first": "#账号名", "ok": true},
			"cover": map[string]any{"present": true, "ok": true},
			"schedule": map[string]any{
				"expected": nil, "actual": nil, "ok": true,
			},
		},
		"screenshot_asset_id": screenshotID,
		"tab_ref":             "tab-1",
	}
}

func TestP3ReadbackStructureCoversFiveFieldsAndScreenshot(t *testing.T) {
	rb, err := ParsePublishReadback(p3ReadbackSample(uuid.NewString(), false))
	if err != nil {
		t.Fatalf("ParsePublishReadback: %v", err)
	}
	if len(rb.Fields) != 5 {
		t.Fatalf("fields = %d, want 5", len(rb.Fields))
	}
	for _, name := range PublishReadbackFieldNames {
		if _, ok := rb.Fields[name]; !ok {
			t.Fatalf("missing field %s", name)
		}
	}
	if rb.ScreenshotAssetID == "" {
		t.Fatal("screenshot_asset_id missing")
	}
	if rb.OK {
		t.Fatal("sample with body mismatch must not be ok")
	}
}

func TestP3ReadbackValidationRejectsMissingFieldOrScreenshot(t *testing.T) {
	sample := p3ReadbackSample(uuid.NewString(), true)
	delete(sample, "screenshot_asset_id")
	if _, err := ParsePublishReadback(sample); err == nil {
		t.Fatal("missing screenshot must fail")
	}
	sample = p3ReadbackSample(uuid.NewString(), true)
	delete(sample["fields"].(map[string]any), "cover")
	if _, err := ParsePublishReadback(sample); err == nil {
		t.Fatal("missing cover field must fail")
	}
}

func TestP3NormalizationRules(t *testing.T) {
	if got, want := NormalizePublishText("　ＡＢＣ　１２３\u200b"), "ABC 123"; got != want {
		t.Fatalf("normalize text = %q, want %q", got, want)
	}
	if got, want := NormalizePublishText("  第一行\n\n第二行\t "), "第一行 第二行"; got != want {
		t.Fatalf("whitespace collapse = %q, want %q", got, want)
	}

	title := ComparePublishTitle("ＡＢＣ 标题", "ABC  标题")
	if title["ok"] != true {
		t.Fatalf("title full-width/space should match: %+v", title)
	}

	body := ComparePublishBody("第一段\n第二段", "第一段第二段", PublishBodyPromoSuffixes)
	if body["ok"] != true {
		t.Fatalf("body line-break difference should match: %+v", body)
	}
	truncated := ComparePublishBody("第一段第二段", "第一段", PublishBodyPromoSuffixes)
	if truncated["ok"] != false {
		t.Fatalf("body truncation must mismatch: %+v", truncated)
	}
	promo := ComparePublishBody("第一段第二段", "第一段第二段\n\n本文为推广内容", PublishBodyPromoSuffixes)
	if promo["ok"] != true {
		t.Fatalf("fixed promo suffix should be tolerated: %+v", promo)
	}
	unknownPromo := ComparePublishBody("第一段第二段", "第一段第二段\n\n加微信领福利", PublishBodyPromoSuffixes)
	if unknownPromo["ok"] != false {
		t.Fatalf("unknown promo suffix must mismatch: %+v", unknownPromo)
	}

	tags := ComparePublishTags([]string{"#账号名", "#穿搭", "#日常"}, []string{"#账号名", "#日常", "#穿搭"})
	if tags["ok"] != true {
		t.Fatalf("tag order should be ignored: %+v", tags)
	}
	missingTag := ComparePublishTags([]string{"#账号名", "#穿搭"}, []string{"#账号名"})
	if missingTag["ok"] != false {
		t.Fatalf("tag count mismatch must fail: %+v", missingTag)
	}

	cover := ComparePublishCover(true, true, 0.75, 0.76)
	if cover["ok"] != true {
		t.Fatalf("cover ratio within tolerance should match: %+v", cover)
	}
	if bad := ComparePublishCover(true, false, 0.75, 0); bad["ok"] != false {
		t.Fatalf("missing cover must fail: %+v", bad)
	}

	schedule := ComparePublishSchedule("2026-11-18 10:00", "2026-11-18　10:00")
	if schedule["ok"] != true {
		t.Fatalf("schedule full-width space should match: %+v", schedule)
	}
}

type p3ReadbackExecutor struct {
	submitCalls int
	readback    PublishFillResult
}

func (p *p3ReadbackExecutor) Name() string    { return "p3-fake" }
func (p *p3ReadbackExecutor) Version() string { return "p3-fake-v1" }
func (p *p3ReadbackExecutor) Preflight(context.Context, PublishFillRequest) (map[string]any, error) {
	return map[string]any{"ok": true}, nil
}
func (p *p3ReadbackExecutor) Fill(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return PublishFillResult{State: "filled"}, nil
}
func (p *p3ReadbackExecutor) Readback(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return p.readback, nil
}
func (p *p3ReadbackExecutor) Submit(context.Context, PublishFillRequest) (PublishFillResult, error) {
	p.submitCalls++
	return PublishFillResult{State: "submitted"}, nil
}

func TestP3ReadbackMismatchBlocksSubmit(t *testing.T) {
	exec := &p3ReadbackExecutor{readback: PublishFillResult{
		State:    "awaiting_user",
		Readback: map[string]any{"ok": false},
		Evidence: map[string]any{"readback": "automatic"},
	}}
	result, err := RunPublishExecutor(context.Background(), exec, PublishFillRequest{Mode: "api", Platform: "wechat_mp"}, DefaultPublishExecutorTimeouts())
	if err != nil {
		t.Fatalf("RunPublishExecutor: %v", err)
	}
	if result.State != "failed" || result.ErrorCode != "readback_mismatch" {
		t.Fatalf("result = %+v, want failed/readback_mismatch", result)
	}
	if exec.submitCalls != 0 {
		t.Fatalf("submit called %d times after mismatch", exec.submitCalls)
	}

	exec = &p3ReadbackExecutor{readback: PublishFillResult{
		State:    "awaiting_user",
		Readback: map[string]any{"ok": true},
		Evidence: map[string]any{"readback": "automatic"},
	}}
	result, err = RunPublishExecutor(context.Background(), exec, PublishFillRequest{Mode: "api", Platform: "wechat_mp"}, DefaultPublishExecutorTimeouts())
	if err != nil {
		t.Fatalf("RunPublishExecutor ok: %v", err)
	}
	if result.State != "submitted" || exec.submitCalls != 1 {
		t.Fatalf("result = %+v submitCalls=%d, want submitted/1", result, exec.submitCalls)
	}
}

func TestP3ReadbackMismatchCannotEnterFilled(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P3回读不一致")
	wk := publishTestWork(t, a, "P3回读不一致作品", 900, 900, nil)
	task := p2CreateTask(t, a, wk, "wechat_mp", "api")
	p2SetTaskState(t, task.ID, "filling", 2, 1, "api")
	ae := expectStatusErr(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/transition", map[string]any{
		"to":               "filled",
		"expected_version": 2,
		"idempotency_key":  uuid.NewString(),
		"evidence":         map[string]any{"readback": p3ReadbackSample(uuid.NewString(), false)},
	}, http.StatusConflict, "publish_task_state_invalid")
	if ae.Error.Code != "publish_task_state_invalid" {
		t.Fatalf("error = %+v", ae)
	}
}

func TestP3ManualAndAPIReadbackStateBranches(t *testing.T) {
	a := drAccount(t, "xhs", "P3手动停")
	wkManual := publishTestWork(t, a, "P3手动停作品", 900, 1200, []string{"#账号名", "#日常"})
	manual := p2CreateTask(t, a, wkManual, "xhs", "manual")
	p2SetTaskState(t, manual.ID, "filled", 3, 1, "manual")
	out := p2TaskTransition(t, manual.ID, map[string]any{
		"to":               "awaiting_user",
		"expected_version": 3,
		"idempotency_key":  uuid.NewString(),
		"evidence":         map[string]any{"screenshot_asset_id": uuid.NewString(), "readback": p3ReadbackSample(uuid.NewString(), true)},
	})
	if out.State != "awaiting_user" {
		t.Fatalf("manual state = %q, want awaiting_user", out.State)
	}

	wkAPI := publishTestWork(t, a, "P3 API停作品", 900, 1200, []string{"#账号名", "#日常"})
	apiTask := p2CreateTask(t, a, wkAPI, "xhs", "api")
	p2SetTaskState(t, apiTask.ID, "filled", 4, 1, "api")
	p2Milestone(t, wkAPI.ID, "submitted")
	out = p2TaskTransition(t, apiTask.ID, map[string]any{
		"to":               "submitted",
		"expected_version": 4,
		"idempotency_key":  uuid.NewString(),
		"evidence":         map[string]any{"readback": p3ReadbackSample(uuid.NewString(), true)},
	})
	if out.State != "submitted" {
		t.Fatalf("api state = %q, want submitted", out.State)
	}
}

func TestP3ScreenshotUsesExistingAssetTable(t *testing.T) {
	a := drAccount(t, "xhs", "P3截图资产")
	wk := publishTestWork(t, a, "P3截图资产作品", 900, 1200, []string{"#账号名"})
	asset := env.upload(t, wk.ID.String(), testPNG(900, 1200))
	var count int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM asset WHERE id=$1 AND work_id=$2`, asset.ID, wk.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("asset row count = %d, want 1", count)
	}

	task := p2CreateTask(t, a, wk, "xhs", "desktop")
	p2SetTaskState(t, task.ID, "filling", 5, 1, "desktop")
	readback := p3ReadbackSample(asset.ID.String(), false)
	out := p2TaskTransition(t, task.ID, map[string]any{
		"to":               "failed",
		"expected_version": 5,
		"idempotency_key":  uuid.NewString(),
		"error_code":       "readback_mismatch",
		"error_message":    "正文长度不一致",
		"evidence":         map[string]any{"readback": readback},
	})
	if out.State != "failed" || out.LastErrorCode != "readback_mismatch" {
		t.Fatalf("task = %+v", out)
	}
	var loaded []PublishTask
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String()+"/publish-tasks", nil, &loaded)
	if len(loaded) != 1 {
		t.Fatalf("tasks = %d, want 1", len(loaded))
	}
	if loaded[0].ID != task.ID {
		t.Fatalf("task id = %s, want %s", loaded[0].ID, task.ID)
	}
	rb, err := ParsePublishReadback(loaded[0].Evidence["readback"])
	if err != nil {
		t.Fatalf("stored readback: %v", err)
	}
	if rb.ScreenshotAssetID != asset.ID.String() {
		t.Fatalf("screenshot = %q, want %q", rb.ScreenshotAssetID, asset.ID.String())
	}
	if rb.OK {
		t.Fatal("stored mismatch readback must be ok=false")
	}
	if time.Now().After(loaded[0].UpdatedAt.Add(time.Minute)) {
		t.Fatal("task was not updated")
	}
}
