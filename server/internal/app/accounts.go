package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/secure"
	"ops/internal/wechat"
)

type Account struct {
	ID             uuid.UUID  `json:"id"`
	Platform       string     `json:"platform"`
	Name           string     `json:"name"`
	ContentFormat  string     `json:"content_format"`
	TypeNote       string     `json:"type_note"`
	Status         string     `json:"status"`
	DailyPushLimit int        `json:"daily_push_limit"`
	CreatedAt      time.Time  `json:"created_at"`
	IsDemo         bool       `json:"is_demo"`
	Credential     *CredState `json:"credential,omitempty"`
}

type CredState struct {
	State       string     `json:"state"` // not_configured | ok | error | unchecked
	AppID       string     `json:"app_id,omitempty"`
	SecretMask  string     `json:"secret_mask,omitempty"`
	LastCheckAt *time.Time `json:"last_check_at,omitempty"`
	LastResult  string     `json:"last_result,omitempty"`
}

// formatMatrix 是账号类型（内容形态）的唯一权威清单（D-048 第 9 节，2026-10-10 确认）。
// 每个类型必须有真实工作流支持：qa_article/briefing/list_note/script 复用文字流＋专属模板，
// card_post 走逐卡 AI 生图流；类型在创建后固定（updateAccount 拒绝修改）。
var formatMatrix = map[string][]string{
	"wechat_mp": {"long_article", "qa_article", "briefing", "card_post", "script", "comic"},
	"xhs":       {"image_note", "list_note", "card_post", "script", "comic"},
}

func validFormat(platform, format string) bool {
	for _, f := range formatMatrix[platform] {
		if f == format {
			return true
		}
	}
	return false
}

const accountCols = `a.id, a.platform, a.name, a.content_format, a.type_note, a.status, a.daily_push_limit, a.created_at, a.is_demo,
	c.app_id, c.app_secret_enc, c.last_check_at, c.last_check_ok, c.last_check_result`

func (s *Server) scanAccount(row pgx.Row) (*Account, error) {
	var a Account
	var appID *string
	var secretEnc []byte
	var checkAt *time.Time
	var checkOK *bool
	var checkResult *string
	if err := row.Scan(&a.ID, &a.Platform, &a.Name, &a.ContentFormat, &a.TypeNote, &a.Status, &a.DailyPushLimit, &a.CreatedAt, &a.IsDemo,
		&appID, &secretEnc, &checkAt, &checkOK, &checkResult); err != nil {
		return nil, err
	}
	if a.Platform == "wechat_mp" {
		cs := &CredState{State: "not_configured"}
		if appID != nil {
			cs.AppID = *appID
			if plain, err := s.box.Decrypt(secretEnc); err == nil {
				cs.SecretMask = secure.Mask(plain)
			}
			cs.LastCheckAt = checkAt
			if checkResult != nil {
				cs.LastResult = *checkResult
			}
			switch {
			case checkOK == nil:
				cs.State = "unchecked"
			case *checkOK:
				cs.State = "ok"
			default:
				cs.State = "error"
			}
		}
		a.Credential = cs
	}
	return &a, nil
}

// account loads an account in the caller's workspace or returns not_found (06 文档第 4.3 节).
func (s *Server) account(ctx context.Context, id uuid.UUID) (*Account, error) {
	return s.scanAccount(s.db.QueryRow(ctx, `SELECT `+accountCols+` FROM platform_account a
		LEFT JOIN wechat_credential c ON c.account_id = a.id WHERE a.id=$1 AND a.workspace_id=$2`, id, ident(ctx).WorkspaceID))
}

func (s *Server) accountFromPath(r *http.Request) (*Account, error) {
	id, err := pathID(r, "accountId")
	if err != nil {
		return nil, err
	}
	return s.account(r.Context(), id)
}

func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.db.Query(r.Context(), `SELECT `+accountCols+` FROM platform_account a
		LEFT JOIN wechat_credential c ON c.account_id = a.id WHERE a.workspace_id=$1 ORDER BY a.created_at`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []*Account{}
	for rows.Next() {
		a, err := s.scanAccount(rows)
		if err != nil {
			return err
		}
		list = append(list, a)
	}
	return ok(w, list)
}

