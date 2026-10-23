package app

import (
	"context"
	"encoding/base64"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// 全局搜索（第 4.2 节）与收藏（EX-M-04）。只返回当前工作区的数据，viewer 也可用。

type SearchHit struct {
	Type          string     `json:"type"`
	ID            uuid.UUID  `json:"id"`
	Title         string     `json:"title"`
	Snippet       string     `json:"snippet"`
	AccountID     *uuid.UUID `json:"account_id"`
	AccountName   string     `json:"account_name"`
	Platform      string     `json:"platform,omitempty"`
	ContentFormat string     `json:"content_format,omitempty"`
	Status        string     `json:"status,omitempty"`
	Link          string     `json:"link"`
	Score         float64    `json:"score"`
	Matched       []string   `json:"matched"`
	Starred       bool       `json:"starred"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// searchPatterns turns a query into ILIKE patterns: the whole query plus its most selective bigrams.
func searchPatterns(q string) []string {
	pats := []string{"%" + escapeLike(q) + "%"}
	ts := terms(q)
	list := make([]string, 0, len(ts))
	for t := range ts {
		list = append(list, t)
	}
	sort.Strings(list)
	for i, t := range list {
		if i >= 24 {
			break
		}
		pats = append(pats, "%"+escapeLike(t)+"%")
	}
	return pats
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// searchCursor 是 XC-01 的游标：按「分数降序 + 类型 + ID」这个稳定全序定位，避免截断。
type searchCursor struct {
	Score float64
	Type  string
	ID    uuid.UUID
}

func parseSearchCursor(raw string) (*searchCursor, error) {
	if raw == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, validation("分页游标无效")
	}
	parts := strings.Split(string(b), "|")
	if len(parts) != 3 {
		return nil, validation("分页游标无效")
	}
	score, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return nil, validation("分页游标无效")
	}
	itemID, err := uuid.Parse(parts[2])
	if err != nil {
		return nil, validation("分页游标无效")
	}
	return &searchCursor{Score: score, Type: parts[1], ID: itemID}, nil
}

func encodeSearchCursor(h SearchHit) string {
	raw := strconv.FormatFloat(h.Score, 'g', -1, 64) + "|" + h.Type + "|" + h.ID.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// searchAfter 判断 h 是否严格排在游标之后（分数降序，同分按类型、ID 升序）。
func searchAfter(h SearchHit, c *searchCursor) bool {
	if h.Score != c.Score {
		return h.Score < c.Score
	}
	if h.Type != c.Type {
		return h.Type > c.Type
	}
	return h.ID.String() > c.ID.String()
}

// snippetAround returns ~80 runes around the first occurrence of any matched term.
func snippetAround(text string, matched []string, q string) string {
	text = strings.Join(strings.Fields(text), " ")
	lower := strings.ToLower(text)
	idx := strings.Index(lower, strings.ToLower(q))
	for _, m := range append([]string{}, matched...) {
		if idx >= 0 {
			break
		}
		idx = strings.Index(lower, m)
	}
	r := []rune(text)
	if idx < 0 {
		return truncate(text, 80)
	}
	start := max(0, runeLen(text[:idx])-30)
	end := min(len(r), start+90)
	out := string(r[start:end])
	if start > 0 {
		out = "…" + out
	}
	if end < len(r) {
		out += "…"
	}
	return out
}

func (s *Server) globalSearch(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	qv := r.URL.Query()
	q := queryText(r, "q")
	if q == "" {
		return ok(w, map[string]any{"items": []SearchHit{}})
	}
	q = truncate(q, 200)
	limit := queryInt(r, "limit", 20)
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	// XC-01：游标分页。limit 之外多取一条，用来判断"还有更多"。
	cursor, err := parseSearchCursor(qv.Get("cursor"))
	if err != nil {
		return err
	}
	types := map[string]bool{"work": true, "topic": true, "material": true, "style_sample": true}
	if t := qv.Get("types"); t != "" {
		types = map[string]bool{}
		for _, x := range strings.Split(t, ",") {
			types[strings.TrimSpace(x)] = true
		}
	}
	var accountID *uuid.UUID
	if aid := qv.Get("account_id"); aid != "" {
		if u, err := uuid.Parse(aid); err == nil {
			accountID = &u
		}
	}
	status := qv.Get("status")
	var since time.Time
	if d := queryInt(r, "days", 0); d > 0 {
		since = s.now().AddDate(0, 0, -d)
	}
	ws := ident(ctx).WorkspaceID
	pats := searchPatterns(q)
	type cand struct {
		scoredDoc
		hit  SearchHit
		body string
	}
	var cands []*cand
	add := func(h SearchHit, body string) {
		if (status != "" && h.Status != status) || (!since.IsZero() && h.UpdatedAt.Before(since)) {
			return
		}
		c := &cand{hit: h, body: body}
		c.terms = terms(h.Title + " " + body)
		cands = append(cands, c)
	}
	if types["work"] {
		rows, err := s.db.Query(ctx, `SELECT w.id, w.title, w.status, a.id, a.name, w.updated_at,
			coalesce((SELECT string_agg(s.heading || ' ' || s.content_md, ' ' ORDER BY s.position) FROM work_section s WHERE s.work_id=w.id AND s.deleted_at IS NULL), '') || ' ' || array_to_string(w.tags, ' '), a.platform,w.content_format
			FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE a.workspace_id=$1 AND w.deleted_at IS NULL AND ($3::uuid IS NULL OR a.id=$3)
			AND (w.title ILIKE ANY($2) OR w.viewpoint ILIKE ANY($2) OR array_to_string(w.tags, ' ') ILIKE ANY($2) OR EXISTS (SELECT 1 FROM work_section s WHERE s.work_id=w.id AND s.deleted_at IS NULL AND s.content_md ILIKE ANY($2)))
			ORDER BY w.updated_at DESC LIMIT 300`, ws, pats, accountID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var h SearchHit
			var aid uuid.UUID
			var body string
			if err := rows.Scan(&h.ID, &h.Title, &h.Status, &aid, &h.AccountName, &h.UpdatedAt, &body, &h.Platform, &h.ContentFormat); err == nil {
				h.Type, h.AccountID, h.Link = "work", &aid, "/works/"+h.ID.String()
				h.Title = nz(h.Title, "未命名作品")
				add(h, body)
			}
		}
		rows.Close()
	}
	if types["topic"] {
		rows, err := s.db.Query(ctx, `SELECT t.id, t.title, t.status, a.id, a.name, t.updated_at, t.angle || ' ' || t.hook || ' ' || t.audience,a.platform,t.format
			FROM topic t JOIN platform_account a ON a.id=t.account_id
			WHERE a.workspace_id=$1 AND t.deleted_at IS NULL AND ($3::uuid IS NULL OR a.id=$3)
			AND (t.title ILIKE ANY($2) OR t.angle ILIKE ANY($2) OR t.hook ILIKE ANY($2)) ORDER BY t.updated_at DESC LIMIT 300`, ws, pats, accountID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var h SearchHit
			var aid uuid.UUID
			var body string
			if err := rows.Scan(&h.ID, &h.Title, &h.Status, &aid, &h.AccountName, &h.UpdatedAt, &body, &h.Platform, &h.ContentFormat); err == nil {
				h.Type, h.AccountID, h.Link = "topic", &aid, "/a/"+aid.String()+"/topics?focus="+h.ID.String()
				add(h, body)
			}
		}
		rows.Close()
	}
	if types["material"] {
		rows, err := s.db.Query(ctx, `SELECT m.id, m.content, m.kind, m.account_id, coalesce(a.name,'共享'), m.updated_at, m.source || ' ' || array_to_string(m.tags,' ')
			FROM material m LEFT JOIN platform_account a ON a.id=m.account_id
			WHERE m.workspace_id=$1 AND m.deleted_at IS NULL AND ($3::uuid IS NULL OR m.account_id=$3 OR m.account_id IS NULL)
			AND (m.content ILIKE ANY($2) OR m.source ILIKE ANY($2) OR array_to_string(m.tags,' ') ILIKE ANY($2)) ORDER BY m.updated_at DESC LIMIT 300`, ws, pats, accountID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var h SearchHit
			var content, extra string
			if err := rows.Scan(&h.ID, &content, &h.Status, &h.AccountID, &h.AccountName, &h.UpdatedAt, &extra); err == nil {
				h.Type, h.Title = "material", truncate(content, 40)
				link := "/materials?focus=" + h.ID.String()
				if h.AccountID != nil {
					link = "/a/" + h.AccountID.String() + link
				} else if accountID != nil {
					link = "/a/" + accountID.String() + link
				}
				h.Link = link
				add(h, content+" "+extra)
			}
		}
		rows.Close()
	}
	if types["style_sample"] {
		rows, err := s.db.Query(ctx, `SELECT st.id, st.title, a.id, a.name, st.updated_at, st.content_md
			FROM style_sample st JOIN platform_account a ON a.id=st.account_id
			WHERE a.workspace_id=$1 AND st.deleted_at IS NULL AND ($3::uuid IS NULL OR a.id=$3)
			AND (st.title ILIKE ANY($2) OR st.content_md ILIKE ANY($2)) ORDER BY st.updated_at DESC LIMIT 100`, ws, pats, accountID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var h SearchHit
			var aid uuid.UUID
			var body string
			if err := rows.Scan(&h.ID, &h.Title, &aid, &h.AccountName, &h.UpdatedAt, &body); err == nil {
				h.Type, h.AccountID, h.Link = "style_sample", &aid, "/a/"+aid.String()+"/profile"
				add(h, body)
			}
		}
		rows.Close()
	}
	docs := make([]*scoredDoc, len(cands))
	for i, c := range cands {
		docs[i] = &c.scoredDoc
	}
	idfCoverage(terms(q), docs)
	starred := s.starredSet(ctx)
	lq := strings.ToLower(q)
	out := []SearchHit{}
	for _, c := range cands {
		score := c.text
		if strings.Contains(strings.ToLower(c.hit.Title), lq) {
			score += 0.6
		} else if strings.Contains(strings.ToLower(c.body), lq) {
			score += 0.4
		}
		if score < 0.2 {
			continue
		}
		if starred[c.hit.Type+":"+c.hit.ID.String()] {
			c.hit.Starred = true
			score += 0.1
		}
		c.hit.Score = score
		c.hit.Matched = append([]string{}, c.matched...)
		c.hit.Snippet = snippetAround(c.body, c.matched, q)
		out = append(out, c.hit)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		if out[i].Type != out[j].Type {
			return out[i].Type < out[j].Type
		}
		return out[i].ID.String() < out[j].ID.String()
	})
	// XC-01：先按游标跳过已返回的部分，再多取一条判断是否还有下一页。
	var nextCursor *string
	if cursor != nil {
		filtered := out[:0]
		for _, h := range out {
			if searchAfter(h, cursor) {
				filtered = append(filtered, h)
			}
		}
		out = filtered
	}
	if len(out) > limit {
		out = out[:limit]
		last := encodeSearchCursor(out[len(out)-1])
		nextCursor = &last
	}
	return ok(w, map[string]any{"items": out, "next_cursor": nextCursor})
}

func (s *Server) starredSet(ctx context.Context) map[string]bool {
	out := map[string]bool{}
	id := ident(ctx)
	rows, err := s.db.Query(ctx, `SELECT object_type, object_id FROM star WHERE user_id=$1 AND workspace_id=$2`, id.UserID, id.WorkspaceID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var t string
		var oid uuid.UUID
		if rows.Scan(&t, &oid) == nil {
			out[t+":"+oid.String()] = true
		}
	}
	return out
}

type StarItem struct {
	ObjectType string     `json:"object_type"`
	ObjectID   uuid.UUID  `json:"object_id"`
	Title      string     `json:"title"`
	AccountID  *uuid.UUID `json:"account_id"`
	Link       string     `json:"link"`
	CreatedAt  time.Time  `json:"created_at"`
}

func (s *Server) listStars(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	rows, err := s.db.Query(ctx, `SELECT st.object_type, st.object_id, st.created_at,
		coalesce(w.title, t.title, left(m.content, 40), ''), coalesce(w.account_id, t.account_id, m.account_id)
		FROM star st
		LEFT JOIN work w ON st.object_type='work' AND w.id=st.object_id AND w.deleted_at IS NULL
		LEFT JOIN topic t ON st.object_type='topic' AND t.id=st.object_id AND t.deleted_at IS NULL
		LEFT JOIN material m ON st.object_type='material' AND m.id=st.object_id AND m.deleted_at IS NULL
		WHERE st.user_id=$1 AND st.workspace_id=$2 AND coalesce(w.id, t.id, m.id) IS NOT NULL ORDER BY st.created_at DESC LIMIT 100`, id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []StarItem{}
	for rows.Next() {
		var x StarItem
		if err := rows.Scan(&x.ObjectType, &x.ObjectID, &x.CreatedAt, &x.Title, &x.AccountID); err != nil {
			return err
		}
		switch x.ObjectType {
		case "work":
			x.Link = "/works/" + x.ObjectID.String()
			x.Title = nz(x.Title, "未命名作品")
		case "topic":
			if x.AccountID != nil {
				x.Link = "/a/" + x.AccountID.String() + "/topics?focus=" + x.ObjectID.String()
			}
		case "material":
			if x.AccountID != nil {
				x.Link = "/a/" + x.AccountID.String() + "/materials?focus=" + x.ObjectID.String()
			}
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) addStar(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		ObjectType string    `json:"object_type"`
		ObjectID   uuid.UUID `json:"object_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	id := ident(ctx)
	var q string
	switch in.ObjectType {
	case "work":
		q = `SELECT w.id FROM work w JOIN platform_account a ON a.id=w.account_id WHERE w.id=$1 AND a.workspace_id=$2`
	case "topic":
		q = `SELECT t.id FROM topic t JOIN platform_account a ON a.id=t.account_id WHERE t.id=$1 AND a.workspace_id=$2`
	case "material":
		q = `SELECT id FROM material WHERE id=$1 AND workspace_id=$2`
	default:
		return validation("只能收藏作品、选题或素材")
	}
	var x uuid.UUID
	if err := s.db.QueryRow(ctx, q, in.ObjectID, id.WorkspaceID).Scan(&x); err != nil {
		return errNotFound
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO star (user_id, workspace_id, object_type, object_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
		id.UserID, id.WorkspaceID, in.ObjectType, in.ObjectID); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) removeStar(w http.ResponseWriter, r *http.Request) error {
	oid, err := pathID(r, "id")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if _, err := s.db.Exec(r.Context(), `DELETE FROM star WHERE user_id=$1 AND object_type=$2 AND object_id=$3`, id.UserID, chiParam(r, "type"), oid); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}
