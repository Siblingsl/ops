package app

import (
	"context"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

type fakePublishExecutor struct {
	name         string
	version      string
	calls        []string
	preflight    map[string]any
	preflightErr error
	fill         PublishFillResult
	fillErr      error
	fillDelay    time.Duration
	readback     PublishFillResult
}

func (f *fakePublishExecutor) Name() string    { return f.name }
func (f *fakePublishExecutor) Version() string { return f.version }
func (f *fakePublishExecutor) Preflight(context.Context, PublishFillRequest) (map[string]any, error) {
	f.calls = append(f.calls, "preflight")
	return f.preflight, f.preflightErr
}
func (f *fakePublishExecutor) Fill(ctx context.Context, _ PublishFillRequest) (PublishFillResult, error) {
	f.calls = append(f.calls, "fill")
	if f.fillDelay > 0 {
		select {
		case <-time.After(f.fillDelay):
		case <-ctx.Done():
			return PublishFillResult{}, ctx.Err()
		}
	}
	return f.fill, f.fillErr
}
func (f *fakePublishExecutor) Readback(context.Context, PublishFillRequest) (PublishFillResult, error) {
	f.calls = append(f.calls, "readback")
	if f.readback.State != "" {
		return f.readback, nil
	}
	return PublishFillResult{State: "awaiting_user"}, nil
}
func (f *fakePublishExecutor) Submit(context.Context, PublishFillRequest) (PublishFillResult, error) {
	f.calls = append(f.calls, "submit")
	return PublishFillResult{State: "submitted"}, nil
}

func TestP8ExecutorContractFourMethodsAndVersion(t *testing.T) {
	fake := &fakePublishExecutor{
		name:      "fake-api",
		version:   "fake-v1",
		preflight: map[string]any{"ok": true},
		fill:      PublishFillResult{State: "filled", Evidence: map[string]any{"adapter_version": "fake-v1"}},
	}
	if fake.Name() != "fake-api" || fake.Version() != "fake-v1" {
		t.Fatalf("name/version = %q/%q", fake.Name(), fake.Version())
	}
	result, err := RunPublishExecutor(context.Background(), fake, PublishFillRequest{
		TaskID: uuid.New(), Platform: "wechat_mp", Mode: "api",
	}, DefaultPublishExecutorTimeouts())
	if err != nil {
		t.Fatalf("RunPublishExecutor: %v", err)
	}
	if result.State != "submitted" {
		t.Fatalf("state = %q, want submitted", result.State)
	}
	want := []string{"preflight", "fill", "readback", "submit"}
	if len(fake.calls) != len(want) {
		t.Fatalf("calls = %v, want %v", fake.calls, want)
	}
	for i := range want {
		if fake.calls[i] != want[i] {
			t.Fatalf("calls = %v, want %v", fake.calls, want)
		}
	}
}

func TestP8RegistryCoversThreePlatformsAndChannels(t *testing.T) {
	registry := DefaultPublishExecutorRegistry(nil)
	cases := []struct {
		platform string
		mode     string
		name     string
		version  string
	}{
		{"wechat_mp", "api", "wechat-mp-api", "wechat-mp-api-v1"},
		{"wechat_mp", "manual", "manual", "manual-v1"},
		{"xhs", "desktop", "xhs-desktop", "xhs-fill-v1"},
		{"xhs", "manual", "manual", "manual-v1"},
		{"toutiao", "desktop", "toutiao-desktop", "toutiao-fill-v1"},
		{"toutiao", "manual", "manual", "manual-v1"},
	}
	for _, tc := range cases {
		exec, ok := registry.Lookup(tc.platform, tc.mode)
		if !ok {
			t.Fatalf("missing executor %s/%s", tc.platform, tc.mode)
		}
		if exec.Name() != tc.name || exec.Version() != tc.version {
			t.Fatalf("%s/%s = %s/%s, want %s/%s", tc.platform, tc.mode, exec.Name(), exec.Version(), tc.name, tc.version)
		}
	}
	if len(registry.Descriptors()) < 4 {
		t.Fatalf("descriptors = %v", registry.Descriptors())
	}
}

func TestP8ManualModeDoesNotFill(t *testing.T) {
	fake := &fakePublishExecutor{name: "fake", version: "fake-v1", fill: PublishFillResult{State: "filled"}}
	result, err := RunPublishExecutor(context.Background(), fake, PublishFillRequest{Mode: "manual", Platform: "xhs"}, DefaultPublishExecutorTimeouts())
	if err != nil {
		t.Fatalf("RunPublishExecutor: %v", err)
	}
	if result.State != "awaiting_user" {
		t.Fatalf("state = %q, want awaiting_user", result.State)
	}
	if len(fake.calls) != 0 {
		t.Fatalf("manual called executor: %v", fake.calls)
	}
	if result.Evidence["adapter_version"] != "fake-v1" {
		t.Fatalf("evidence = %v", result.Evidence)
	}
}

func TestP8DesktopModeRequiresDesktopClaim(t *testing.T) {
	registry := DefaultPublishExecutorRegistry(nil)
	exec, ok := registry.Lookup("xhs", "desktop")
	if !ok {
		t.Fatal("xhs/desktop not registered")
	}
	_, err := RunPublishExecutor(context.Background(), exec, PublishFillRequest{Mode: "desktop", Platform: "xhs"}, DefaultPublishExecutorTimeouts())
	if code := PublishExecutorErrorCode(err); code != "executor_desktop_claim_required" {
		t.Fatalf("code = %q, err = %v", code, err)
	}
}

func TestP8TimeoutMapsToExecutorTimeout(t *testing.T) {
	fake := &fakePublishExecutor{
		name: "slow", version: "slow-v1",
		fill:      PublishFillResult{State: "filled"},
		fillDelay: 50 * time.Millisecond,
	}
	timeouts := DefaultPublishExecutorTimeouts()
	timeouts.Fill = 10 * time.Millisecond
	_, err := RunPublishExecutor(context.Background(), fake, PublishFillRequest{Mode: "api", Platform: "wechat_mp"}, timeouts)
	if code := PublishExecutorErrorCode(err); code != "executor_timeout" {
		t.Fatalf("code = %q, err = %v", code, err)
	}
}

func TestP8AdapterVersionChangeInvalidatesCalibration(t *testing.T) {
	accountID := uuid.New()
	registry := NewPublishAdapterVersionRegistry()
	if valid, reason := registry.Observe(accountID, "xhs", "desktop", "xhs-fill-v1"); valid || reason != "calibration_missing" {
		t.Fatalf("before calibration = %v/%q", valid, reason)
	}
	registry.Calibrate(accountID, "xhs", "desktop", "xhs-fill-v1", time.Now())
	if valid, reason := registry.Observe(accountID, "xhs", "desktop", "xhs-fill-v1"); !valid || reason != "" {
		t.Fatalf("same version = %v/%q", valid, reason)
	}
	if valid, reason := registry.Observe(accountID, "xhs", "desktop", "xhs-fill-v2"); valid || reason != "adapter_version_changed" {
		t.Fatalf("changed version = %v/%q", valid, reason)
	}
	registry.Calibrate(accountID, "xhs", "desktop", "xhs-fill-v2", time.Now())
	if valid, reason := registry.Observe(accountID, "xhs", "desktop", "xhs-fill-v2"); !valid || reason != "" {
		t.Fatalf("recalibrated = %v/%q", valid, reason)
	}
}

func TestP8ExecutorSourceDoesNotWriteDBOrPublish(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "publish_executor.go", nil, parser.ImportsOnly)
	if err != nil {
		t.Fatalf("parse publish_executor.go: %v", err)
	}
	for _, imp := range f.Imports {
		path := strings.Trim(imp.Path.Value, `"`)
		if strings.Contains(path, "pgx") || path == "database/sql" || strings.Contains(path, "internal/db") {
			t.Fatalf("publish_executor.go imports DB package %q", path)
		}
	}
	src, err := os.ReadFile("publish_executor.go")
	if err != nil {
		t.Fatalf("read publish_executor.go: %v", err)
	}
	text := string(src)
	for _, forbidden := range []string{"INSERT INTO", "UPDATE publish_task", "DELETE FROM", "syncPublishStatePublic", "markPublished"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("publish_executor.go contains %q", forbidden)
		}
	}
}