func (s *Server) createAccount(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	var in struct {
		Platform      string `json:"platform"`
		Name          string `json:"name"`
		ContentFormat string `json:"content_format"`
		TypeNote      string `json:"type_note"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return validation("请填写账号名称")
	}
	if _, ok := formatMatrix[in.Platform]; !ok {
		return validation("平台只能是公众号或小红书")
	}
	if !validFormat(in.Platform, in.ContentFormat) {
		return validation("该平台不支持这种内容类型（见账号类型说明）")
	}
	in.TypeNote = truncateRunes(strings.TrimSpace(in.TypeNote), 200)
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO platform_account (workspace_id, platform, name, content_format, type_note) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		ident(ctx).WorkspaceID, in.Platform, in.Name, in.ContentFormat, in.TypeNote).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO account_profile (account_id) VALUES ($1)`, id); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "account_create", "platform_account", id.String(), "ok", map[string]any{"platform": in.Platform, "name": in.Name})
	a, err := s.account(ctx, id)
	if err != nil {
		return err
	}
	return ok(w, a)
}

func (s *Server) getAccount(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	return ok(w, a)
}

func (s *Server) updateAccount(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Name           *string `json:"name"`
		ContentFormat  *string `json:"content_format"`
		TypeNote       *string `json:"type_note"`
		DailyPushLimit *int    `json:"daily_push_limit"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Name != nil {
		a.Name = strings.TrimSpace(*in.Name)
		if a.Name == "" {
			return validation("请填写账号名称")
		}
	}
	// D-048 第 5.2 节：账号类型创建后固定，普通更新不接受类型变更，confirm 也不能绕过。
	if in.ContentFormat != nil && *in.ContentFormat != a.ContentFormat {
		return validation("账号类型在创建后不可修改。如需其他类型，请另建新账号；本账号的业务资料仍可继续修改。")
	}
	if in.TypeNote != nil {
		a.TypeNote = truncateRunes(strings.TrimSpace(*in.TypeNote), 200)
	}
	if in.DailyPushLimit != nil {
		if *in.DailyPushLimit < 1 || *in.DailyPushLimit > 20 {
			return validation("每日推送上限需在 1 到 20 之间，不能关闭")
		}
		a.DailyPushLimit = *in.DailyPushLimit
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE platform_account SET name=$2, content_format=$3, type_note=$4, daily_push_limit=$5, updated_at=now() WHERE id=$1`,
		a.ID, a.Name, a.ContentFormat, a.TypeNote, a.DailyPushLimit); err != nil {
		return err
	}
	s.audit(r.Context(), "account_update", "platform_account", a.ID.String(), "ok", nil)
	a, err = s.account(r.Context(), a.ID)
	if err != nil {
		return err
	}
	return ok(w, a)
}

func (s *Server) setAccountStatus(status string) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		if err := s.requireOwner(r.Context()); err != nil {
			return err
		}
		a, err := s.accountFromPath(r)
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(r.Context(), `UPDATE platform_account SET status=$2, updated_at=now() WHERE id=$1`, a.ID, status); err != nil {
			return err
		}
		s.audit(r.Context(), "account_"+status, "platform_account", a.ID.String(), "ok", nil)
		return ok(w, map[string]any{"ok": true})
	}
}

