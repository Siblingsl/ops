package app

// REF41 P8：发布执行器抽象。执行器只做单次动作并返回结果，不写数据库、
// 不直接改 work_publish_state、不自动点国内平台发布。落账、重试、租约、
// 心跳与 published 投影仍由服务端 publish_task 流程统一负责。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"ops/internal/wechat"
)

// PublishFillRequest 是一次执行器动作的输入。Manifest 是 P1 生成的只读快照，
// 执行器不得回写。
type PublishFillRequest struct {
	TaskID      uuid.UUID
	WorkspaceID uuid.UUID
	AccountID   uuid.UUID
	WorkID      uuid.UUID
	Platform    string
	Manifest    json.RawMessage
	Mode        string

	// WechatToken / WechatCover 由服务端在调用执行器前准备；执行器不读凭证表、
	// 不写数据库，保持 P8-A3 的“单次动作”边界。Cover 只用于公众号封面素材。
	WechatToken     string
	WechatCover     []byte
	WechatCoverName string
}

// PublishFillResult 是执行器返回的唯一输出。State 只表达本次动作的结果，
// 是否落库、落成哪个任务状态由服务端判断。
type PublishFillResult struct {
	State        string
	Readback     map[string]any
	Evidence     map[string]any
	ErrorCode    string
	ErrorMessage string
}

type PublishExecutor interface {
	Name() string
	Version() string
	Preflight(ctx context.Context, req PublishFillRequest) (map[string]any, error)
	Fill(ctx context.Context, req PublishFillRequest) (PublishFillResult, error)
	Readback(ctx context.Context, req PublishFillRequest) (PublishFillResult, error)
	Submit(ctx context.Context, req PublishFillRequest) (PublishFillResult, error)
}

// PublishExecutorError 带稳定错误码，服务端据此落 error_code，前端据 code 展示。
type PublishExecutorError struct {
	Code    string
	Message string
}

func (e *PublishExecutorError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message == "" {
		return e.Code
	}
	return e.Code + ": " + e.Message
}

func NewPublishExecutorError(code, message string) *PublishExecutorError {
	return &PublishExecutorError{Code: code, Message: message}
}

// PublishExecutorErrorCode 把执行器错误归一为稳定错误码：
// 超时固定 executor_timeout；未识别的错误不伪装成功。
func PublishExecutorErrorCode(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "executor_timeout"
	}
	var pe *PublishExecutorError
	if errors.As(err, &pe) {
		return pe.Code
	}
	return "executor_failed"
}

// PublishExecutorTimeouts 是单次动作上限。Fill 120s、Readback 60s、Submit 60s
// 与方案一致；Preflight 取 30s，给账号/锚点检查留余量。
type PublishExecutorTimeouts struct {
	Preflight time.Duration
	Fill      time.Duration
	Readback  time.Duration
	Submit    time.Duration
}

func DefaultPublishExecutorTimeouts() PublishExecutorTimeouts {
	return PublishExecutorTimeouts{
		Preflight: 30 * time.Second,
		Fill:      120 * time.Second,
		Readback:  60 * time.Second,
		Submit:    60 * time.Second,
	}
}