// P8 生产 runner 默认只填到 filled；Submit 不能在生产 runner 自动调用。
func TestP8FillOnlyStopsBeforeSubmit(t *testing.T) {
	fake := &fakePublishExecutor{
		name: "fake", version: "fake-v1", preflight: map[string]any{"ok": true},
		fill:     PublishFillResult{State: "filled", Evidence: map[string]any{"draft_media_id": "draft-1"}},
		readback: PublishFillResult{State: "filled", Readback: map[string]any{"ok": true}},
	}
	result, err := RunPublishExecutorFillOnly(context.Background(), fake,
		PublishFillRequest{TaskID: uuid.New(), Platform: "wechat_mp", Mode: "api"}, DefaultPublishExecutorTimeouts())
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "filled" {
		t.Fatalf("state = %q, want filled", result.State)
	}
	if result.Evidence["draft_media_id"] != "draft-1" {
		t.Fatalf("fill evidence lost: %#v", result.Evidence)
	}
	want := []string{"preflight", "fill", "readback"}
	if len(fake.calls) != len(want) || fake.calls[2] != "readback" {
		t.Fatalf("calls = %v, want %v (submit must not run)", fake.calls, want)
	}
}

func TestP8ProductionRunnerFillsAndSubmitsWechatAPITask(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P8生产Runner公众号")
	wk := publishTestWork(t, a, "P8生产Runner作品", 900, 1200, []string{"测试"})
	task := p2CreateTask(t, a, wk, "wechat_mp", "api")
	var queued PublishTask
	env.mustJSON(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/queue",
		map[string]any{"idempotency_key": "p8-runner-queue-" + task.ID.String()}, &queued)
	if queued.State != "queued" {
		t.Fatalf("queued state = %s", queued.State)
	}
	fake := &fakePublishExecutor{
		name: "fake-api", version: "fake-v1", preflight: map[string]any{"ok": true},
		fill: PublishFillResult{State: "filled", Evidence: map[string]any{
			"draft_media_id": "draft-runner-1", "content_hash": "hash-runner-1",
		}},
		readback: PublishFillResult{State: "filled", Readback: map[string]any{"ok": true}, Evidence: map[string]any{"adapter_version": "fake-v1"}},
	}
	old := env.srv.publishExecutors
	registry := NewPublishExecutorRegistry()
	if err := registry.Register("wechat_mp", "api", fake); err != nil {
		t.Fatal(err)
	}
	env.srv.publishExecutors = registry
	defer func() { env.srv.publishExecutors = old }()

	done, err := env.srv.runOnePublishAPITask(context.Background())
	if err != nil {
		t.Fatalf("runner: %v", err)
	}
	if !done {
		t.Fatal("runner did not process queued api task")
	}
	got, err := env.srv.loadPublishTaskByID(publishRunnerContext(context.Background(), &queued), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "submitted" || got.Attempt != 1 {
		t.Fatalf("task = state %s attempt %d, want submitted/1", got.State, got.Attempt)
	}
	if got.SubmittedAt == nil {
		t.Fatal("task submitted_at missing")
	}
	if got.Evidence["draft_media_id"] != "draft-runner-1" {
		t.Fatalf("task evidence lost fill draft id: %#v", got.Evidence)
	}
	if ok, _ := got.Evidence["readback_ok"].(bool); !ok {
		t.Fatalf("evidence readback_ok missing: %v", got.Evidence)
	}
	var workStatus string
	var draftID, draftHash *string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status, wechat_draft_media_id, wechat_draft_hash
		FROM work WHERE id=$1`, wk.ID).Scan(&workStatus, &draftID, &draftHash); err != nil {
		t.Fatal(err)
	}
	if workStatus != "pushed" || draftID == nil || *draftID != "draft-runner-1" {
		t.Fatalf("work receipt = status %s draft %v, want pushed/draft-runner-1", workStatus, draftID)
	}
	if draftHash == nil || *draftHash != "hash-runner-1" {
		t.Fatalf("work draft hash = %v, want hash-runner-1", draftHash)
	}
	var receipts int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM push_record
		WHERE work_id=$1 AND status='ok' AND draft_media_id=$2`, wk.ID, "draft-runner-1").Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 1 {
		t.Fatalf("ok push_record count = %d, want 1", receipts)
	}
	var milestoneState string
	var milestoneRef []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT state, submitted_ref
		FROM work_publish_state WHERE work_id=$1`, wk.ID).Scan(&milestoneState, &milestoneRef); err != nil {
		t.Fatal(err)
	}
	if milestoneState != "submitted" {
		t.Fatalf("work milestone = %s, want submitted", milestoneState)
	}
	if !strings.Contains(string(milestoneRef), "draft-runner-1") {
		t.Fatalf("submitted_ref missing draft id: %s", milestoneRef)
	}
	for _, call := range fake.calls {
		if call == "submit" {
			t.Fatal("production runner must not call Submit")
		}
	}
}