// deleteAccount permanently removes a platform account and its owned content (D-037).
func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("confirm") != "true" {
		return apiErr(409, "confirm_required", "删除后该账号下的作品、选题、档案、凭证等将一并清除且无法恢复，请确认。")
	}
	ctx := r.Context()
	if err := s.hardDeleteAccount(ctx, a.ID); err != nil {
		return err
	}
	s.audit(ctx, "account_delete", "platform_account", a.ID.String(), "ok", map[string]any{"name": a.Name, "platform": a.Platform})
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) hardDeleteAccount(ctx context.Context, accountID uuid.UUID) error {
	a := struct{ ID uuid.UUID }{accountID}
	var workIDs []uuid.UUID
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		rows, qerr := tx.Query(ctx, `SELECT id FROM work WHERE account_id=$1`, a.ID)
		if qerr != nil {
			return qerr
		}
		workIDs, qerr = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if qerr != nil {
			return qerr
		}
		steps := []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM daily_recommendation WHERE account_id=$1`, []any{a.ID}},
			{`DELETE FROM account_ops_activity WHERE account_id=$1`, []any{a.ID}},
			{`DELETE FROM account_daily_claim WHERE account_id=$1`, []any{a.ID}},
			{`UPDATE reference_item r SET account_id=(SELECT ar.account_id FROM account_reference ar WHERE ar.reference_id=r.id AND ar.account_id<>$1 LIMIT 1) WHERE r.account_id=$1 AND EXISTS(SELECT 1 FROM account_reference ar WHERE ar.reference_id=r.id AND ar.account_id<>$1)`, []any{a.ID}},
			{`DELETE FROM reference_item WHERE account_id=$1`, []any{a.ID}},
			{`DELETE FROM push_record WHERE account_id=$1`, []any{a.ID}},
			{`UPDATE topic SET review_report_id=NULL WHERE account_id=$1`, []any{a.ID}},
			{`DELETE FROM review_report WHERE account_id=$1`, []any{a.ID}},
			{`UPDATE work SET source_work_id=NULL WHERE account_id=$1`, []any{a.ID}},
			{`UPDATE work SET topic_id=NULL, cover_asset_id=NULL WHERE account_id=$1`, []any{a.ID}},
			{`UPDATE character_card SET ref_asset_id=NULL WHERE account_id=$1`, []any{a.ID}},
			{`DELETE FROM work WHERE account_id=$1`, []any{a.ID}},
			{`DELETE FROM topic WHERE account_id=$1`, []any{a.ID}},
			{`DELETE FROM style_sample WHERE account_id=$1`, []any{a.ID}},
			{`DELETE FROM character_card WHERE account_id=$1`, []any{a.ID}},
			{`UPDATE material SET account_id=NULL WHERE account_id=$1`, []any{a.ID}},
			{`UPDATE asset SET account_id=NULL WHERE account_id=$1`, []any{a.ID}},
			{`UPDATE ai_call SET account_id=NULL WHERE account_id=$1`, []any{a.ID}},
			{`UPDATE ai_job SET account_id=NULL WHERE account_id=$1`, []any{a.ID}},
			{`DELETE FROM platform_account WHERE id=$1`, []any{a.ID}},
		}
		for _, step := range steps {
			if _, err := tx.Exec(ctx, step.sql, step.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, wid := range workIDs {
		_ = os.RemoveAll(filepath.Join(s.cfg.DataDir, "assets", wid.String()))
	}
	return nil
}

func (s *Server) saveWechatCredential(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	if err := s.requireReauth(r.Context()); err != nil {
		return err
	}
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if a.Platform != "wechat_mp" {
		return validation("只有公众号需要配置凭证")
	}
	var in struct {
		AppID     string `json:"app_id"`
		AppSecret string `json:"app_secret"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.AppID, in.AppSecret = strings.TrimSpace(in.AppID), strings.TrimSpace(in.AppSecret)
	if in.AppID == "" || in.AppSecret == "" {
		return validation("请填写 AppID 和 AppSecret")
	}
	enc, err := s.box.Encrypt(in.AppSecret)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.db.Exec(ctx, `INSERT INTO wechat_credential (account_id, app_id, app_secret_enc, key_version)
		VALUES ($1,$2,$3,$4) ON CONFLICT (account_id) DO UPDATE SET app_id=$2, app_secret_enc=$3, key_version=$4,
		last_check_at=NULL, last_check_ok=NULL, last_check_result='', updated_at=now()`, a.ID, in.AppID, enc, s.box.Version); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM wechat_token WHERE account_id=$1`, a.ID); err != nil {
		return err
	}
	s.audit(ctx, "credential_update", "platform_account", a.ID.String(), "ok", map[string]any{"app_id": in.AppID})
	a, err = s.account(ctx, a.ID)
	if err != nil {
		return err
	}
	return ok(w, a)
}

func (s *Server) egressHint() string {
	if s.cfg.PublicIP != "" {
		return s.cfg.PublicIP
	}
	if s.cfg.Dev {
		return "本地开发（使用模拟微信服务器，无需白名单）"
	}
	return "未配置（请设置 OPS_PUBLIC_IP）"
}

func (s *Server) testWechatCredential(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var appID string
	var enc []byte
	if err := s.db.QueryRow(ctx, `SELECT app_id, app_secret_enc FROM wechat_credential WHERE account_id=$1`, a.ID).Scan(&appID, &enc); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return validation("请先填写 AppID 和 AppSecret")
		}
		return err
	}
	secret, err := s.box.Decrypt(enc)
	if err != nil {
		return err
	}
	tok, err := s.wx.GetToken(ctx, appID, secret)
	result, okFlag := "连接正常，已成功获取 access_token", true
	if err != nil {
		okFlag = false
		var we *wechat.Error
		if errors.As(err, &we) {
			result = we.Readable()
			if we.Code == 40164 {
				result += "（需要添加的 IP：" + s.egressHint() + "）"
			}
		} else {
			result = err.Error()
		}
	} else {
		enc, err := s.box.Encrypt(tok.AccessToken)
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO wechat_token (account_id, access_token_enc, key_version, expires_at) VALUES ($1,$2,$3,$4)
			ON CONFLICT (account_id) DO UPDATE SET access_token_enc=$2, key_version=$3, expires_at=$4`,
			a.ID, enc, s.box.Version, s.now().Add(time.Duration(tok.ExpiresIn)*time.Second)); err != nil {
			return err
		}
	}
	if _, err := s.db.Exec(ctx, `UPDATE wechat_credential SET last_check_at=now(), last_check_ok=$2, last_check_result=$3 WHERE account_id=$1`,
		a.ID, okFlag, result); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": okFlag, "message": result})
}

