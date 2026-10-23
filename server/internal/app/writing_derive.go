package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type deriveRule struct {
	SourcePlatform string
	SourceFormat   string
	TargetPlatform string
	TargetFormats  []string
}

var deriveMatrix = []deriveRule{
	{SourcePlatform: "wechat_mp", SourceFormat: "long_article", TargetPlatform: "xhs", TargetFormats: []string{"image_note"}},
	{SourcePlatform: "xhs", SourceFormat: "image_note", TargetPlatform: "wechat_mp", TargetFormats: []string{"long_article"}},
	{SourcePlatform: "wechat_mp", SourceFormat: "comic", TargetPlatform: "xhs", TargetFormats: []string{"comic"}},
	{SourcePlatform: "xhs", SourceFormat: "comic", TargetPlatform: "wechat_mp", TargetFormats: []string{"comic"}},
	{SourcePlatform: "wechat_mp", SourceFormat: "long_article", TargetPlatform: "toutiao", TargetFormats: []string{"long_article", "micro_post"}},
	{SourcePlatform: "xhs", SourceFormat: "image_note", TargetPlatform: "toutiao", TargetFormats: []string{"long_article", "micro_post"}},
	{SourcePlatform: "toutiao", SourceFormat: "long_article", TargetPlatform: "wechat_mp", TargetFormats: []string{"long_article"}},
	{SourcePlatform: "toutiao", SourceFormat: "long_article", TargetPlatform: "xhs", TargetFormats: []string{"image_note"}},
}

func deriveAllowed(src, dst *Account, srcFormat string) error {
	return deriveAllowedForFormat(src, dst, srcFormat, dst.ContentFormat)
}

func deriveAllowedForFormat(src, dst *Account, srcFormat, targetFormat string) error {
	if src.Platform == dst.Platform {
		return validation("派生只能在不同平台之间进行（同平台派生容易造成同质内容）")
	}
	for _, rule := range deriveMatrix {
		if src.Platform != rule.SourcePlatform || srcFormat != rule.SourceFormat || dst.Platform != rule.TargetPlatform {
			continue
		}
		for _, allowed := range rule.TargetFormats {
			if targetFormat == allowed && validFormat(dst.Platform, targetFormat) {
				return nil
			}
		}
	}
	return validation("这两种平台与内容形态之间不支持派生；请检查源稿形态和目标账号类型")
}