func withPublishTimeout[T any](ctx context.Context, timeout time.Duration, fn func(context.Context) (T, error)) (T, error) {
	var zero T
	if timeout <= 0 {
		return fn(ctx)
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type outcome struct {
		value T
		err   error
	}
	ch := make(chan outcome, 1)
	go func() {
		value, err := fn(cctx)
		ch <- outcome{value: value, err: err}
	}()
	select {
	case out := <-ch:
		if out.err == nil && errors.Is(cctx.Err(), context.DeadlineExceeded) {
			return zero, context.DeadlineExceeded
		}
		return out.value, out.err
	case <-cctx.Done():
		return zero, cctx.Err()
	}
}

// RunPublishExecutor 按契约顺序执行 Preflight → Fill → Readback → Submit。
// manual 只返回等待用户动作，不调用 Fill；desktop 由桌面端 claim 后执行，
// 服务端拒绝代跑，避免绕过桌面账号校验与人工闸门。
func RunPublishExecutor(
	ctx context.Context,
	exec PublishExecutor,
	req PublishFillRequest,
	timeouts PublishExecutorTimeouts,
) (PublishFillResult, error) {
	if exec == nil {
		return PublishFillResult{}, NewPublishExecutorError("executor_not_registered", "发布执行器未注册")
	}
	if req.Mode == "manual" {
		return PublishFillResult{
			State: "awaiting_user",
			Evidence: map[string]any{
				"executor":        "manual",
				"adapter_version": exec.Version(),
			},
		}, nil
	}
	if req.Mode == "desktop" {
		return PublishFillResult{}, NewPublishExecutorError(
			"executor_desktop_claim_required",
			"桌面通道只由桌面端 claim 后执行，服务端不代跑",
		)
	}
	if _, err := withPublishTimeout(ctx, timeouts.Preflight, func(c context.Context) (map[string]any, error) {
		return exec.Preflight(c, req)
	}); err != nil {
		return PublishFillResult{}, err
	}
	fill, err := withPublishTimeout(ctx, timeouts.Fill, func(c context.Context) (PublishFillResult, error) {
		return exec.Fill(c, req)
	})
	if err != nil {
		return PublishFillResult{}, err
	}
	if fill.State == "awaiting_user" || fill.State == "failed" || fill.ErrorCode != "" {
		return fill, nil
	}
	readback, err := withPublishTimeout(ctx, timeouts.Readback, func(c context.Context) (PublishFillResult, error) {
		return exec.Readback(c, req)
	})
	if err != nil {
		return PublishFillResult{}, err
	}
	if readback.State == "failed" || readback.ErrorCode != "" {
		return readback, nil
	}
	if readback.Readback != nil {
		if ok, _ := readback.Readback["ok"].(bool); !ok {
			return PublishFillResult{
				State:        "failed",
				Readback:     readback.Readback,
				Evidence:     readback.Evidence,
				ErrorCode:    "readback_mismatch",
				ErrorMessage: "回读不一致，禁止提交",
			}, nil
		}
	}
	submit, err := withPublishTimeout(ctx, timeouts.Submit, func(c context.Context) (PublishFillResult, error) {
		return exec.Submit(c, req)
	})
	if err != nil {
		return PublishFillResult{}, err
	}
	return submit, nil
}

// RunPublishExecutorFillOnly 是生产 API runner 的默认路径：Preflight → Fill →
// Readback 后返回 filled，不调用 Submit。国内平台仍只“填入后台并回读”，
// Submit 只能由用户显式动作或既有提交入口触发。
func RunPublishExecutorFillOnly(
	ctx context.Context,
	exec PublishExecutor,
	req PublishFillRequest,
	timeouts PublishExecutorTimeouts,
) (PublishFillResult, error) {
	if exec == nil {
		return PublishFillResult{}, NewPublishExecutorError("executor_not_registered", "发布执行器未注册")
	}
	if req.Mode != "api" {
		return RunPublishExecutor(ctx, exec, req, timeouts)
	}
	if _, err := withPublishTimeout(ctx, timeouts.Preflight, func(c context.Context) (map[string]any, error) {
		return exec.Preflight(c, req)
	}); err != nil {
		return PublishFillResult{}, err
	}
	fill, err := withPublishTimeout(ctx, timeouts.Fill, func(c context.Context) (PublishFillResult, error) {
		return exec.Fill(c, req)
	})
	if err != nil {
		return PublishFillResult{}, err
	}
	if fill.State == "awaiting_user" || fill.State == "failed" || fill.ErrorCode != "" {
		return fill, nil
	}
	readback, err := withPublishTimeout(ctx, timeouts.Readback, func(c context.Context) (PublishFillResult, error) {
		return exec.Readback(c, req)
	})
	if err != nil {
		return PublishFillResult{}, err
	}
	if readback.State == "failed" || readback.ErrorCode != "" {
		return readback, nil
	}
	if readback.Readback != nil {
		if ok, _ := readback.Readback["ok"].(bool); !ok {
			return PublishFillResult{
				State:        "failed",
				Readback:     readback.Readback,
				Evidence:     readback.Evidence,
				ErrorCode:    "readback_mismatch",
				ErrorMessage: "回读不一致，禁止提交",
			}, nil
		}
	}
	// 回读结果是最终状态，但 Fill 返回的 evidence（如 content_hash/thumb_media_id）
	// 仍需保留给任务落账和草稿回执；同名键以回读结果为准。
	merged := readback
	merged.Evidence = make(map[string]any, len(fill.Evidence)+len(readback.Evidence))
	for key, value := range fill.Evidence {
		merged.Evidence[key] = value
	}
	for key, value := range readback.Evidence {
		merged.Evidence[key] = value
	}
	return merged, nil
}

// PublishExecutorDescriptor 是对外公布的执行器名称/版本，用于设置页与版本校准。
type PublishExecutorDescriptor struct {
	Platform string `json:"platform"`
	Mode     string `json:"mode"`
	Name     string `json:"name"`
	Version  string `json:"version"`
}

type publishExecutorKey struct {
	platform string
	mode     string
}

// PublishExecutorRegistry 按平台 × 通道注册。manual 有 `*` 兜底；
// 其他通道必须 exact 命中，避免把桌面任务误派给 API 执行器。
type PublishExecutorRegistry struct {
	mu        sync.RWMutex
	executors map[publishExecutorKey]PublishExecutor
}

func NewPublishExecutorRegistry() *PublishExecutorRegistry {
	return &PublishExecutorRegistry{executors: make(map[publishExecutorKey]PublishExecutor)}
}

func (r *PublishExecutorRegistry) Register(platform, mode string, exec PublishExecutor) error {
	if platform == "" || mode == "" {
		return fmt.Errorf("发布执行器 platform/mode 不能为空")
	}
	if exec == nil || exec.Name() == "" || exec.Version() == "" {
		return fmt.Errorf("发布执行器必须有名称与版本")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	key := publishExecutorKey{platform: platform, mode: mode}
	if _, exists := r.executors[key]; exists {
		return fmt.Errorf("发布执行器重复注册: %s/%s", platform, mode)
	}
	r.executors[key] = exec
	return nil
}

func (r *PublishExecutorRegistry) Lookup(platform, mode string) (PublishExecutor, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if exec, ok := r.executors[publishExecutorKey{platform: platform, mode: mode}]; ok {
		return exec, true
	}
	if mode == "manual" {
		exec, ok := r.executors[publishExecutorKey{platform: "*", mode: "manual"}]
		return exec, ok
	}
	return nil, false
}

func (r *PublishExecutorRegistry) Descriptors() []PublishExecutorDescriptor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	items := make([]PublishExecutorDescriptor, 0, len(r.executors))
	for key, exec := range r.executors {
		items = append(items, PublishExecutorDescriptor{
			Platform: key.platform,
			Mode:     key.mode,
			Name:     exec.Name(),
			Version:  exec.Version(),
		})
	}
	return items
}

// manualPublishExecutor 仅用于 manual 通道；RunPublishExecutor 不会调用 Fill。
type manualPublishExecutor struct{}

func (manualPublishExecutor) Name() string    { return "manual" }
func (manualPublishExecutor) Version() string { return "manual-v1" }
func (manualPublishExecutor) Preflight(context.Context, PublishFillRequest) (map[string]any, error) {
	return map[string]any{"mode": "manual"}, nil
}
func (manualPublishExecutor) Fill(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return PublishFillResult{State: "awaiting_user", Evidence: map[string]any{"manual": true}}, nil
}
func (manualPublishExecutor) Readback(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return PublishFillResult{State: "awaiting_user", Evidence: map[string]any{"manual": true}}, nil
}
func (manualPublishExecutor) Submit(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return PublishFillResult{}, NewPublishExecutorError("manual_submit_forbidden", "manual 通道不代提交")
}

// desktopDispatchExecutor 是服务端占位：桌面通道必须由桌面端 claim 后执行。
type desktopDispatchExecutor struct {
	platform string
	version  string
}

func (e desktopDispatchExecutor) Name() string    { return e.platform + "-desktop" }
func (e desktopDispatchExecutor) Version() string { return e.version }
func (e desktopDispatchExecutor) desktopOnly() (PublishFillResult, error) {
	return PublishFillResult{}, NewPublishExecutorError(
		"executor_desktop_claim_required",
		"桌面通道只由桌面端 claim 后执行，服务端不代跑",
	)
}
func (e desktopDispatchExecutor) Preflight(context.Context, PublishFillRequest) (map[string]any, error) {
	return nil, NewPublishExecutorError("executor_desktop_claim_required", "桌面通道只由桌面端 claim 后执行，服务端不代跑")
}
func (e desktopDispatchExecutor) Fill(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return e.desktopOnly()
}
func (e desktopDispatchExecutor) Readback(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return e.desktopOnly()
}
func (e desktopDispatchExecutor) Submit(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return e.desktopOnly()
}

// notConfiguredExecutor 保留通道位但不伪造发布成功；真正接入平台前返回
// executor_not_configured，前端显示“未配置”。
type notConfiguredExecutor struct {
	name    string
	version string
}

func (e notConfiguredExecutor) Name() string    { return e.name }
func (e notConfiguredExecutor) Version() string { return e.version }
func (e notConfiguredExecutor) notConfigured() (PublishFillResult, error) {
	return PublishFillResult{}, NewPublishExecutorError("executor_not_configured", "发布执行器尚未配置")
}
func (e notConfiguredExecutor) Preflight(context.Context, PublishFillRequest) (map[string]any, error) {
	return nil, NewPublishExecutorError("executor_not_configured", "发布执行器尚未配置")
}
func (e notConfiguredExecutor) Fill(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return e.notConfigured()
}
func (e notConfiguredExecutor) Readback(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return e.notConfigured()
}
func (e notConfiguredExecutor) Submit(context.Context, PublishFillRequest) (PublishFillResult, error) {
	return e.notConfigured()
}

// DefaultPublishExecutorRegistry 是 P8 的最小注册表：
// 公众号 API 走 DraftAdd（只进草稿箱，不群发/不发布），xhs/头条桌面与 manual 保持原口径。
// wx 为 nil 时公众号执行器仍注册，但 Preflight 返回 executor_not_configured，不伪造成功。
func DefaultPublishExecutorRegistry(wx *wechat.Client) *PublishExecutorRegistry {
	r := NewPublishExecutorRegistry()
	_ = r.Register("wechat_mp", "api", newWechatMPAPIExecutor(wx))
	_ = r.Register("xhs", "desktop", desktopDispatchExecutor{platform: "xhs", version: "xhs-fill-v1"})
	_ = r.Register("toutiao", "desktop", desktopDispatchExecutor{platform: "toutiao", version: "toutiao-fill-v1"})
	_ = r.Register("*", "manual", manualPublishExecutor{})
	return r
}

// PublishAdapterCalibration 记录某账号/平台/通道最近一次校准的适配器版本。
type PublishAdapterCalibration struct {
	AccountID    uuid.UUID
	Platform     string
	Mode         string
	Version      string
	CalibratedAt time.Time
}

// PublishAdapterVersionRegistry 只做版本校准判定，不写库；P4 能力矩阵接入后
// 由它把 adapter_version_changed 落成通道状态。
type PublishAdapterVersionRegistry struct {
	mu         sync.RWMutex
	calibrated map[string]PublishAdapterCalibration
}

func NewPublishAdapterVersionRegistry() *PublishAdapterVersionRegistry {
	return &PublishAdapterVersionRegistry{calibrated: make(map[string]PublishAdapterCalibration)}
}

func publishAdapterKey(accountID uuid.UUID, platform, mode string) string {
	return accountID.String() + "|" + platform + "|" + mode
}

func (r *PublishAdapterVersionRegistry) Calibrate(accountID uuid.UUID, platform, mode, version string, at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calibrated[publishAdapterKey(accountID, platform, mode)] = PublishAdapterCalibration{
		AccountID: accountID, Platform: platform, Mode: mode, Version: version, CalibratedAt: at,
	}
}

// Observe 返回当前版本是否仍与校准版本一致。首次未校准或版本变化都不算有效；
// 调用方需要重新校准后才能继续自动填充。
func (r *PublishAdapterVersionRegistry) Observe(accountID uuid.UUID, platform, mode, version string) (bool, string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	item, ok := r.calibrated[publishAdapterKey(accountID, platform, mode)]
	if !ok {
		return false, "calibration_missing"
	}
	if item.Version != version {
		return false, "adapter_version_changed"
	}
	return true, ""
}
