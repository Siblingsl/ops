package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/cxcanonicaljson"
	"ops/internal/cxrendercontract"
	"ops/internal/markdownsyntax"
)

var cxBuildTargetOrder = []string{"wechat_html", "stable_html", "long_image", "xhs_cards", "cover_images"}

type cxBuildCreateInput struct {
	BasisRevision           int             `json:"basis_revision"`
	Targets                 []string        `json:"targets"`
	Options                 json.RawMessage `json:"options"`
	Client                  string          `json:"client"`
	RendererContractVersion string          `json:"renderer_contract_version"`
	// Force：跳过可复用命中，强制新建 running（DEEP-01「重新生成」）。
	Force bool `json:"force"`
}

type cxBuildCreateResponse struct {
	BuildID        uuid.UUID       `json:"build_id"`
	Status         string          `json:"status"`
	SourceHash     string          `json:"source_hash"`
	ParamsHash     string          `json:"params_hash"`
	BasisRevision  int             `json:"basis_revision"`
	SourceSnapshot json.RawMessage `json:"source_snapshot"`
	DeadlineAt     time.Time       `json:"deadline_at"`
	ExpiresAt      *time.Time      `json:"expires_at"`
	Reused         bool            `json:"reused"`
	// ReusedFrom：命中可复用历史时回填来源 build_id（与 build_id 相同；旧客户端可忽略）。
	ReusedFrom *uuid.UUID `json:"reused_from,omitempty"`
}

func decodeCXBuildJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return validation("构建请求格式不正确")
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return validation("构建请求必须只有一个 JSON 对象")
	}
	return nil
}

func normalizeCXBuildTargets(input []string) ([]string, error) {
	if len(input) == 0 || len(input) > 64 {
		return nil, apiErr(http.StatusUnprocessableEntity, "target_not_allowed", "请选择一个或多个有效的构建产物")
	}
	selected := make(map[string]bool, len(input))
	for _, target := range input {
		known := false
		for _, allowed := range cxBuildTargetOrder {
			if target == allowed {
				known = true
				break
			}
		}
		if !known {
			return nil, apiErr(http.StatusUnprocessableEntity, "target_not_allowed", "包含未支持的构建产物")
		}
		selected[target] = true
	}
	ordered := make([]string, 0, len(selected))
	for _, target := range cxBuildTargetOrder {
		if selected[target] {
			ordered = append(ordered, target)
		}
	}
	return ordered, nil
}

func decodeCXBuildOptions(raw json.RawMessage, targets []string) (map[string]any, cxBuildCardsOptions, cxBuildCoverOptions, error) {
	var cardsOptions cxBuildCardsOptions
	var coverOptions cxBuildCoverOptions
	hasCards, hasCover := false, false
	for _, target := range targets {
		if target == "xhs_cards" {
			hasCards = true
		}
		if target == "cover_images" {
			hasCover = true
		}
	}
	if !hasCards && !hasCover {
		if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return map[string]any{}, cardsOptions, coverOptions, nil
		}
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		var options map[string]any
		if err := dec.Decode(&options); err != nil || options == nil {
			return nil, cardsOptions, coverOptions, validation("构建 options 必须为对象")
		}
		var extra any
		if err := dec.Decode(&extra); err != io.EOF {
			return nil, cardsOptions, coverOptions, validation("构建 options 格式不正确")
		}
		if len(options) != 0 {
			return nil, cardsOptions, coverOptions, validation("当前阶段不接受尚未登记的构建 options")
		}
		return options, cardsOptions, coverOptions, nil
	}
	// 专用目标只接受各自已登记的 options，且不能与其他产物目标混在一次构建里：
	// options 的语义按目标分派，混合会让同一字段在两个目标下含义不同。
	if len(targets) != 1 {
		if hasCards {
			return nil, cardsOptions, coverOptions, validation("组图构建不能与其他产物目标混合")
		}
		return nil, cardsOptions, coverOptions, validation("封面构建不能与其他产物目标混合")
	}
	if hasCards {
		if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil, cardsOptions, coverOptions, validationFields("组图构建必须提交已确认的卡片计划", map[string]string{"options": "required"})
		}
		if err := json.Unmarshal(raw, &cardsOptions); err != nil {
			return nil, cardsOptions, coverOptions, validation("组图构建 options 字段无效或包含未登记字段")
		}
		if err := cxValidateCardsBuildOptions(cardsOptions); err != nil {
			return nil, cardsOptions, coverOptions, err
		}
		value, err := cxCardsBuildOptionValue(cardsOptions)
		if err != nil {
			return nil, cardsOptions, coverOptions, err
		}
		return value, cardsOptions, coverOptions, nil
	}
	// cover_images：presets 以平台+像素标识，服务端固定为设计顺序后再进冻结参数。
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, cardsOptions, coverOptions, validationFields("封面构建必须提交 cover_presets 预设集合", map[string]string{"options": "required"})
	}
	if err := json.Unmarshal(raw, &coverOptions); err != nil {
		return nil, cardsOptions, coverOptions, validation("封面构建 options 字段无效或包含未登记字段")
	}
	value, err := cxCoverBuildOptionValue(coverOptions)
	if err != nil {
		return nil, cardsOptions, coverOptions, err
	}
	return value, cardsOptions, coverOptions, nil
}