func (s *Server) deriveWork(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		TargetAccountID     uuid.UUID `json:"target_account_id"`
		TargetContentFormat *string   `json:"target_content_format"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	dst, err := s.account(ctx, in.TargetAccountID)
	if err != nil {
		return err
	}
	if dst.Status != "active" {
		return validation("目标账号已停用")
	}
	var srcFormat string
	if err := s.db.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1`, m.ID).Scan(&srcFormat); err != nil {
		return err
	}
	targetFormat := dst.ContentFormat
	if dst.Platform == "toutiao" {
		if in.TargetContentFormat == nil {
			return validation("派生到今日头条时必须选择文章或微头条")
		}
		targetFormat = *in.TargetContentFormat
	} else if in.TargetContentFormat != nil && *in.TargetContentFormat != dst.ContentFormat {
		return validation("目标平台作品类型必须使用该账号当前默认类型")
	}
	dstForWork := *dst
	dstForWork.ContentFormat = targetFormat
	if err := deriveAllowedForFormat(m.Account, &dstForWork, srcFormat, targetFormat); err != nil {
		return err
	}
	if srcFormat == "comic" {
		return s.deriveComicWork(w, r, m, &dstForWork)
	}
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return err
	}
	if len(secs) == 0 {
		return validation("源作品还没有正文，无法派生")
	}
	var b strings.Builder
	for _, x := range secs {
		fmt.Fprintf(&b, "【源段落 id=%s】小标题：%s\n%s\n", x.ID, x.Heading, truncate(x.ContentMD, 1200))
	}
	direction := "把源稿改写成目标平台的内容，保留论据并调整表达。"
	switch {
	case dst.Platform == "toutiao" && targetFormat == "long_article" && m.Account.Platform == "xhs":
		direction = "把小红书笔记已有要点展开为今日头条文章；缺少事实时注明待补素材，不虚构事实。"
	case dst.Platform == "toutiao" && targetFormat == "long_article":
		direction = "把公众号长文改写为今日头条文章，保留论述与事实来源并调整开头表达。"
	case dst.Platform == "toutiao" && targetFormat == "micro_post" && m.Account.Platform == "xhs":
		direction = "把小红书笔记整理为今日头条微头条短正文，不继承小红书专属引导语。"
	case dst.Platform == "toutiao" && targetFormat == "micro_post":
		direction = "把公众号长文压缩成一个清晰观点的今日头条微头条，保留事实出处，不新增事实。"
	case m.Account.Platform == "toutiao" && dst.Platform == "wechat_mp":
		direction = "把今日头条文章适配为公众号长文表达，保留论据并适配后续排版。"
	case m.Account.Platform == "toutiao" && dst.Platform == "xhs":
		direction = "把今日头条文章压缩为小红书图文笔记；另行选择图片并完成平台检查。"
	case dst.Platform == "wechat_mp":
		direction = "把小红书笔记扩写为公众号长文：4 到 8 个段落，每段有小标题，展开论述"
	}
	titleInstruction := "给出目标平台发布标题"
	if dst.Platform == "toutiao" && targetFormat == "micro_post" {
		titleInstruction = "给出便于系统内识别的微头条内部名称，不把它写入发布正文"
	}
	var viewpoint string
	_ = s.db.QueryRow(ctx, `SELECT viewpoint FROM work WHERE id=$1`, m.ID).Scan(&viewpoint)
	user := fmt.Sprintf(`## 源作品
源平台：%s（%s）
目标平台：%s（%s）
源标题：%s
核心观点：%s

%s
## 任务说明
 %s。规划目标作品的段落，并说明每个目标段落对应哪些源段落（source_section_ids 只能使用上面的 id）。%s%s。

## 输出格式
 只输出 JSON：{"title":"标题","sections":[{"source_section_ids":["id"],"key_point":"本段要点"}],"topics":["话题"]}`,
		platformNames[m.Account.Platform], srcFormat, platformNames[dst.Platform], targetFormat, m.Title, viewpoint, b.String(), direction, titleInstruction,
		map[bool]string{true: "；并提供用户可核对的话题建议", false: ""}[dst.Platform == "xhs" || dst.Platform == "toutiao"])
	var plan struct {
		Title    string `json:"title"`
		Sections []struct {
			SourceSectionIDs []string `json:"source_section_ids"`
			KeyPoint         string   `json:"key_point"`
		} `json:"sections"`
		Topics []string `json:"topics"`
	}
	valid := map[string]bool{}
	revOf := map[string]int{}
	for _, x := range secs {
		valid[x.ID.String()] = true
		revOf[x.ID.String()] = x.Revision
	}
	if _, err := s.runAIJSON(ctx, aiTask{Type: "rewrite_plan", Account: &dstForWork, User: user}, &plan, func() error {
		if len(plan.Sections) == 0 {
			return fmt.Errorf("没有段落")
		}
		return nil
	}); err != nil {
		return err
	}
	var newID uuid.UUID
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		topics := []string{}
		if dst.Platform == "xhs" || dst.Platform == "toutiao" {
			topics = cleanList(plan.Topics)
		}
		var sourceTopic *uuid.UUID
		var sourceRevision int
		var sourceViewpoint string
		if err := tx.QueryRow(ctx, `SELECT topic_id, revision, viewpoint FROM work WHERE id=$1`, m.ID).Scan(&sourceTopic, &sourceRevision, &sourceViewpoint); err != nil {
			return err
		}
		// NW-E1：派生作品复用统一创建路径，确保账号门禁、默认设置与来源审计一致。
		newID, err = s.insertWorkTx(ctx, tx, &dstForWork, sourceTopic, plan.Title, targetFormat, "", "", "derive")
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE work SET source_work_id=$2, source_revision=$3, viewpoint=$4, outline_confirmed_at=now(), topics=$5 WHERE id=$1`,
			newID, m.ID, sourceRevision, sourceViewpoint, topics); err != nil {
			return err
		}
		var outline []OutlineItem
		for i, ps := range plan.Sections {
			ids := []uuid.UUID{}
			atMs, err := s.dbNowMillis(ctx, tx)
			if err != nil {
				return err
			}
			revs := map[string]int{revsAtKey: atMs}
			for _, sid := range ps.SourceSectionIDs {
				if valid[sid] {
					ids = append(ids, uuid.MustParse(sid))
					revs[sid] = revOf[sid]
				}
			}
			heading := ""
			if dst.Platform == "wechat_mp" {
				heading = truncateRunes(ps.KeyPoint, 24)
			}
			rb, _ := json.Marshal(revs)
			var sid uuid.UUID
			if err := tx.QueryRow(ctx, `INSERT INTO work_section (work_id, position, heading, key_point, source_section_ids, source_revisions) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
				newID, i, heading, ps.KeyPoint, ids, rb).Scan(&sid); err != nil {
				return err
			}
			outline = append(outline, OutlineItem{Heading: nz(heading, truncateRunes(ps.KeyPoint, 24)), KeyPoint: ps.KeyPoint, MaterialIDs: []string{}, SectionID: sid.String()})
		}
		ob, _ := json.Marshal(outline)
		if _, err := tx.Exec(ctx, `UPDATE work SET outline=$2 WHERE id=$1`, newID, ob); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO work_material (work_id, material_id) SELECT $1, wm.material_id FROM work_material wm
			JOIN material mt ON mt.id=wm.material_id WHERE wm.work_id=$2 AND (mt.account_id IS NULL OR mt.account_id=$3)`, newID, m.ID, dst.ID)
		return err
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "work_derive", "work", newID.String(), "ok", map[string]any{"source": m.ID.String(), "kind": "derive"})
	return s.writeWork(w, r, newID)
}

// rewriteSection is step two of derivation; also used for "重新改写本段".
func (s *Server) rewriteSection(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	if m.SourceWorkID == nil {
		return validation("这篇作品不是派生作品")
	}
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT id, heading, content_md, revision FROM work_section WHERE work_id=$1 AND id = ANY($2) AND deleted_at IS NULL ORDER BY position`,
		*m.SourceWorkID, sec.SourceSectionIDs)
	if err != nil {
		return err
	}
	var b strings.Builder
	atMs, err := s.dbNowMillis(ctx, nil)
	if err != nil {
		return err
	}
	srcRevs := map[string]int{revsAtKey: atMs}
	for rows.Next() {
		var id uuid.UUID
		var h, c string
		var rev int
		if err := rows.Scan(&id, &h, &c, &rev); err == nil {
			fmt.Fprintf(&b, "【源段落 id=%s】小标题：%s\n%s\n", id, h, truncate(c, 2000))
			srcRevs[id.String()] = rev
		}
	}
	rows.Close()
	var srcPlatform string
	_ = s.db.QueryRow(ctx, `SELECT a.platform FROM work w JOIN platform_account a ON a.id=w.account_id WHERE w.id=$1`, *m.SourceWorkID).Scan(&srcPlatform)
	format := "Markdown 正文，不写本段小标题，300 到 600 字"
	if m.Account.Platform == "xhs" {
		format = "纯文本，不使用 Markdown 标记，80 到 200 字，口语化，可以用表情符号"
	}
	user := fmt.Sprintf(`## 改写
源平台：%s
目标平台：%s
本段要点：%s

%s
## 任务说明
按目标账号的定位和风格，把上面的源段落改写为目标平台的一段内容。只保留源段落中的事实，不新增事实。

## 输出格式
%s。直接输出正文。`, platformNames[srcPlatform], platformNames[m.Account.Platform], sec.KeyPoint, nz(b.String(), "（源段落已删除）\n"), format)
	return s.streamAIJob(w, r, aiTask{Type: "section_rewrite", Account: m.Account, WorkID: &m.ID, User: user, Refs: map[string]any{"section_id": sec.ID}},
		jobMeta{SectionID: &sec.ID, Label: "改写「" + truncate(nz(sec.Heading, sec.KeyPoint), 16) + "」", Link: "/works/" + m.ID.String() + "/derive"},
		func(text string, res *aiResult) (any, error) {
			bg := context.WithoutCancel(ctx)
			rb, _ := json.Marshal(srcRevs)
			return s.saveAIContent(bg, sec, m, text, res, rb)
		})
}

