package app

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

// DEV-CU P4-2（docs/36 §5 / §4.10，D-188）：电脑控制命令账本的 Go 侧数据结构。
// 结构对齐 agent_browser_commands.go 先例（browserCommandView / 列清单 / 扫描函数 /
// 常量总表）；差异点按 §4.10 契约：card_id / approval_hash / disposition /
// requires_confirmation / generation（审批版本 CAS），state 无 browser 的 rejected。
// 本包只定义视图与常量；命令创建 / CAS 领取 / 回执 / sweep 属 P4-4~P4-6，不在本文件。

// computerCommandView：命令账本行视图（§4.10 列 → JSON 字段，命名照 browser 先例）。
type computerCommandView struct {
	ID        string `json:"id"`
	GrantID   string `json:"grant_id"`
	RunID     string `json:"run_id,omitempty"`
	RequestID string `json:"request_id"`
	// D-117：写类动作绑定确认卡片；card_id / approval_hash 仅写类非空。
	CardID       string `json:"card_id,omitempty"`
	ApprovalHash string `json:"approval_hash,omitempty"`
	ActionKind   string `json:"action_kind"`
	TargetRef    string `json:"target_ref,omitempty"`
	InputHash    string `json:"input_hash"`
	State        string `json:"state"`
	// payload 只在桌面领取 / 领取派发响应中出现（执行必需）；
	// result 只在终态回执后出现（模型同步等待读取）。均 nil 时不出现在 JSON。
	Payload              json.RawMessage `json:"payload,omitempty"`
	Result               json.RawMessage `json:"result,omitempty"`
	Claimed              bool            `json:"claimed,omitempty"`
	Disposition          json.RawMessage `json:"disposition,omitempty"`
	RequiresConfirmation bool            `json:"requires_confirmation"`
	Generation           int64           `json:"generation"`
	DeadlineAt           string          `json:"deadline_at,omitempty"`
	DispatchedAt         string          `json:"dispatched_at,omitempty"`
	ErrorCode            string          `json:"error_code,omitempty"`
	CreatedAt            string          `json:"created_at"`
}

// computerCommandActions：§4.10 的 6 个固定语义（request_handoff 不建命令，
// 直接走租约撤销，不触达 worker）。
var computerCommandActions = map[string]bool{
	"observe": true, "focus": true, "scroll": true,
	"select": true, "invoke": true, "type": true,
}

// 列清单与 scanComputerCommand 必须一一对应；时间沿用 browser 先例的 UTC to_char。
const computerCommandColumns = `c.id::text, c.grant_id::text, COALESCE(c.run_id::text,''), c.request_id::text,
	COALESCE(c.card_id::text,''), COALESCE(c.approval_hash,''), c.action_kind, COALESCE(c.target_ref,''),
	c.input_hash, c.state, COALESCE(c.payload::text,''), COALESCE(c.result::text,''),
	COALESCE(c.disposition::text,''), c.requires_confirmation, c.generation,
	COALESCE(to_char(c.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
	COALESCE(to_char(c.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
	COALESCE(c.error_code,''), to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`

func scanComputerCommand(row pgx.Row) (computerCommandView, error) {
	var v computerCommandView
	var payload, result, disposition []byte
	err := row.Scan(&v.ID, &v.GrantID, &v.RunID, &v.RequestID,
		&v.CardID, &v.ApprovalHash, &v.ActionKind, &v.TargetRef,
		&v.InputHash, &v.State, &payload, &result, &disposition,
		&v.RequiresConfirmation, &v.Generation,
		&v.DeadlineAt, &v.DispatchedAt, &v.ErrorCode, &v.CreatedAt)
	if len(payload) > 0 {
		v.Payload = json.RawMessage(payload)
	}
	if len(result) > 0 {
		v.Result = json.RawMessage(result)
	}
	if len(disposition) > 0 {
		v.Disposition = json.RawMessage(disposition)
	}
	return v, err
}

// §4.10 常量总表（全部集中，便于复算；browser 先例同款）：
// 单命令 deadline 30s、sweep 宽限 2s、同步等待预算 35s、等待轮询 200ms。
const (
	computerCommandDeadline   = 30 * time.Second
	computerCommandSweepGrace = 2 * time.Second
	computerCommandWaitBudget = 35 * time.Second
	computerCommandWaitPoll   = 200 * time.Millisecond
)