func cxTargetAllowed(platform, contentFormat, target string) bool {
	switch target {
	case "wechat_html", "stable_html", "long_image":
		return platform == "wechat_mp" && (contentFormat == "long_article" || contentFormat == "qa_article" || contentFormat == "briefing")
	case "xhs_cards":
		return platform == "xhs" && (contentFormat == "image_note" || contentFormat == "list_note" || contentFormat == "card_post")
	case "cover_images":
		return (platform == "wechat_mp" || platform == "xhs") && contentFormat != "script" && contentFormat != "micro_post"
	default:
		return false
	}
}

func (s *Server) createCXBuild(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in cxBuildCreateInput
	if err := decodeCXBuildJSON(w, r, &in); err != nil {
		return err
	}
	if in.BasisRevision < 1 {
		return validation("请提供当前作品版本")
	}
	if in.Client != "web" && in.Client != "desktop" {
		return validationFields("构建客户端标识无效", map[string]string{"client": "仅支持 web 或 desktop"})
	}
	targets, err := normalizeCXBuildTargets(in.Targets)
	if err != nil {
		return err
	}
	// 排版契约按产物类型分别登记：公众号 HTML 走 wechat-html/v1，组图走 ops.xhs-cards/v1，封面走 ops.cover-images/v1。
	if cxHasCXBuildTarget(targets, "xhs_cards") {
		if in.RendererContractVersion != cxCardsTemplateVersion {
			return apiErr(http.StatusConflict, "renderer_version_mismatch", "当前服务端未登记此组图模板版本")
		}
	} else if cxHasCXBuildTarget(targets, "cover_images") {
		if in.RendererContractVersion != cxCoverTemplateVersion {
			return apiErr(http.StatusConflict, "renderer_version_mismatch", "当前服务端未登记此封面契约版本")
		}
	} else if !cxrendercontract.SupportsWechatHTML(in.RendererContractVersion) {
		return apiErr(http.StatusConflict, "renderer_version_mismatch", "当前服务端未登记此排版契约版本")
	}
	options, cardsOptions, coverOptions, err := decodeCXBuildOptions(in.Options, targets)
	if err != nil {
		return err
	}

	ctx := r.Context()
	workspaceID := ident(ctx).WorkspaceID
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	buildLockKey := "cx-build-create:" + workID.String()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1,0))`, buildLockKey); err != nil {
		return err
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, buildLockKey); err != nil {
			slog.Error("释放构建创建锁失败，将关闭数据库连接", "work_id", workID, "err", err)
			lockedConn := conn.Hijack()
			_ = lockedConn.Close(unlockCtx)
		}
	}()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	snapshot, revision, platform, contentFormat, err := cxBuildSourceSnapshot(ctx, tx, workspaceID, workID, in.BasisRevision, true, cardsOptions.DNAVersion)
	if err != nil {
		return err
	}
	var accountStatus string
	if err := tx.QueryRow(ctx, `SELECT a.status FROM work w JOIN platform_account a ON a.id=w.account_id WHERE w.id=$1 AND a.workspace_id=$2`, workID, workspaceID).Scan(&accountStatus); err != nil {
		return err
	}
	if accountStatus != "active" {
		return apiErr(http.StatusConflict, "account_inactive", "账号已停用，不能创建新的内容构建")
	}
	for _, target := range targets {
		if !cxTargetAllowed(platform, contentFormat, target) {
			return apiErr(http.StatusUnprocessableEntity, "target_not_allowed", "所选产物不适用于此平台或作品形态")
		}
	}
	// 语法预检只服务公众号 HTML 排版；组图卡片是纯文本、封面是既有图片的裁剪输出，
	// 都不因公众号语法规则阻断。
	if cxHasCXBuildTarget(targets, "xhs_cards") {
		if platform != "xhs" {
			return apiErr(http.StatusUnprocessableEntity, "target_not_allowed", "组图构建仅适用于小红书作品")
		}
		if err := cxValidateCardsBuildAgainstSnapshot(cardsOptions.Cards, snapshot); err != nil {
			return err
		}
		// 计划引用必须指向本作品真实存在的报告，且摘要与版本未在预览后变化。
		if ref, ok, err := parseCXCardsPlanRef(cardsOptions.VisualPlan); err != nil {
			return err
		} else if ok {
			var inputHash string
			var resultRevision int
			err := tx.QueryRow(ctx, `SELECT input_hash,result_revision FROM content_diagnosis
				WHERE id=$1 AND workspace_id=$2 AND work_id=$3 AND kind='visual_plan'`, ref.DiagnosisID, workspaceID, workID).Scan(&inputHash, &resultRevision)
			if errors.Is(err, pgx.ErrNoRows) {
				return apiErr(http.StatusConflict, "visual_plan_unavailable", "计划报告不存在或不属于当前作品，请重新生成组图计划")
			}
			if err != nil {
				return err
			}
			if inputHash != ref.InputHash || resultRevision != ref.ResultRevision {
				return apiErr(http.StatusConflict, "visual_plan_stale", "组图计划在预览后已变化，请重新预览构建参数")
			}
		}
	} else if cxHasCXBuildTarget(targets, "cover_images") {
		// 封面构建前提以冻结快照复核：预设只允许当前平台合法项，且作品已选定封面。
		if err := cxValidateCoverBuildAgainstSnapshot(coverOptions, platform, snapshot); err != nil {
			return err
		}
	} else if report := cxBuildSyntaxReport(snapshot, revision); report.HasErrors {
		return apiErr(http.StatusUnprocessableEntity, "render_unsupported_syntax", "当前稿件包含不能可靠排版的语法").With(report)
	}
	sourceBytes, err := cxcanonicaljson.Marshal(snapshot)
	if err != nil {
		return err
	}
	sourceHash, err := cxcanonicaljson.Hash(snapshot)
	if err != nil {
		return err
	}
	params := map[string]any{
		"targets":                   cxBuildStringValues(targets),
		"options":                   options,
		"renderer_contract_version": in.RendererContractVersion,
		"rules_version":             markdownsyntax.RulesVersion,
	}
	paramsBytes, err := cxcanonicaljson.Marshal(params)
	if err != nil {
		return err
	}
	paramsHash, err := cxcanonicaljson.Hash(params)
	if err != nil {
		return err
	}

	if !in.Force {
		var existing struct {
			ID         uuid.UUID
			Status     string
			SourceJSON []byte
			DeadlineAt time.Time
			ExpiresAt  *time.Time
		}
		// DEEP-01：命中键含 workspace_id，防跨租户误复用。
		err = tx.QueryRow(ctx, `SELECT id,status,source_snapshot,deadline_at,expires_at
			FROM work_build WHERE workspace_id=$1 AND work_id=$2 AND source_hash=$3 AND params_hash=$4
			AND reusable AND status IN ('running','built')
			FOR UPDATE`, workspaceID, workID, sourceHash, paramsHash).Scan(&existing.ID, &existing.Status, &existing.SourceJSON, &existing.DeadlineAt, &existing.ExpiresAt)
		if err == nil {
			if existing.Status == "running" && !existing.DeadlineAt.After(s.now()) {
				if _, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code='build_timeout',finished_at=now()
					WHERE id=$1 AND status='running'`, existing.ID); err != nil {
					return err
				}
				existing.Status = "failed"
			} else if existing.Status == "built" && (existing.ExpiresAt == nil || !existing.ExpiresAt.After(s.now()) || !s.cxBuildArtifactFilesExist(ctx, tx, s.cfg.DataDir, existing.ID, workspaceID)) {
				if _, err := tx.Exec(ctx, `UPDATE work_build SET reusable=false WHERE id=$1`, existing.ID); err != nil {
					return err
				}
				existing.Status = "failed"
			}
			if existing.Status == "running" || existing.Status == "built" {
				if err := tx.Commit(ctx); err != nil {
					return err
				}
				status := http.StatusOK
				if existing.Status == "running" {
					status = http.StatusAccepted
				}
				from := existing.ID
				s.audit(ctx, "work_build_reuse", "work_build", existing.ID.String(), "ok", map[string]any{
					"work_id": workID, "status": existing.Status, "client": in.Client,
				})
				writeJSON(w, status, cxBuildCreateResponse{
					BuildID: existing.ID, Status: existing.Status, SourceHash: sourceHash, ParamsHash: paramsHash,
					BasisRevision: revision, SourceSnapshot: existing.SourceJSON, DeadlineAt: existing.DeadlineAt,
					ExpiresAt: existing.ExpiresAt, Reused: true, ReusedFrom: &from,
				})
				return nil
			}
		} else if err != pgx.ErrNoRows {
			return err
		}
	} else {
		// force：让同键旧 running/built 让出幂等位，再插入新行。
		if _, err := tx.Exec(ctx, `UPDATE work_build SET reusable=false
			WHERE workspace_id=$1 AND work_id=$2 AND source_hash=$3 AND params_hash=$4
			AND reusable AND status IN ('running','built')`, workspaceID, workID, sourceHash, paramsHash); err != nil {
			return err
		}
	}

	var buildID uuid.UUID
	var deadlineAt time.Time
	if err := tx.QueryRow(ctx, `INSERT INTO work_build(workspace_id,work_id,basis_revision,targets,source_snapshot,source_hash,params,params_hash,created_by,deadline_at)
		VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,now()+interval '120 seconds')
		RETURNING id,deadline_at`, workspaceID, workID, revision, targets, string(sourceBytes), sourceHash, string(paramsBytes), paramsHash, ident(ctx).UserID).
		Scan(&buildID, &deadlineAt); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "work_build_create", "work_build", buildID.String(), "ok", map[string]any{
		"targets": targets, "client": in.Client, "force": in.Force,
	})
	writeJSON(w, http.StatusCreated, cxBuildCreateResponse{
		BuildID: buildID, Status: "running", SourceHash: sourceHash, ParamsHash: paramsHash,
		BasisRevision: revision, SourceSnapshot: sourceBytes, DeadlineAt: deadlineAt,
		Reused: false,
	})
	return nil
}

