package app

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var cxExistingWritingTasks = map[string]bool{
	"outline": true, "section_draft": true, "title": true, "read_through": true,
}

func (s *Server) cxWritingBasis(ctx context.Context, t aiTask, pack *ContextPack) (*cxBasisReceipt, error) {
	if !t.CXBasisEnabled || t.Account == nil || t.WorkID == nil {
		return nil, nil
	}
	if !cxExistingWritingTasks[t.Type] {
		return nil, nil
	}
	id := ident(ctx)
	if id == nil || id.WorkspaceID == uuid.Nil {
		return nil, errUnauthenticated
	}

	var accountID uuid.UUID
	var currentRevision int64
	var accountStatus string
	if err := s.db.QueryRow(ctx, `SELECT w.account_id,w.revision,a.status FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, *t.WorkID, id.WorkspaceID).Scan(&accountID, &currentRevision, &accountStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	if accountID != t.Account.ID || accountStatus != "active" {
		return nil, cxWritingBasisChanged()
	}
	if t.CXExpectedWorkRev != nil && currentRevision != *t.CXExpectedWorkRev {
		return nil, cxWritingBasisChanged()
	}
	workRevision := currentRevision
	receipt := &cxBasisReceipt{
		SchemaVersion: 1,
		AccountID:     accountID,
		WorkRevision:  &workRevision,
		Sources:       []cxBasisSource{},
		Omitted:       append([]cxBasisOmission{}, t.CXUnrepresentedItems...),
		AssembledAt:   s.now().UTC(),
	}
	seen := map[string]bool{}
	hasMaterial := false
	for _, slot := range pack.Slots {
		for _, item := range slot.Items {
			if !item.Used || item.ID == "" || item.SourceKind == "" {
				continue
			}
			if item.SourceKind == "material" {
				hasMaterial = true
			}
			source, err := cxWritingSourceFromSlotItem(item)
			if err != nil {
				return nil, err
			}
			if source.Kind == "strategy" {
				strategyRef := source.Ref
				receipt.StrategyRef = &strategyRef
			}
			if !seen[source.Ref] {
				receipt.Sources = append(receipt.Sources, source)
				seen[source.Ref] = true
			}
		}
		if slot.Name == "style" {
			styleSummary, _ := pack.Legacy["style_summary"].(bool)
			if !styleSummary {
				for _, item := range slot.Items {
					if item.Used {
						receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "style_sample", Reason: "既有风格样本已参与创作；cx_basis v1 未定义风格样本来源类型，详情见 refs.slots.style"})
						break
					}
				}
			}
		}
		if slot.Name == "performance" {
			for _, item := range slot.Items {
				if item.Used {
					receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "performance", Reason: "本号高表现样本已参与创作；cx_basis v1 未定义本地作品及统计来源的联合类型，详情见 refs.slots.performance"})
					break
				}
			}
		}
		if slot.Name == "references" {
			for _, item := range slot.Items {
				if item.Used {
					receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "reference_method", Reason: "既有方法参考已参与创作；cx_basis v1 未定义该来源类型，详情见 refs.slots.references"})
					break
				}
			}
		}
	}
	for _, source := range t.CXSectionSources {
		if source.Kind != "work_section" || source.ID == "" || seen[source.Ref] {
			continue
		}
		if source.Ref == "" {
			source.Ref = source.Kind + ":" + source.ID
		}
		receipt.Sources = append(receipt.Sources, source)
		seen[source.Ref] = true
	}
	if !hasMaterial {
		receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "material", Reason: "本次没有选入可用素材；具体事实需由作者补充或核实"})
	}
	for _, source := range receipt.Sources {
		if source.Kind == "profile" {
			receipt.ProfileHash = sourceContentHashFromSlots(pack, source.Ref)
			break
		}
	}
	if len(receipt.Sources) == 0 {
		receipt.Coverage = "unavailable"
	} else if len(receipt.Omitted) > 0 {
		receipt.Coverage = "partial"
	} else {
		receipt.Coverage = "ready"
	}
	sort.SliceStable(receipt.Sources, func(i, j int) bool { return receipt.Sources[i].Ref < receipt.Sources[j].Ref })
	inputHash, err := cxJSONHash(struct {
		TaskType     string            `json:"task_type"`
		AccountID    uuid.UUID         `json:"account_id"`
		WorkID       uuid.UUID         `json:"work_id"`
		WorkRevision int64             `json:"work_revision"`
		ProfileHash  string            `json:"profile_hash"`
		Sources      []cxBasisSource   `json:"sources"`
		Omitted      []cxBasisOmission `json:"omitted"`
		PromptHash   string            `json:"prompt_hash"`
		Instruction  string            `json:"instruction"`
	}{t.Type, accountID, *t.WorkID, workRevision, receipt.ProfileHash, receipt.Sources, receipt.Omitted,
		mustCXHash(pack.User), t.Instruction})
	if err != nil {
		return nil, err
	}
	receipt.InputHash = inputHash
	if err := s.verifyCXWritingBasis(ctx, *t.WorkID, receipt); err != nil {
		return nil, err
	}
	return receipt, nil
}

func cxWritingSourceFromSlotItem(item SlotItem) (cxBasisSource, error) {
	source := cxBasisSource{Kind: item.SourceKind, ID: item.ID, Revision: nil, AsOfAt: item.AsOfAt, State: item.State, Purpose: item.Purpose}
	source.Ref = source.Kind + ":" + source.ID
	if item.Revision > 0 {
		rev := item.Revision
		source.Revision = &rev
	}
	if item.SourceKind != "profile" && item.SourceKind != "strategy" && item.SourceKind != "material" && item.SourceKind != "confirmed_memory" && item.SourceKind != "work_section" {
		return cxBasisSource{}, apiErr(http.StatusInternalServerError, "cx_basis_source_invalid", "创作来源类型不受支持")
	}
	if item.AsOfAt == nil {
		return cxBasisSource{}, apiErr(http.StatusInternalServerError, "cx_basis_source_incomplete", "创作来源缺少更新时间")
	}
	return source, nil
}

func cxWritingSectionSources(sections []Section, ids ...uuid.UUID) []cxBasisSource {
	wanted := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		if id != uuid.Nil {
			wanted[id] = true
		}
	}
	out := make([]cxBasisSource, 0, len(wanted))
	for _, section := range sections {
		if !wanted[section.ID] {
			continue
		}
		revision := int64(section.Revision)
		updatedAt := section.UpdatedAt
		id := section.ID.String()
		out = append(out, cxBasisSource{Ref: "work_section:" + id, Kind: "work_section", ID: id, Revision: &revision,
			AsOfAt: &updatedAt, State: "unconfirmed", Purpose: "本人作品段落"})
	}
	return out
}

func cxDraftSectionSources(sections []Section, currentID uuid.UUID) []cxBasisSource {
	ids := make([]uuid.UUID, 0, 3)
	for i, section := range sections {
		if section.ID != currentID {
			continue
		}
		ids = append(ids, currentID)
		if i > 0 && strings.TrimSpace(sections[i-1].ContentMD) != "" {
			ids = append(ids, sections[i-1].ID)
		}
		if i+1 < len(sections) && strings.TrimSpace(sections[i+1].ContentMD) != "" {
			ids = append(ids, sections[i+1].ID)
		}
		break
	}
	out := cxWritingSectionSources(sections, ids...)
	for i := range out {
		if out[i].ID == currentID.String() {
			out[i].Purpose = "当前段落提纲"
		} else {
			out[i].Purpose = "相邻段落写法与衔接"
		}
	}
	return out
}

func cxExpectedWorkRevision(revision int) *int64 {
	value := int64(revision)
	return &value
}

func sourceContentHashFromSlots(pack *ContextPack, ref string) string {
	for _, slot := range pack.Slots {
		for _, item := range slot.Items {
			if item.Used && item.SourceKind == "profile" && "profile:"+item.ID == ref {
				return item.ContentHash
			}
		}
	}
	return ""
}

func mustCXHash(value string) string {
	hash, _ := cxJSONHash(value)
	return hash
}

func cxWritingBasisChanged() error {
	return apiErr(http.StatusConflict, "version_conflict", "创作依据已变化，请刷新后重试")
}

func (s *Server) verifyCXWritingBasis(ctx context.Context, workID uuid.UUID, basis *cxBasisReceipt) error {
	id := ident(ctx)
	if id == nil || id.WorkspaceID == uuid.Nil || id.UserID == uuid.Nil || id.SessionID == uuid.Nil {
		return errUnauthenticated
	}
	live, err := s.loadIdentityBySession(ctx, id.SessionID)
	if err != nil || live.UserID != id.UserID || live.WorkspaceID != id.WorkspaceID {
		return errUnauthenticated
	}
	if err := s.requireEditor(context.WithValue(ctx, ctxMember, live)); err != nil {
		return err
	}
	if basis.WorkRevision != nil {
		var revision int64
		var status string
		if err := s.db.QueryRow(ctx, `SELECT w.revision,a.status FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.id=$1 AND a.id=$2 AND a.workspace_id=$3 AND w.deleted_at IS NULL`,
			workID, basis.AccountID, id.WorkspaceID).Scan(&revision, &status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return cxWritingBasisChanged()
			}
			return err
		}
		if revision != *basis.WorkRevision || status != "active" {
			return cxWritingBasisChanged()
		}
	}
	for _, source := range basis.Sources {
		if err := s.verifyCXWritingSource(ctx, id.WorkspaceID, basis.AccountID, basis.ProfileHash, source); err != nil {
			return err
		}
	}
	return ctx.Err()
}

// cxDraftConflictAfterBasisChange preserves a generated section draft as a reviewable conflict
// candidate when the target section changed during model generation. It never writes the candidate.
func (s *Server) cxDraftConflictAfterBasisChange(ctx context.Context, task aiTask, basis *cxBasisReceipt,
	text string, callID uuid.UUID, refs map[string]any) error {
	if task.Type != "section_draft" || task.WorkID == nil || basis == nil {
		return nil
	}
	sectionID, ok := task.Refs["section_id"].(uuid.UUID)
	if !ok || sectionID == uuid.Nil {
		return nil
	}
	var expectedRevision *int64
	for _, source := range basis.Sources {
		if source.Kind == "work_section" && source.ID == sectionID.String() {
			expectedRevision = source.Revision
			break
		}
	}
	if expectedRevision == nil {
		return nil
	}
	current, err := scanSection(s.db.QueryRow(ctx, `SELECT `+sectionCols+` FROM work_section WHERE id=$1 AND work_id=$2 AND deleted_at IS NULL`, sectionID, *task.WorkID))
	if err != nil || int64(current.Revision) == *expectedRevision {
		return nil
	}
	fixed, fixes, changed := selfCheckDraft(text)
	detail := map[string]any{
		"server": current, "candidate": fixed, "ai_call_id": callID,
		"source_revisions": nil, "refs": refs,
	}
	if changed {
		detail["self_check"] = map[string]any{"fixes": fixes, "original": text}
	}
	return apiErr(http.StatusConflict, "version_conflict", "这段在生成期间被修改过").With(detail)
}

func (s *Server) verifyCXWritingSource(ctx context.Context, workspaceID, accountID uuid.UUID, profileHash string, source cxBasisSource) error {
	var asOfAt *time.Time
	var revision *int64
	switch source.Kind {
	case "profile":
		sourceID, err := uuid.Parse(source.ID)
		if err != nil || sourceID != accountID {
			return cxWritingBasisChanged()
		}
		p, err := s.loadProfile(ctx, accountID)
		if err != nil {
			return cxWritingBasisChanged()
		}
		hash, err := cxJSONHash(struct {
			Tags     []string `json:"tags"`
			Audience string   `json:"audience"`
			Tone     string   `json:"tone"`
			Banned   []string `json:"banned"`
			Style    string   `json:"style"`
		}{p.PositioningTags, p.TargetAudience, p.PersonaTone, p.BannedWords, p.StyleSummary})
		if err != nil || hash != profileHash {
			return cxWritingBasisChanged()
		}
		asOfAt = &p.UpdatedAt
	case "strategy":
		var rev int64
		var at time.Time
		sourceID, err := uuid.Parse(source.ID)
		if err != nil {
			return cxWritingBasisChanged()
		}
		if err := s.db.QueryRow(ctx, `SELECT version,created_at FROM account_strategy WHERE id=$1 AND account_id=$2 AND status='active'`, sourceID, accountID).Scan(&rev, &at); err != nil {
			return cxWritingBasisChanged()
		}
		revision, asOfAt = &rev, &at
	case "material":
		var at time.Time
		sourceID, err := uuid.Parse(source.ID)
		if err != nil {
			return cxWritingBasisChanged()
		}
		if err := s.db.QueryRow(ctx, `SELECT updated_at FROM material WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND (account_id IS NULL OR account_id=$3)`, sourceID, workspaceID, accountID).Scan(&at); err != nil {
			return cxWritingBasisChanged()
		}
		asOfAt = &at
	case "confirmed_memory":
		var at time.Time
		sourceID, err := uuid.Parse(source.ID)
		if err != nil {
			return cxWritingBasisChanged()
		}
		if err := s.db.QueryRow(ctx, `SELECT updated_at FROM account_memory WHERE id=$1 AND account_id=$2 AND status='active' AND confirmed_at IS NOT NULL`, sourceID, accountID).Scan(&at); err != nil {
			return cxWritingBasisChanged()
		}
		asOfAt = &at
	case "work_section":
		var workID uuid.UUID
		var at time.Time
		var rev int64
		sourceID, err := uuid.Parse(source.ID)
		if err != nil {
			return cxWritingBasisChanged()
		}
		if err := s.db.QueryRow(ctx, `SELECT s.work_id,s.revision,s.updated_at FROM work_section s JOIN work w ON w.id=s.work_id
			JOIN platform_account a ON a.id=w.account_id WHERE s.id=$1 AND a.workspace_id=$2 AND a.id=$3 AND s.deleted_at IS NULL AND w.deleted_at IS NULL`, sourceID, workspaceID, accountID).Scan(&workID, &rev, &at); err != nil {
			return cxWritingBasisChanged()
		}
		_ = workID
		revision, asOfAt = &rev, &at
	default:
		return cxWritingBasisChanged()
	}
	if source.Revision != nil && (revision == nil || *source.Revision != *revision) {
		return cxWritingBasisChanged()
	}
	if source.AsOfAt == nil || asOfAt == nil || !source.AsOfAt.Equal(*asOfAt) {
		return cxWritingBasisChanged()
	}
	return nil
}