// computerInputHash：sha256(action_kind + "." + canonicalJSON(payload))，
// 与 browser 的 input_hash 同构（同请求异载荷 409 的依据）。
// payload 先经 canonicalJSON 归一键序/数字形态（browser 先例在 json.Marshal 前同样
// 依赖 map 序列化稳定性；这里显式归一，跨请求同语义不同键序产出同 hash）。
func computerInputHash(action string, payload []byte) string {
	sum := sha256.Sum256(append([]byte(action+"."), payload...))
	return fmt.Sprintf("%x", sum)
}

// ---- P4-3：动作参数校验（§P4-3 步骤 1~3）----
// 服务端不解析语义、不拼 PS：只把「越界字符串」挡在账本之外。

// computerRefRe 与 worker 侧 refs.js 同口径：@<snapshot_id>:e<N>，
// snapshot_id 为 3..64 位 [A-Za-z0-9_-]，序号为不以 0 开头的 1..10 位正整数
// （worker 侧 resolveRefTarget 要求 index ≥ 1，此处正则同步排除 e0 / e01）。
var computerRefRe = regexp.MustCompile(`^@[A-Za-z0-9_-]{3,64}:e[1-9][0-9]{0,9}$`)

// computerTextRe：允许换行与常规可见字符；拒绝其余 C0/C1 控制符（\t\n\r 除外）。
// 不做脚本检测——payload 永不被拼进 PowerShell（§P4-3 步骤 3 的明确边界）。
var computerTextRe = regexp.MustCompile(`^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]*$`)

// computerActionPayloadKeys：每个 kind 的 payload 白名单键（§P4-3 步骤 1）。
// 六语义都以 ref 为目标；type 额外允许 text。动作的语义参数（如 scroll 的方向）
// 由 worker 侧 normalizeArgs 兜底，账本只锁「模型不能塞任意键」这条红线。
var computerActionPayloadKeys = map[string]map[string]bool{
	"observe": {"ref": true},
	"focus":   {"ref": true},
	"scroll":  {"ref": true},
	"select":  {"ref": true},
	"invoke":  {"ref": true},
	"type":    {"ref": true, "text": true},
}

// validateComputerAction 校验动作枚举与 payload 白名单键；违规 → 422 computer_invalid_args。
func validateComputerAction(kind string, payload map[string]any) error {
	if !computerCommandActions[kind] {
		return apiErr(422, "computer_invalid_args", "动作不在固定枚举内："+kind)
	}
	allowed := computerActionPayloadKeys[kind]
	for key := range payload {
		if !allowed[key] {
			return apiErr(422, "computer_invalid_args", "payload 含不允许的键："+key)
		}
	}
	if ref, _ := payload["ref"].(string); ref != "" {
		if !computerRefRe.MatchString(ref) {
			return apiErr(422, "computer_invalid_args", "ref 必须形如 @<snapshot_id>:e<N>")
		}
	}
	if text, _ := payload["text"].(string); text != "" {
		if len(text) > 32768 {
			return apiErr(422, "computer_invalid_args", "text 超过 32768 上限")
		}
		if !computerTextRe.MatchString(text) {
			return apiErr(422, "computer_invalid_args", "text 含不允许的控制字符")
		}
	}
	return nil
}

// runComputerCommand 是 run 内模型调用入口（/tools/computer/commands，P4-3 先挂路由）。
// 完整语义（查租约 → 确认闸门 → 建 queued → 同步等待）属 P4-4/P4-7；
// 本包只做入参校验并如实返回「尚未开放」，不假装执行，也不静默吞请求。
func (s *Server) runComputerCommand(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	var body struct {
		GrantID string         `json:"grant_id"`
		RunID   string         `json:"run_id"`
		Action  string         `json:"action"`
		Payload map[string]any `json:"payload"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	if err := validateComputerAction(body.Action, body.Payload); err != nil {
		return err
	}
	return apiErr(409, "computer_foreground_busy", "电脑控制命令执行尚未开放（P4-4 实现中）")
}