type FamilyMember struct {
	ID        uuid.UUID  `json:"id"`
	SourceID  *uuid.UUID `json:"source_id"`
	Title     string     `json:"title"`
	Status    string     `json:"status"`
	Platform  string     `json:"platform"`
	Account   string     `json:"account"`
	Depth     int        `json:"depth"`
	NeedsSync bool       `json:"needs_sync"`
}

// workFamily walks up to the root work and lists every derived descendant (EX-F-04), within the workspace.
func (s *Server) workFamily(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	ws := ident(ctx).WorkspaceID
	var root uuid.UUID
	if err := s.db.QueryRow(ctx, `WITH RECURSIVE up AS (
			SELECT w.id, w.source_work_id, 0 AS d FROM work w WHERE w.id=$1
			UNION ALL
			SELECT p.id, p.source_work_id, up.d+1 FROM work p JOIN up ON p.id=up.source_work_id
			JOIN platform_account a ON a.id=p.account_id
			WHERE p.deleted_at IS NULL AND a.workspace_id=$2 AND up.d < 20)
		SELECT id FROM up ORDER BY d DESC LIMIT 1`, m.ID, ws).Scan(&root); err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `WITH RECURSIVE down AS (
			SELECT w.id, 0 AS d FROM work w WHERE w.id=$1
			UNION ALL
			SELECT c.id, down.d+1 FROM work c JOIN down ON c.source_work_id=down.id WHERE c.deleted_at IS NULL AND down.d < 20)
		SELECT w.id, w.source_work_id, w.title, w.status, a.platform, a.name, down.d,
			coalesce(sw.deleted_at IS NULL AND w.source_revision > 0 AND sw.revision > w.source_revision, false)
		FROM down JOIN work w ON w.id=down.id JOIN platform_account a ON a.id=w.account_id
		LEFT JOIN work sw ON sw.id=w.source_work_id
		WHERE a.workspace_id=$2 ORDER BY down.d, w.created_at`, root, ws)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []FamilyMember{}
	for rows.Next() {
		var x FamilyMember
		if err := rows.Scan(&x.ID, &x.SourceID, &x.Title, &x.Status, &x.Platform, &x.Account, &x.Depth, &x.NeedsSync); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

// revsAtKey stores, inside source_revisions, the unix milliseconds of the derive / rewrite the revisions belong to.
const revsAtKey = "@at"

// sourceDiff returns, per derived section, whether its source sections changed since the last rewrite (EX-F-01).
// dbNowMillis reads the database clock. source_revisions 的基线与 section_revision.created_at
// 必须同一时钟：应用时钟与数据库时钟（容器）存在毫秒级漂移时，用应用时间做基线会让
// sectionContentAt 把编辑后的内容当成派生时的旧内容（源稿对照出现误报）。
func (s *Server) dbNowMillis(ctx context.Context, q pgx.Tx) (int, error) {
	var ms int64
	var err error
	if q != nil {
		err = q.QueryRow(ctx, `SELECT (extract(epoch from now())*1000)::bigint`).Scan(&ms)
	} else {
		err = s.db.QueryRow(ctx, `SELECT (extract(epoch from now())*1000)::bigint`).Scan(&ms)
	}
	return int(ms), err
}

func (s *Server) sourceDiff(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.SourceWorkID == nil {
		return validation("这篇作品不是派生作品")
	}
	ctx := r.Context()
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return err
	}
	src, err := s.loadSections(ctx, nil, *m.SourceWorkID)
	if err != nil {
		return err
	}
	byID := map[string]Section{}
	for _, x := range src {
		byID[x.ID.String()] = x
	}
	type srcChange struct {
		SourceID   string `json:"source_id"`
		Heading    string `json:"heading"`
		Changed    bool   `json:"changed"`
		Deleted    bool   `json:"deleted"`
		OldContent string `json:"old_content"`
		NewContent string `json:"new_content"`
	}
	type item struct {
		SectionID string      `json:"section_id"`
		Changed   bool        `json:"changed"`
		Sources   []srcChange `json:"sources"`
	}
	out := []item{}
	for _, x := range secs {
		var revs map[string]int
		_ = json.Unmarshal(x.SourceRevisions, &revs)
		// 基线时间：派生 / 改写当时记录的时间；旧数据没有记录时退回到本段最后修改时间。
		baseline := x.UpdatedAt
		if at, okAt := revs[revsAtKey]; okAt {
			baseline = time.UnixMilli(int64(at))
		}
		it := item{SectionID: x.ID.String(), Sources: []srcChange{}}
		for _, sid := range x.SourceSectionIDs {
			cur, okSrc := byID[sid.String()]
			c := srcChange{SourceID: sid.String()}
			if !okSrc {
				c.Deleted, c.Changed = true, true
			} else {
				c.Heading = cur.Heading
				c.NewContent = cur.ContentMD
				old, had := revs[sid.String()]
				if (had && cur.Revision > old) || (!had && cur.UpdatedAt.After(baseline)) {
					c.Changed = true
					c.OldContent = s.sectionContentAt(ctx, sid, baseline)
				}
			}
			if c.Changed {
				it.Changed = true
			}
			it.Sources = append(it.Sources, c)
		}
		out = append(out, it)
	}
	return ok(w, out)
}

// sectionContentAt is the source section's content as of the derived section's last rewrite (from section history).
func (s *Server) sectionContentAt(ctx context.Context, sectionID uuid.UUID, at time.Time) string {
	var c string
	if err := s.db.QueryRow(ctx, `SELECT content_md FROM section_revision WHERE section_id=$1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 1`,
		sectionID, at).Scan(&c); err != nil {
		return ""
	}
	return c
}
