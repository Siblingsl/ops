package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5"
)

// DEV-CX13-F / FR-CX-23：运营标准版本表。
// 软口径快照：定位说明不回写 profile、DNA 只引用不可变版本、软规则不覆盖 M9 硬检查。
// 版本不可修改/删除，只能新增；archive 只变列表可见性。
const standardsListPage = 20

type textRule struct {
	Text string `json:"text"`
}

type visualRules struct {
	PreferredRatio *string `json:"preferred_ratio,omitempty"`
	MinImagesHint  *int    `json:"min_images_hint,omitempty"`
	DNAVersion     *int    `json:"dna_version"`
}

type opsStandard struct {
	ID            uuid.UUID   `json:"id"`
	AccountID     uuid.UUID   `json:"account_id"`
	Version       int         `json:"version"`
	Positioning   string      `json:"positioning"`
	TextRules     []textRule  `json:"text_rules"`
	VisualRules   visualRules `json:"visual_rules"`
	ContentHash   string      `json:"content_hash"`
	EffectiveFrom string      `json:"effective_from"`
	ArchivedAt    *time.Time  `json:"archived_at"`
	CreatedAt     time.Time   `json:"created_at"`
}

const opsStandardCols = `id,account_id,version,positioning,text_rules,visual_rules,content_hash,effective_from::text,archived_at,created_at`

func scanOpsStandard(row pgx.Row) (opsStandard, error) {
	var item opsStandard
	var textRules, visualRules []byte
	if err := row.Scan(&item.ID, &item.AccountID, &item.Version, &item.Positioning, &textRules, &visualRules,
		&item.ContentHash, &item.EffectiveFrom, &item.ArchivedAt, &item.CreatedAt); err != nil {
		return item, err
	}
	if len(textRules) > 0 {
		if err := json.Unmarshal(textRules, &item.TextRules); err != nil {
			return item, err
		}
	}
	if len(visualRules) > 0 {
		if err := json.Unmarshal(visualRules, &item.VisualRules); err != nil {
			return item, err
		}
	}
	return item, nil
}

// standardContentHash：定位说明/规则/生效日/DNA 引用（不含归档标记）。
func standardContentHash(positioning string, rules []textRule, visual visualRules, effectiveFrom string) string {
	payload, _ := json.Marshal(map[string]any{"positioning": positioning, "text_rules": rules, "visual_rules": visual, "effective_from": effectiveFrom})
	return cxSHA256(payload)
}

func validateStandardFields(positioning string, rules []textRule, visual visualRules) error {
	if len([]rune(positioning)) > 500 {
		return validation("定位说明最多 500 码点（不回写 profile）")
	}
	if len(rules) > 20 {
		return validation("文本规则最多 20 条")
	}
	for _, rule := range rules {
		if n := len([]rune(strings.TrimSpace(rule.Text))); n < 1 || n > 200 {
			return validation("文本规则每条须为 1..200 码点")
		}
	}
	if visual.DNAVersion != nil && *visual.DNAVersion < 1 {
		return validation("DNA 版本引用必须为正整数（只引用不可变版本）")
	}
	if visual.PreferredRatio != nil && *visual.PreferredRatio != "1:1" && *visual.PreferredRatio != "3:4" && *visual.PreferredRatio != "9:16" {
		return validation("preferred_ratio 枚举不正确")
	}
	if visual.MinImagesHint != nil && (*visual.MinImagesHint < 0 || *visual.MinImagesHint > 20) {
		return validation("min_images_hint 须为 0..20 的软提示")
	}
	return nil
}

// listStandards：最近 20 版，不含已归档（归档历史走 /standards/{version} 仍可解析）。
func (s *Server) listStandards(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+opsStandardCols+` FROM ops_standard
		WHERE account_id=$1 AND archived_at IS NULL ORDER BY version DESC LIMIT $2`, account.ID, standardsListPage)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []opsStandard{}
	for rows.Next() {
		item, scanErr := scanOpsStandard(rows)
		if scanErr != nil {
			return scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{"items": items})
}