func cxBuildSourceSnapshot(ctx context.Context, tx pgx.Tx, workspaceID, workID uuid.UUID, expectedRevision int, lockWork bool, dnaVersion *int64) (map[string]any, int, string, string, error) {
	var (
		accountID  uuid.UUID
		platform   string
		format     string
		revision   int
		title      string
		summary    string
		viewpoint  string
		topics     []string
		wechatRaw  []byte
		coverID    *uuid.UUID
		coverRaw   []byte
		themeID    string
		templateID *uuid.UUID
	)
	query := `SELECT w.account_id,a.platform,w.content_format,w.revision,w.title,w.summary,w.viewpoint,w.topics,
		w.wechat_fields,w.cover_asset_id,w.cover_crops,w.theme,w.template_id
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`
	if lockWork {
		query += ` FOR UPDATE OF w`
	}
	err := tx.QueryRow(ctx, query, workID, workspaceID).
		Scan(&accountID, &platform, &format, &revision, &title, &summary, &viewpoint, &topics, &wechatRaw, &coverID, &coverRaw, &themeID, &templateID)
	if err != nil {
		return nil, 0, "", "", err
	}
	if expectedRevision > 0 && revision != expectedRevision {
		return nil, revision, "", "", apiErr(http.StatusConflict, "version_conflict", "作品已修改，请刷新后重新创建构建").With(map[string]int{"server_revision": revision})
	}
	if topics == nil {
		topics = []string{}
	}
	wechatFields, err := cxcanonicaljson.Parse(wechatRaw)
	if err != nil {
		return nil, 0, "", "", err
	}
	coverCrops, err := cxBuildParseOptionalJSON(coverRaw)
	if err != nil {
		return nil, 0, "", "", err
	}
	// 裁剪坐标是 0..1 的小数，必须按快照契约转成定点字符串后才能进 canonical JSON。
	if coverCrops, err = cxFixedPointDecimals(coverCrops); err != nil {
		return nil, 0, "", "", err
	}
	assets, err := cxBuildReadAssets(ctx, tx, workspaceID, accountID, workID, coverID)
	if err != nil {
		return nil, 0, "", "", err
	}
	if coverID != nil && !cxBuildHasAsset(assets, *coverID) {
		return nil, 0, "", "", apiErr(http.StatusConflict, "asset_unavailable", "作品封面素材已不可用，暂不能创建构建")
	}
	sections, err := cxBuildReadSections(ctx, tx, workID)
	if err != nil {
		return nil, 0, "", "", err
	}
	accountCustomTheme, err := cxBuildReadCustomTheme(ctx, tx, accountID)
	if err != nil {
		return nil, 0, "", "", err
	}
	theme, err := cxBuildTheme(themeID, accountCustomTheme)
	if err != nil {
		return nil, 0, "", "", err
	}
	template, err := cxBuildReadTemplate(ctx, tx, workspaceID, templateID)
	if err != nil {
		return nil, 0, "", "", err
	}
	// 组图构建必须把所选 DNA 版本冻结进来源快照，才能与 cards/preview 的 source_hash 对齐，
	// 并保证完成后复核的是同一份令牌。公众号构建保持 visual_dna=null。
	var visualDNA any
	if dnaVersion != nil {
		snapshotValue, err := cxLoadVisualDNAForBuild(ctx, tx, accountID, *dnaVersion)
		if err != nil {
			return nil, 0, "", "", err
		}
		// 与 cards/preview 使用同一规范化路径（时间与令牌都转成 canonical JSON 值）。
		canonical, err := cxCardsCanonicalValue(snapshotValue)
		if err != nil {
			return nil, 0, "", "", err
		}
		visualDNA = canonical
	}
	snapshot := map[string]any{
		"schema": "ops.build-source/v1",
		"work": map[string]any{
			"id": workID.String(), "account_id": accountID.String(), "platform": platform, "content_format": format,
			"revision": revision, "title": title, "summary": summary, "viewpoint": viewpoint,
			"topics": cxBuildStringValues(topics), "wechat_fields": wechatFields, "cover_asset_id": cxBuildUUID(coverID), "cover_crops": coverCrops,
		},
		"sections":             sections,
		"assets":               assets,
		"theme":                theme,
		"account_custom_theme": accountCustomTheme,
		"visual_dna":           visualDNA,
		"template":             template,
		"rules_version":        markdownsyntax.RulesVersion,
	}
	return snapshot, revision, platform, format, nil
}

