package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// cxAuthorizeAccountAnalysis must be called before generation and again after
// the model returns. The later report write still needs an atomic final check.
func (s *Server) cxAuthorizeAccountAnalysis(ctx context.Context, accountID uuid.UUID) (*identity, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	actor := ident(ctx)
	if actor == nil || actor.SessionID == uuid.Nil || actor.UserID == uuid.Nil || actor.WorkspaceID == uuid.Nil {
		return nil, errUnauthenticated
	}
	live, err := s.loadIdentityBySession(ctx, actor.SessionID)
	if err != nil {
		return nil, err
	}
	if live.UserID != actor.UserID || live.WorkspaceID != actor.WorkspaceID {
		return nil, errUnauthenticated
	}
	// CX requires an active member even when the session has an admin override.
	var role string
	err = s.db.QueryRow(ctx, `SELECT role FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 AND status='active'`, live.WorkspaceID, live.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errUnauthenticated
	}
	if err != nil {
		return nil, err
	}
	live.Role, live.AdminOverride = role, false
	if err := s.requireEditor(context.WithValue(ctx, ctxMember, live)); err != nil {
		return nil, err
	}
	var status string
	err = s.db.QueryRow(ctx, `SELECT status FROM platform_account WHERE id=$1 AND workspace_id=$2`, accountID, live.WorkspaceID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if status != "active" {
		return nil, apiErr(http.StatusConflict, "account_disabled", "账号已停用，请先启用账号再生成")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return live, nil
}

// cxRevalidateAccountAnalysis is an early post-model check. The final report
// persistence path must separately enforce an atomic check with its write;
// this function alone cannot serialize concurrent changes with insertion.
func (s *Server) cxRevalidateAccountAnalysis(ctx context.Context, receipt cxBasisReceipt, refs []cxPlatformWorkRef, through time.Time, options cxAccountBasisOptions) error {
	actor, err := s.cxAuthorizeAccountAnalysis(ctx, receipt.AccountID)
	if err != nil {
		return err
	}
	current, err := s.cxAssembleAccountBasisWithOptions(ctx, actor.WorkspaceID, receipt.AccountID, refs, through, options)
	if err != nil {
		var ae *APIError
		if errors.Is(err, pgx.ErrNoRows) || errors.As(err, &ae) && ae.Status == http.StatusNotFound {
			return apiErr(http.StatusConflict, "version_conflict", "分析依据已变化，请刷新后重试")
		}
		return err
	}
	if _, err := s.cxAuthorizeAccountAnalysis(ctx, receipt.AccountID); err != nil {
		return err
	}
	if receipt.InputHash == "" || current.Receipt.InputHash != receipt.InputHash {
		return apiErr(http.StatusConflict, "version_conflict", "分析依据已变化，请刷新后重试")
	}
	return ctx.Err()
}

// cxAccountAnalysisOutput is model output only. Source values, versions and
// numeric facts must be supplied separately by the server from the basis.
type cxAccountAnalysisOutput struct {
	Overview string                     `json:"overview"`
	Pillars  []string                   `json:"pillars"`
	Findings []cxAccountAnalysisFinding `json:"findings"`
	Actions  []cxAccountAnalysisAction  `json:"actions"`
	Unknowns []cxAccountAnalysisUnknown `json:"unknowns"`
}

type cxAccountAnalysisFinding struct {
	Area       string   `json:"area"`
	Message    string   `json:"message"`
	SourceRefs []string `json:"source_refs"`
	Hypothesis *bool    `json:"hypothesis"`
}

type cxAccountAnalysisAction struct {
	Priority   string   `json:"priority"`
	Proposal   string   `json:"proposal"`
	SourceRefs []string `json:"source_refs"`
	Hypothesis *bool    `json:"hypothesis"`
}

type cxAccountAnalysisUnknown struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

// runAIJSON uses json.Unmarshal. A task-specific decoder preserves existing
// tasks' compatibility while rejecting unknown fields at every object level.
func (o *cxAccountAnalysisOutput) UnmarshalJSON(raw []byte) error {
	type plain cxAccountAnalysisOutput
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("账号分析输出包含多个 JSON 值")
		}
		return err
	}
	*o = cxAccountAnalysisOutput(value)
	return nil
}

func cxRejectDuplicateJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := cxScanJSONValue(decoder, 0); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("账号分析输出包含多个 JSON 值")
		}
		return err
	}
	return nil
}