// createStandard：owner；base_version CAS 锁账号分配 +1；effective_from 可为未来日期。
func (s *Server) createStandard(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		BaseVersion   int         `json:"base_version"`
		Positioning   string      `json:"positioning"`
		TextRules     []textRule  `json:"text_rules"`
		VisualRules   visualRules `json:"visual_rules"`
		EffectiveFrom string      `json:"effective_from"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if _, err := time.Parse("2006-01-02", in.EffectiveFrom); err != nil {
		return validation("effective_from 须为 YYYY-MM-DD（账号时区日期）")
	}
	if err := validateStandardFields(in.Positioning, in.TextRules, in.VisualRules); err != nil {
		return err
	}
	// DNA 版本引用必须属于本账号。
	if in.VisualRules.DNAVersion != nil {
		var dnaOK bool
		if err := s.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM account_visual_dna
			WHERE account_id=$1 AND version=$2)`, account.ID, *in.VisualRules.DNAVersion).Scan(&dnaOK); err != nil {
			return err
		}
		if !dnaOK {
			return validation("引用的视觉 DNA 版本不属于当前账号")
		}
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// 锁账号行串行化版本分配。
	if _, err := tx.Exec(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1 FOR UPDATE`, account.ID); err != nil {
		return err
	}
	var currentVersion int
	if err := tx.QueryRow(ctx, `SELECT coalesce(max(version),0) FROM ops_standard WHERE account_id=$1`, account.ID).Scan(&currentVersion); err != nil {
		return err
	}
	if in.BaseVersion != currentVersion {
		return apiErr(409, "version_conflict", "标准已被他人新增，请刷新后重试")
	}
	hash := standardContentHash(in.Positioning, in.TextRules, in.VisualRules, in.EffectiveFrom)
	item, err := scanOpsStandard(tx.QueryRow(ctx, `INSERT INTO ops_standard (workspace_id,account_id,version,positioning,text_rules,visual_rules,content_hash,effective_from,created_by)
		VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)
		RETURNING `+opsStandardCols,
		ident(ctx).WorkspaceID, account.ID, currentVersion+1, strings.TrimSpace(in.Positioning),
		mustJSONText(in.TextRules), mustJSONText(in.VisualRules), hash, in.EffectiveFrom, ident(ctx).UserID))
	if err != nil {
		// 同日唯一约束 → 并发冲突 409。
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return apiErr(409, "standard_exists", "该生效日期或版本号已有标准")
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "ops_standard_create", "ops_standard", item.ID.String(), "ok", map[string]any{"version": item.Version})
	writeJSON(w, http.StatusCreated, item)
	return nil
}

func mustJSONText(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

// getStandard：历史内容（含已归档版本）。
func (s *Server) getStandard(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	version, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || version < 1 {
		return validation("版本号格式不正确")
	}
	item, err := scanOpsStandard(s.db.QueryRow(r.Context(), `SELECT `+opsStandardCols+` FROM ops_standard
		WHERE account_id=$1 AND version=$2`, account.ID, version))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	return ok(w, item)
}

// effectiveStandard：?at=YYYY-MM-DD（显式时区日期）取 effective_from≤at 的最大者；
// 归档不影响解析；无标准 200 {standard:null}。
func (s *Server) effectiveStandard(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	at := strings.TrimSpace(r.URL.Query().Get("at"))
	if at == "" {
		return validation("需要 ?at=YYYY-MM-DD（显式时区日期）")
	}
	if _, err := time.Parse("2006-01-02", at); err != nil {
		return validation("at 须为 YYYY-MM-DD")
	}
	item, err := scanOpsStandard(s.db.QueryRow(r.Context(), `SELECT `+opsStandardCols+` FROM ops_standard
		WHERE account_id=$1 AND effective_from<=($2::date) ORDER BY effective_from DESC, version DESC LIMIT 1`,
		account.ID, at))
	if errors.Is(err, pgx.ErrNoRows) {
		return ok(w, map[string]any{"standard": nil, "timezone": "Asia/Shanghai"})
	}
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"standard": item, "timezone": "Asia/Shanghai"})
}

// archiveStandard：owner；只变列表可见性（单项确认由前端二次点击保障），不改内容/生效语义。
func (s *Server) archiveStandard(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	version, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || version < 1 {
		return validation("版本号格式不正确")
	}
	var in struct {
		Archived bool `json:"archived"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var archivedAt *time.Time
	if in.Archived {
		now := s.now()
		archivedAt = &now
	}
	tag, err := s.db.Exec(ctx, `UPDATE ops_standard SET archived_at=$3 WHERE account_id=$1 AND version=$2`,
		account.ID, version, archivedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.audit(ctx, "ops_standard_archive", "ops_standard", account.ID.String()+"/"+strconv.Itoa(version), "ok", map[string]any{"archived": in.Archived})
	item, err := scanOpsStandard(s.db.QueryRow(ctx, `SELECT `+opsStandardCols+` FROM ops_standard
		WHERE account_id=$1 AND version=$2`, account.ID, version))
	if err != nil {
		return err
	}
	return ok(w, item)
}

// freezeStandardBasis：检查启动时冻结标准快照到 check_run（后来变化不重算历史结论）。
// 无标准显示未设，不阻断。
func (s *Server) freezeStandardBasis(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) (json.RawMessage, error) {
	item, err := scanOpsStandard(tx.QueryRow(ctx, `SELECT `+opsStandardCols+` FROM ops_standard
		WHERE account_id=$1 AND effective_from<=(now() AT TIME ZONE 'Asia/Shanghai')::date
		ORDER BY effective_from DESC, version DESC LIMIT 1`, accountID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	basis, err := json.Marshal(map[string]any{
		"standard_id": item.ID, "version": item.Version, "content_hash": item.ContentHash,
		"account_timezone": "Asia/Shanghai", "checked_at": time.Now().Format("2006-01-02"),
	})
	if err != nil {
		return nil, err
	}
	return basis, nil
}