// cxLoadVisualDNAForBuild 读取并复核指定 DNA 版本；令牌摘要不符时拒绝构建，不用近似版本代替。
func cxLoadVisualDNAForBuild(ctx context.Context, q pgx.Tx, accountID uuid.UUID, version int64) (any, error) {
	var raw []byte
	var tokensHash string
	var createdAt time.Time
	err := q.QueryRow(ctx, `SELECT tokens,tokens_hash,created_at FROM account_visual_dna WHERE account_id=$1 AND version=$2`, accountID, version).
		Scan(&raw, &tokensHash, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apiErr(http.StatusConflict, "visual_dna_unavailable", "所选视觉 DNA 版本不存在，请刷新账号视觉 DNA 后重试")
	}
	if err != nil {
		return nil, err
	}
	tokens, err := decodeCXDNATokens(raw)
	if err != nil {
		return nil, apiErr(http.StatusInternalServerError, "visual_dna_invalid_history", "所选视觉 DNA 历史版本无法验证")
	}
	verifiedHash, err := cxVisualDNATokensHash(tokens)
	if err != nil || verifiedHash != tokensHash {
		return nil, apiErr(http.StatusInternalServerError, "visual_dna_invalid_history", "所选视觉 DNA 历史摘要无法验证")
	}
	return cxVisualPlanDNASnapshot{Version: version, TokensHash: tokensHash, Tokens: tokens, CreatedAt: createdAt.UTC()}, nil
}