func cxScanJSONValue(decoder *json.Decoder, depth int) error {
	if depth > 64 {
		return errors.New("账号分析输出 JSON 嵌套过深")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("账号分析输出包含无效对象键")
			}
			if _, exists := seen[key]; exists {
				return errors.New("账号分析输出包含重复字段")
			}
			seen[key] = struct{}{}
			if err := cxScanJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return errors.New("账号分析输出包含未闭合对象")
		}
	case '[':
		for decoder.More() {
			if err := cxScanJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return errors.New("账号分析输出包含未闭合数组")
		}
	default:
		return errors.New("账号分析输出包含无效 JSON 分隔符")
	}
	return nil
}

var (
	cxUnsafeLinkPattern   = regexp.MustCompile(`(?i)(https?\s*:\s*/\s*/|hxxps?\s*:\s*/\s*/|www\s*[.。]|javascript\s*:|\]\s*\()`)
	cxNumericClaimPattern = regexp.MustCompile(`(?:第[零〇一二三四五六七八九十百千万亿两]+|百分之\s*[零〇一二三四五六七八九十百千万亿两]+|[零〇一二三四五六七八九十百千万亿两]+(?:余|多|几)?\s*(粉丝|关注者|人|篇|条|个|次|项|类|种|方面|组|%|％|百分之|百分点|倍|秒|分钟|小时|天|周|月|年|阅读|浏览|点赞|收藏|评论|转发|分享|增长|涨粉|万|千|亿|元|分|第))`)
	cxUnsafeActionPattern = regexp.MustCompile(`(?i)(发布|定时|批量|全部|一键|自动|执行|脚本|接口调用|上传|删除|publish|schedule|execute|\brun\b)`)
)

func cxSafeOutputText(value string, max int) bool {
	if strings.TrimSpace(value) == "" || utf8.RuneCountInString(value) > max || cxUnsafeLinkPattern.MatchString(value) || cxNumericClaimPattern.MatchString(value) {
		return false
	}
	for _, r := range value {
		if r == '<' || r == '>' || unicode.IsControl(r) && r != '\n' && r != '\t' || unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

// validate covers the structural and reference contract only. Before this is
// exposed, the caller must separately validate factual/numeric claims against
// the frozen basis and enforce the complete action safety contract.
func (o *cxAccountAnalysisOutput) validate(allowedRefs map[string]struct{}) error {
	invalid := errors.New("账号分析输出不符合结构或来源约束")
	validText := func(value string, max int) bool {
		return cxSafeOutputText(value, max)
	}
	validRefs := func(refs []string, hypothesis *bool) bool {
		if refs == nil || hypothesis == nil || len(refs) > 10 || (!*hypothesis && len(refs) == 0) {
			return false
		}
		seen := make(map[string]struct{}, len(refs))
		for _, ref := range refs {
			if _, ok := allowedRefs[ref]; !ok {
				return false
			}
			if _, duplicate := seen[ref]; duplicate {
				return false
			}
			seen[ref] = struct{}{}
		}
		return true
	}
	if !validText(o.Overview, 500) || o.Pillars == nil || o.Findings == nil || o.Actions == nil || o.Unknowns == nil || len(o.Pillars) > 8 || len(o.Findings) > 10 || len(o.Actions) > 10 || len(o.Unknowns) > 20 {
		return invalid
	}
	for _, pillar := range o.Pillars {
		if !validText(pillar, 100) {
			return invalid
		}
	}
	for _, finding := range o.Findings {
		// Model-authored prose stays a hypothesis; verified facts are rendered from server data.
		switch finding.Area {
		case "positioning", "content", "visual", "performance":
		default:
			return invalid
		}
		if !validText(finding.Message, 300) || !validRefs(finding.SourceRefs, finding.Hypothesis) || !*finding.Hypothesis {
			return invalid
		}
	}
	for _, action := range o.Actions {
		switch action.Priority {
		case "high", "medium", "low":
		default:
			return invalid
		}
		if !validText(action.Proposal, 300) || cxUnsafeActionPattern.MatchString(action.Proposal) || !validRefs(action.SourceRefs, action.Hypothesis) {
			return invalid
		}
	}
	for _, unknown := range o.Unknowns {
		if !validText(unknown.Field, 100) || !validText(unknown.Reason, 300) {
			return invalid
		}
	}
	return nil
}