// accessToken returns a cached token, refreshing it under a row lock (F-011, 06 文档第 5.3 节).
func (s *Server) accessToken(ctx context.Context, accountID uuid.UUID, force bool) (string, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var appID string
	var secretEnc []byte
	if err := tx.QueryRow(ctx, `SELECT app_id, app_secret_enc FROM wechat_credential WHERE account_id=$1 FOR UPDATE`, accountID).
		Scan(&appID, &secretEnc); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", apiErr(409, "wechat_error", "公众号凭证未配置，请到平台账号页填写 AppID 和 AppSecret")
		}
		return "", err
	}
	if !force {
		var enc []byte
		var exp time.Time
		err := tx.QueryRow(ctx, `SELECT access_token_enc, expires_at FROM wechat_token WHERE account_id=$1`, accountID).Scan(&enc, &exp)
		if err == nil && exp.After(s.now().Add(10*time.Minute)) {
			return s.box.Decrypt(enc)
		}
	}
	secret, err := s.box.Decrypt(secretEnc)
	if err != nil {
		return "", err
	}
	tok, err := s.wx.GetToken(ctx, appID, secret)
	if err != nil {
		return "", err
	}
	enc, err := s.box.Encrypt(tok.AccessToken)
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO wechat_token (account_id, access_token_enc, key_version, expires_at) VALUES ($1,$2,$3,$4)
		ON CONFLICT (account_id) DO UPDATE SET access_token_enc=$2, key_version=$3, expires_at=$4`,
		accountID, enc, s.box.Version, s.now().Add(time.Duration(tok.ExpiresIn)*time.Second)); err != nil {
		return "", err
	}
	return tok.AccessToken, tx.Commit(ctx)
}

func (s *Server) systemInfo(w http.ResponseWriter, r *http.Request) error {
	var size int64
	_ = filepath.Walk(s.cfg.DataDir, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			size += info.Size()
		}
		return nil
	})
	backend := "https://mp.weixin.qq.com/"
	if s.cfg.Dev {
		backend = "http://" + s.cfg.MockListen + "/mock/drafts"
	}
	return ok(w, map[string]any{
		"egress_ip":      s.egressHint(),
		"version":        Version,
		"dev":            s.cfg.Dev,
		"data_bytes":     size,
		"wechat_backend": backend,
	})
}