func cxBuildReadSections(ctx context.Context, tx pgx.Tx, workID uuid.UUID) ([]any, error) {
	rows, err := tx.Query(ctx, `SELECT id,position,heading,content_md FROM work_section WHERE work_id=$1 AND deleted_at IS NULL ORDER BY position,id`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sections := []any{}
	for rows.Next() {
		var section struct {
			ID        uuid.UUID
			Position  int
			Heading   string
			ContentMD string
		}
		if err := rows.Scan(&section.ID, &section.Position, &section.Heading, &section.ContentMD); err != nil {
			return nil, err
		}
		sections = append(sections, map[string]any{
			"id": section.ID.String(), "position": section.Position,
			"heading": section.Heading, "content_md": section.ContentMD,
		})
	}
	return sections, rows.Err()
}

func cxBuildReadAssets(ctx context.Context, tx pgx.Tx, workspaceID, accountID, workID uuid.UUID, coverID *uuid.UUID) ([]any, error) {
	rows, err := tx.Query(ctx, `SELECT id,work_id,sha256,mime,width,height,bytes,position,alt_text FROM asset
		WHERE workspace_id=$1 AND account_id=$2 AND (work_id=$3 OR id=$4) ORDER BY position,id`, workspaceID, accountID, workID, coverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	assets := []any{}
	for rows.Next() {
		var asset struct {
			ID       uuid.UUID
			WorkID   uuid.NullUUID
			SHA256   string
			MIME     string
			Width    int
			Height   int
			Bytes    int
			Position int
			AltText  string
		}
		if err := rows.Scan(&asset.ID, &asset.WorkID, &asset.SHA256, &asset.MIME, &asset.Width, &asset.Height, &asset.Bytes, &asset.Position, &asset.AltText); err != nil {
			return nil, err
		}
		var assetWorkID any
		if asset.WorkID.Valid {
			assetWorkID = asset.WorkID.UUID.String()
		}
		assets = append(assets, map[string]any{
			"id": asset.ID.String(), "work_id": assetWorkID, "sha256": asset.SHA256, "mime": asset.MIME,
			"width": asset.Width, "height": asset.Height, "bytes": asset.Bytes,
			"position": asset.Position, "alt_text": asset.AltText,
		})
	}
	return assets, rows.Err()
}

func cxBuildHasAsset(assets []any, assetID uuid.UUID) bool {
	for _, asset := range assets {
		if value, ok := asset.(map[string]any); ok && value["id"] == assetID.String() {
			return true
		}
	}
	return false
}

func cxBuildReadCustomTheme(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) (any, error) {
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT custom_theme FROM account_profile WHERE account_id=$1`, accountID).Scan(&raw); err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var theme CustomTheme
	if err := json.Unmarshal(raw, &theme); err != nil {
		return nil, apiErr(http.StatusConflict, "theme_unavailable", "账号自定义主题格式无法安全快照")
	}
	if err := theme.validate(); err != nil {
		return nil, apiErr(http.StatusConflict, "theme_unavailable", "账号自定义主题参数无效，暂不能创建构建")
	}
	return map[string]any{
		"base": theme.Base, "primary_color": theme.PrimaryColor, "font_size": theme.FontSize,
		"line_height": strconv.FormatFloat(theme.LineHeight, 'f', -1, 64), "paragraph_gap": theme.ParagraphGap,
		"heading_style": theme.HeadingStyle, "quote_style": theme.QuoteStyle,
	}, nil
}

func cxBuildTheme(themeID string, customTheme any) (any, error) {
	if themeID == "custom" {
		custom, ok := customTheme.(map[string]any)
		if !ok {
			return nil, apiErr(http.StatusConflict, "theme_unavailable", "作品使用自定义主题但账号主题尚未保存")
		}
		baseID, _ := custom["base"].(string)
		if _, ok := cxrendercontract.BuiltinTheme(baseID); !ok {
			baseID = "ink"
		}
		baseResource, _ := cxrendercontract.BuiltinTheme(baseID)
		return map[string]any{
			"id": "custom", "version": 1, "base_theme": map[string]any{"id": baseID, "version": baseResource.Version, "token_digest": baseResource.TokenDigest},
			"custom_theme": custom,
		}, nil
	}
	resource, ok := cxrendercontract.BuiltinTheme(themeID)
	if !ok {
		return nil, apiErr(http.StatusConflict, "theme_unavailable", "作品主题版本尚未登记，暂不能创建构建")
	}
	return map[string]any{"id": themeID, "version": resource.Version, "token_digest": resource.TokenDigest}, nil
}

func cxBuildStringValues(values []string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}

func cxBuildReadTemplate(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, templateID *uuid.UUID) (any, error) {
	if templateID == nil {
		return nil, nil
	}
	var template *CreationTemplate
	for _, builtin := range builtinCreationTemplates() {
		if templateStableID(builtin) == *templateID {
			copy := builtin
			copy.ID = *templateID
			copy.UpdatedAt = "builtin-v1"
			template = &copy
			break
		}
	}
	if template == nil {
		var (
			item      CreationTemplate
			structure []byte
			updatedAt time.Time
		)
		err := tx.QueryRow(ctx, `SELECT id,content_format,name,builtin,structure,prompt_addon,section_min,section_max,tone,updated_at
			FROM creation_template WHERE id=$1 AND workspace_id=$2`, *templateID, workspaceID).
			Scan(&item.ID, &item.ContentFormat, &item.Name, &item.Builtin, &structure, &item.PromptAddon, &item.SectionMin, &item.SectionMax, &item.Tone, &updatedAt)
		if err != nil {
			return nil, apiErr(http.StatusConflict, "template_unavailable", "作品所用创作模板已不可读取，暂不能创建构建")
		}
		if err := json.Unmarshal(structure, &item.Structure); err != nil {
			return nil, apiErr(http.StatusConflict, "template_unavailable", "作品所用创作模板格式无法安全快照")
		}
		if item.Structure == nil {
			item.Structure = []TemplateStep{}
		}
		item.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
		template = &item
	}
	digestInput := map[string]any{
		"id": template.ID.String(), "content_format": template.ContentFormat, "name": template.Name, "builtin": template.Builtin,
		"structure": cxBuildTemplateSteps(template.Structure), "prompt_addon": template.PromptAddon,
		"section_min": template.SectionMin, "section_max": template.SectionMax, "tone": template.Tone,
	}
	digest, err := cxcanonicaljson.Hash(digestInput)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": template.ID.String(), "version": template.UpdatedAt, "digest": digest}, nil
}

func cxBuildTemplateSteps(steps []TemplateStep) []any {
	out := make([]any, 0, len(steps))
	for _, step := range steps {
		out = append(out, map[string]any{"heading": step.Heading, "key_point": step.KeyPoint, "role": step.Role})
	}
	return out
}

func cxBuildParseOptionalJSON(raw []byte) (any, error) {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	value, err := cxcanonicaljson.Parse(raw)
	if err != nil {
		return nil, err
	}
	return value, nil
}

// cxFixedPointDecimals 把快照里的 JSON 小数转成定点字符串（24 §4.6：小数必须以
// 定点字符串进入快照与参数哈希）。整数拼写保留为数字；小数保留原拼写，指数形式
// （json.Marshal 对极小值可能输出 1e-06）按最短定点表示归一，保证同库数据同哈希。
// 没有 cover_crops 的旧构建不受影响；带裁剪坐标的构建此前会在 Marshal 处 500。
func cxFixedPointDecimals(value any) (any, error) {
	switch value := value.(type) {
	case json.Number:
		spelling := string(value)
		if !strings.ContainsAny(spelling, ".eE") {
			return value, nil
		}
		parsed, err := strconv.ParseFloat(spelling, 64)
		if err != nil {
			return nil, fmt.Errorf("canonical JSON decimals must be fixed-point strings: %q", spelling)
		}
		return strconv.FormatFloat(parsed, 'f', -1, 64), nil
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, item := range value {
			converted, err := cxFixedPointDecimals(item)
			if err != nil {
				return nil, err
			}
			out[key] = converted
		}
		return out, nil
	case []any:
		out := make([]any, len(value))
		for index, item := range value {
			converted, err := cxFixedPointDecimals(item)
			if err != nil {
				return nil, err
			}
			out[index] = converted
		}
		return out, nil
	default:
		return value, nil
	}
}

func cxBuildSyntaxReport(snapshot map[string]any, revision int) markdownsyntax.Report {
	sections, _ := snapshot["sections"].([]any)
	assets, _ := snapshot["assets"].([]any)
	input := make([]markdownsyntax.Section, 0, len(sections))
	for _, section := range sections {
		values, ok := section.(map[string]any)
		if !ok {
			continue
		}
		id, _ := values["id"].(string)
		heading, _ := values["heading"].(string)
		content, _ := values["content_md"].(string)
		input = append(input, markdownsyntax.Section{ID: id, Heading: heading, Content: content})
	}
	managed := make(map[string]bool, len(assets))
	for _, asset := range assets {
		if values, ok := asset.(map[string]any); ok {
			if id, ok := values["id"].(string); ok {
				managed[id] = true
			}
		}
	}
	return markdownsyntax.Scan(input, revision, managed)
}

func (s *Server) cxCurrentBuildSourceHash(ctx context.Context, workspaceID, workID uuid.UUID, dnaVersion *int64) (string, int, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", 0, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	snapshot, revision, _, _, err := cxBuildSourceSnapshot(ctx, tx, workspaceID, workID, 0, false, dnaVersion)
	if err != nil {
		return "", 0, err
	}
	hash, err := cxcanonicaljson.Hash(snapshot)
	if err != nil {
		return "", 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", 0, err
	}
	return hash, revision, nil
}

func cxBuildUUID(value *uuid.UUID) any {
	if value == nil {
		return nil
	}
	return value.String()
}

func (s *Server) cxBuildArtifactFilesExist(ctx context.Context, tx pgx.Tx, dataDir string, buildID, workspaceID uuid.UUID) bool {
	rows, err := tx.Query(ctx, `SELECT id,storage_path,bytes,sha256 FROM work_build_artifact WHERE build_id=$1 AND workspace_id=$2`, buildID, workspaceID)
	if err != nil {
		return false
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		found = true
		var id uuid.UUID
		var storagePath string
		var expectedBytes int64
		var expectedHash string
		if err := rows.Scan(&id, &storagePath, &expectedBytes, &expectedHash); err != nil {
			return false
		}
		if storagePath != cxBuildStoragePath(workspaceID, buildID, id) {
			return false
		}
		fullPath := filepath.Join(dataDir, filepath.FromSlash(storagePath))
		info, err := os.Stat(fullPath)
		if err != nil || info.Size() != expectedBytes {
			return false
		}
		file, err := os.Open(fullPath)
		if err != nil {
			return false
		}
		hasher := sha256.New()
		_, copyErr := io.Copy(hasher, file)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil || hex.EncodeToString(hasher.Sum(nil)) != expectedHash {
			return false
		}
	}
	return rows.Err() == nil && found
}

func cxBuildStoragePath(workspaceID, buildID, artifactID uuid.UUID) string {
	return "builds/" + workspaceID.String() + "/" + buildID.String() + "/" + artifactID.String()
}

func (s *Server) listCXBuilds(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	limit := 20
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return validation("limit 必须为 1 到 100")
		}
	}
	var cursorAt *time.Time
	var cursorID *uuid.UUID
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil {
			return validation("cursor 格式不正确")
		}
		parts := strings.SplitN(string(decoded), "\n", 2)
		if len(parts) != 2 {
			return validation("cursor 格式不正确")
		}
		at, err := time.Parse(time.RFC3339Nano, parts[0])
		if err != nil {
			return validation("cursor 格式不正确")
		}
		id, err := uuid.Parse(parts[1])
		if err != nil {
			return validation("cursor 格式不正确")
		}
		cursorAt, cursorID = &at, &id
	}
	currentHash, _, currentErr := s.cxCurrentBuildSourceHash(r.Context(), ident(r.Context()).WorkspaceID, m.ID, nil)
	if currentErr != nil {
		return currentErr
	}
	// 组图构建把 DNA 版本冻结进来源快照，判断"是否仍对应当前作品"必须用同一版本重算。
	cardsHashes := map[string]string{}
	currentHashForCards := func(rawParams []byte) (string, error) {
		options, err := cxBuildCardsOptionsFromParams(rawParams)
		if err != nil || options.DNAVersion == nil {
			return currentHash, nil
		}
		key := strconv.FormatInt(*options.DNAVersion, 10)
		if hash, ok := cardsHashes[key]; ok {
			return hash, nil
		}
		hash, _, err := s.cxCurrentBuildSourceHash(r.Context(), ident(r.Context()).WorkspaceID, m.ID, options.DNAVersion)
		if err != nil {
			return "", err
		}
		cardsHashes[key] = hash
		return hash, nil
	}
	query := `SELECT id,targets,basis_revision,source_hash,params_hash,params,status,error_code,created_at,finished_at,expires_at
		FROM work_build WHERE work_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3`
	args := []any{m.ID, ident(r.Context()).WorkspaceID, limit + 1}
	if cursorAt != nil {
		query = `SELECT id,targets,basis_revision,source_hash,params_hash,params,status,error_code,created_at,finished_at,expires_at
			FROM work_build WHERE work_id=$1 AND workspace_id=$2 AND (created_at,id)<($3,$4) ORDER BY created_at DESC,id DESC LIMIT $5`
		args = []any{m.ID, ident(r.Context()).WorkspaceID, *cursorAt, *cursorID, limit + 1}
	}
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	type item struct {
		ID            uuid.UUID  `json:"id"`
		Targets       []string   `json:"targets"`
		BasisRevision int        `json:"basis_revision"`
		SourceHash    string     `json:"source_hash"`
		ParamsHash    string     `json:"params_hash"`
		Status        string     `json:"status"`
		ErrorCode     *string    `json:"error_code"`
		CreatedAt     time.Time  `json:"created_at"`
		FinishedAt    *time.Time `json:"finished_at"`
		ExpiresAt     *time.Time `json:"expires_at"`
		IsCurrent     bool       `json:"is_current"`
	}
	items := make([]item, 0, limit)
	for rows.Next() {
		var v item
		var rawParams []byte
		if err := rows.Scan(&v.ID, &v.Targets, &v.BasisRevision, &v.SourceHash, &v.ParamsHash, &rawParams, &v.Status, &v.ErrorCode, &v.CreatedAt, &v.FinishedAt, &v.ExpiresAt); err != nil {
			return err
		}
		if len(items) < limit {
			hash := currentHash
			if cxHasCXBuildTarget(v.Targets, "xhs_cards") {
				hash, err = currentHashForCards(rawParams)
				if err != nil {
					return err
				}
			}
			v.IsCurrent = v.SourceHash == hash
			items = append(items, v)
		} else {
			items = append(items, v)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var next any
	if len(items) > limit {
		last := items[limit-1]
		next = base64.RawURLEncoding.EncodeToString([]byte(last.CreatedAt.UTC().Format(time.RFC3339Nano) + "\n" + last.ID.String()))
		items = items[:limit]
	}
	return ok(w, map[string]any{"items": items, "next_cursor": next})
}

func (s *Server) getCXBuild(w http.ResponseWriter, r *http.Request) error {
	buildID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var response struct {
		ID             uuid.UUID        `json:"id"`
		WorkID         uuid.UUID        `json:"work_id"`
		BasisRevision  int              `json:"basis_revision"`
		Targets        []string         `json:"targets"`
		SourceSnapshot json.RawMessage  `json:"source_snapshot"`
		SourceHash     string           `json:"source_hash"`
		Params         json.RawMessage  `json:"params"`
		ParamsHash     string           `json:"params_hash"`
		Status         string           `json:"status"`
		ErrorCode      *string          `json:"error_code"`
		CreatedAt      time.Time        `json:"created_at"`
		DeadlineAt     time.Time        `json:"deadline_at"`
		FinishedAt     *time.Time       `json:"finished_at"`
		ExpiresAt      *time.Time       `json:"expires_at"`
		Artifacts      []map[string]any `json:"artifacts"`
		IsCurrent      bool             `json:"is_current"`
		Manifest       json.RawMessage  `json:"manifest,omitempty"`
		ManifestSHA256 *string          `json:"manifest_sha256,omitempty"`
		Validation     json.RawMessage  `json:"validation,omitempty"`
		DownloadGate   map[string]any   `json:"download_gate"`
	}
	workspaceID := ident(r.Context()).WorkspaceID
	var errorDetail, acknowledgements []byte
	if err := s.db.QueryRow(r.Context(), `SELECT b.id,b.work_id,b.basis_revision,b.targets,b.source_snapshot,b.source_hash,b.params,b.params_hash,b.status,b.error_code,b.created_at,b.deadline_at,b.finished_at,b.expires_at,b.manifest,b.manifest_sha256,b.error_detail,b.acknowledgements
		FROM work_build b JOIN work w ON w.id=b.work_id JOIN platform_account a ON a.id=w.account_id
		WHERE b.id=$1 AND b.workspace_id=$2 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, buildID, workspaceID).
		Scan(&response.ID, &response.WorkID, &response.BasisRevision, &response.Targets, &response.SourceSnapshot, &response.SourceHash, &response.Params, &response.ParamsHash, &response.Status, &response.ErrorCode, &response.CreatedAt, &response.DeadlineAt, &response.FinishedAt, &response.ExpiresAt, &response.Manifest, &response.ManifestSHA256, &errorDetail, &acknowledgements); err != nil {
		return err
	}
	response.Validation = cxValidationDetailJSON(errorDetail)
	response.Artifacts = []map[string]any{}
	rows, err := s.db.Query(r.Context(), `SELECT id,kind,name,mime,bytes,sha256,width,height,created_at FROM work_build_artifact WHERE build_id=$1 AND workspace_id=$2 ORDER BY created_at,id`, buildID, workspaceID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		var kind, name, mime, hash string
		var size int64
		var width, height *int
		var created time.Time
		if err := rows.Scan(&id, &kind, &name, &mime, &size, &hash, &width, &height, &created); err != nil {
			rows.Close()
			return err
		}
		artifact := cxBuildArtifact{ID: id, Kind: kind, Name: name, MIME: mime, Bytes: size, SHA256: hash, Width: width, Height: height}
		response.Artifacts = append(response.Artifacts, map[string]any{"id": id, "kind": kind, "name": name, "mime": mime, "bytes": size, "sha256": hash, "width": width, "height": height, "created_at": created,
			"downloadable": cxManifestContainsArtifact(response.Manifest, artifact)})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var cardsDNA *int64
	if cxHasCXBuildTarget(response.Targets, "xhs_cards") {
		if options, err := cxBuildCardsOptionsFromParams(response.Params); err == nil {
			cardsDNA = options.DNAVersion
		}
	}
	currentHash, _, currentErr := s.cxCurrentBuildSourceHash(r.Context(), workspaceID, response.WorkID, cardsDNA)
	response.IsCurrent = currentErr == nil && currentHash == response.SourceHash
	response.DownloadGate = cxBuildDownloadGate(response.Status, response.ExpiresAt, response.Manifest, response.ManifestSHA256, response.Validation, acknowledgements, ident(r.Context()).UserID, ident(r.Context()).Role, s.now())
	return ok(w, response)
}

func (s *Server) cancelCXBuild(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	buildID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var body map[string]json.RawMessage
	if err := decodeCXBuildJSON(w, r, &body); err != nil {
		return err
	}
	if len(body) != 0 {
		return validation("取消构建请求应为空对象")
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var status, errorCode string
	var deadlineAt time.Time
	err = tx.QueryRow(ctx, `SELECT b.status,coalesce(b.error_code,''),b.deadline_at FROM work_build b
		JOIN work w ON w.id=b.work_id JOIN platform_account a ON a.id=w.account_id
		WHERE b.id=$1 AND b.workspace_id=$2 AND a.workspace_id=$2 AND w.deleted_at IS NULL FOR UPDATE OF b`, buildID, ident(ctx).WorkspaceID).Scan(&status, &errorCode, &deadlineAt)
	if err != nil {
		return err
	}
	if status == "running" {
		errorCode = "build_cancelled"
		if !deadlineAt.After(s.now()) {
			errorCode = "build_timeout"
		}
		if _, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code=$2,finished_at=now()
			WHERE id=$1 AND status='running'`, buildID, errorCode); err != nil {
			return err
		}
		status = "failed"
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, map[string]string{"status": status, "error_code": errorCode})
}

func (s *Server) completeCXBuild(w http.ResponseWriter, r *http.Request) error {
	return s.completeCXBuildValidated(w, r)
}
