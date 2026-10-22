package app

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"

	"ops/internal/ai"
	"ops/internal/secure"
)

// 检索底座（10 文档第 3.4 节）：第一步为二元切分 + IDF 的混合打分；配置了 embedding 路由时叠加向量相似度。

var stopTerms = map[string]bool{
	"的是": true, "一个": true, "我们": true, "这个": true, "什么": true, "因为": true, "所以": true, "可以": true, "没有": true,
	"自己": true, "就是": true, "不是": true, "他们": true, "你们": true, "这样": true, "那么": true, "如果": true, "还是": true,
	"已经": true, "然后": true, "时候": true, "这些": true, "那些": true, "怎么": true, "为什么": true, "the": true, "and": true,
}

// terms splits text into CJK bigrams and lowercase latin words / numbers.
func terms(s string) map[string]bool {
	out := map[string]bool{}
	var han []rune
	var word []rune
	flushHan := func() {
		if len(han) == 1 {
			out[string(han)] = true
		}
		for i := 0; i+1 < len(han); i++ {
			t := string(han[i : i+2])
			if !stopTerms[t] {
				out[t] = true
			}
		}
		han = han[:0]
	}
	flushWord := func() {
		if len(word) >= 2 || (len(word) == 1 && unicode.IsDigit(word[0])) {
			t := strings.ToLower(string(word))
			if !stopTerms[t] {
				out[t] = true
			}
		}
		word = word[:0]
	}
	for _, r := range s {
		switch {
		case unicode.Is(unicode.Han, r):
			flushWord()
			han = append(han, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			flushHan()
			word = append(word, r)
		default:
			flushHan()
			flushWord()
		}
	}
	flushHan()
	flushWord()
	return out
}

type scoredDoc struct {
	terms   map[string]bool
	matched []string
	text    float64
}

// idfCoverage scores each doc by the IDF-weighted share of query terms it contains.
func idfCoverage(q map[string]bool, docs []*scoredDoc) {
	if len(q) == 0 || len(docs) == 0 {
		return
	}
	df := map[string]int{}
	for _, d := range docs {
		for t := range q {
			if d.terms[t] {
				df[t]++
			}
		}
	}
	n := float64(len(docs))
	idf := map[string]float64{}
	var total float64
	for t := range q {
		idf[t] = math.Log(1 + n/float64(1+df[t]))
		total += idf[t]
	}
	for _, d := range docs {
		var got float64
		d.matched = d.matched[:0]
		for t := range q {
			if d.terms[t] {
				got += idf[t]
				d.matched = append(d.matched, t)
			}
		}
		if total > 0 {
			d.text = got / total
		}
		sort.Slice(d.matched, func(i, j int) bool { return idf[d.matched[i]] > idf[d.matched[j]] })
	}
}

type RetrieveHit struct {
	Type    string     `json:"type"`
	ID      string     `json:"id"`
	Score   float64    `json:"score"`
	Reason  string     `json:"reason"`
	Content string     `json:"content,omitempty"`
	Kind    string     `json:"kind,omitempty"`
	Source  string     `json:"source,omitempty"`
	Tags    []string   `json:"tags,omitempty"`
	Title   string     `json:"title,omitempty"`
	Heading string     `json:"heading,omitempty"`
	Excerpt string     `json:"excerpt,omitempty"`
	WorkID  *uuid.UUID `json:"work_id,omitempty"`
}

func matchReason(matched []string, tagHits []string, semantic bool) string {
	var parts []string
	if len(matched) > 0 {
		n := min(3, len(matched))
		parts = append(parts, "命中「"+strings.Join(matched[:n], "」「")+"」")
	}
	if len(tagHits) > 0 {
		parts = append(parts, "标签："+strings.Join(tagHits, "、"))
	}
	if semantic {
		parts = append(parts, "语义相近")
	}
	return strings.Join(parts, "；")
}

type matCandidate struct {
	scoredDoc
	id      uuid.UUID
	account *uuid.UUID
	kind    string
	content string
	source  string
	tags    []string
	vec     float64
}

// likePatterns turns the most specific query terms into ILIKE patterns that pull older matches into the candidate set.
func likePatterns(q map[string]bool) []string {
	list := make([]string, 0, len(q))
	for t := range q {
		list = append(list, t)
	}
	sort.Slice(list, func(i, j int) bool {
		return len([]rune(list[i])) > len([]rune(list[j])) || (len([]rune(list[i])) == len([]rune(list[j])) && list[i] < list[j])
	})
	if len(list) > 12 {
		list = list[:12]
	}
	out := make([]string, len(list))
	for i, t := range list {
		out[i] = "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(t) + "%"
	}
	return out
}

// retrieveMaterials ranks the account's and shared materials: 0.6 文本 + 0.2 标签 + 0.1 同账号 + 0.1 近期使用.
// 文本分 = 0.85 × 二元切分 IDF 覆盖率 + 0.15 × pg_trgm 相似度（中文无词边界时后者为 0，只对拉丁词起作用）。
// Candidates are the newest 3000 plus up to 2000 older ones matching search_tsv or a query term.
func (s *Server) retrieveMaterials(ctx context.Context, a *Account, query string, exclude map[uuid.UUID]bool, limit int) ([]RetrieveHit, string, error) {
	q := terms(query)
	rows, err := s.db.Query(ctx, `WITH scope AS (
			SELECT * FROM material WHERE workspace_id=$1 AND deleted_at IS NULL AND (account_id IS NULL OR account_id=$2)
		), ids AS (
			(SELECT id FROM scope ORDER BY created_at DESC LIMIT 3000)
			UNION
			(SELECT id FROM scope WHERE search_tsv @@ plainto_tsquery('simple', $3) OR content ILIKE ANY($4) ORDER BY created_at DESC LIMIT 2000)
		)
		SELECT m.id, m.account_id, m.kind, m.content, m.source, m.tags, similarity(m.content, $3)
		FROM scope m JOIN ids USING (id)`,
		ident(ctx).WorkspaceID, a.ID, query, likePatterns(q))
	if err != nil {
		return nil, "", err
	}
	var cands []*matCandidate
	var docs []*scoredDoc
	trgm := map[*matCandidate]float64{}
	for rows.Next() {
		c := &matCandidate{}
		var sim float32
		if err := rows.Scan(&c.id, &c.account, &c.kind, &c.content, &c.source, &c.tags, &sim); err != nil {
			rows.Close()
			return nil, "", err
		}
		trgm[c] = float64(sim)
		if exclude[c.id] {
			continue
		}
		c.terms = terms(c.content + " " + c.source + " " + strings.Join(c.tags, " "))
		cands = append(cands, c)
		docs = append(docs, &c.scoredDoc)
	}
	rows.Close()
	recent := map[uuid.UUID]bool{}
	urows, err := s.db.Query(ctx, `SELECT DISTINCT unnest(material_ids) FROM work_section s JOIN work w ON w.id=s.work_id
		WHERE w.account_id=$1 AND s.updated_at > now() - interval '30 days'
		UNION SELECT wm.material_id FROM work_material wm JOIN work w ON w.id=wm.work_id WHERE w.account_id=$1 AND w.updated_at > now() - interval '30 days'`, a.ID)
	if err == nil {
		for urows.Next() {
			var id uuid.UUID
			if urows.Scan(&id) == nil {
				recent[id] = true
			}
		}
		urows.Close()
	}
	idfCoverage(q, docs)
	literal := map[*matCandidate]bool{}
	for _, c := range cands {
		sim := trgm[c]
		if c.text == 0 && sim < 0.3 {
			sim = 0
		}
		literal[c] = c.text == 0 && sim > 0
		c.text = 0.85*c.text + 0.15*sim
	}
	mode := "hybrid"
	if vecs, err := s.vectorScores(ctx, query, "material", cands); err == nil && vecs {
		mode = "vector"
	}
	lowerQ := strings.ToLower(query)
	var hits []RetrieveHit
	for _, c := range cands {
		var tagHits []string
		for _, t := range c.tags {
			if t != "" && strings.Contains(lowerQ, strings.ToLower(t)) {
				tagHits = append(tagHits, t)
			}
		}
		tagScore := 0.0
		if len(tagHits) > 0 {
			tagScore = 1
		}
		if c.text == 0 && tagScore == 0 && c.vec < 0.75 {
			continue
		}
		score := 0.6*c.text + 0.2*tagScore
		if c.account != nil && *c.account == a.ID {
			score += 0.1
		}
		if recent[c.id] {
			score += 0.1
		}
		if mode == "vector" {
			score = 0.5*score + 0.5*math.Max(0, c.vec)
		}
		reason := matchReason(c.matched, tagHits, mode == "vector" && c.vec >= 0.75 && c.text < 0.3)
		if reason == "" && literal[c] {
			reason = "字面相近"
		}
		hits = append(hits, RetrieveHit{Type: "material", ID: c.id.String(), Score: math.Round(score*1000) / 1000,
			Reason: reason, Content: c.content, Kind: c.kind, Source: c.source, Tags: c.tags})
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, mode, nil
}

// rankMaterials orders ids by relevance to query so the context assembler trims the least relevant first (3.1).
func (s *Server) rankMaterials(ctx context.Context, ids []uuid.UUID, query string) []uuid.UUID {
	if len(ids) < 2 || strings.TrimSpace(query) == "" {
		return ids
	}
	rows, err := s.db.Query(ctx, `SELECT id, content, source, tags FROM material WHERE id = ANY($1) AND deleted_at IS NULL`, ids)
	if err != nil {
		return ids
	}
	byID := map[uuid.UUID]*scoredDoc{}
	var docs []*scoredDoc
	for rows.Next() {
		var id uuid.UUID
		var content, source string
		var tags []string
		if rows.Scan(&id, &content, &source, &tags) != nil {
			continue
		}
		d := &scoredDoc{terms: terms(content + " " + source + " " + strings.Join(tags, " "))}
		byID[id] = d
		docs = append(docs, d)
	}
	rows.Close()
	idfCoverage(terms(query), docs)
	out := append([]uuid.UUID{}, ids...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := byID[out[i]], byID[out[j]]
		return a != nil && (b == nil || a.text > b.text)
	})
	return out
}

type historyHit struct {
	ID, Title, Heading, Excerpt string
	WorkID                      uuid.UUID
	Score                       float64
	Matched                     []string
}

// retrieveHistory finds the most similar past sections of the same account ("我以前怎么写过").
func (s *Server) retrieveHistory(ctx context.Context, a *Account, query string, excludeWork *uuid.UUID, limit int) ([]historyHit, error) {
	var ex uuid.UUID
	if excludeWork != nil {
		ex = *excludeWork
	}
	rows, err := s.db.Query(ctx, `SELECT s.id, w.id, w.title, s.heading, s.content_md FROM work_section s JOIN work w ON w.id=s.work_id
		WHERE w.account_id=$1 AND w.id<>$2 AND w.deleted_at IS NULL AND s.deleted_at IS NULL AND length(s.content_md) > 20
		ORDER BY w.updated_at DESC LIMIT 600`, a.ID, ex)
	if err != nil {
		return nil, err
	}
	type cand struct {
		scoredDoc
		h historyHit
		c string
	}
	var cands []*cand
	var docs []*scoredDoc
	for rows.Next() {
		c := &cand{}
		var id uuid.UUID
		if err := rows.Scan(&id, &c.h.WorkID, &c.h.Title, &c.h.Heading, &c.c); err != nil {
			rows.Close()
			return nil, err
		}
		c.h.ID = id.String()
		c.terms = terms(c.h.Heading + " " + c.c)
		cands = append(cands, c)
		docs = append(docs, &c.scoredDoc)
	}
	rows.Close()
	idfCoverage(terms(query), docs)
	var out []historyHit
	for _, c := range cands {
		if c.text < 0.15 {
			continue
		}
		c.h.Score = math.Round(c.text*1000) / 1000
		c.h.Excerpt = truncate(c.c, 300)
		c.h.Matched = append([]string{}, c.matched...)
		out = append(out, c.h)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *Server) retrieve(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Query      string      `json:"query"`
		Types      []string    `json:"types"`
		Limit      int         `json:"limit"`
		ExcludeIDs []uuid.UUID `json:"exclude_ids"`
		WorkID     *uuid.UUID  `json:"work_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Query = truncate(strings.TrimSpace(in.Query), 2000)
	if in.Query == "" {
		return ok(w, map[string]any{"items": []RetrieveHit{}, "mode": "hybrid"})
	}
	if in.Limit <= 0 || in.Limit > 30 {
		in.Limit = 8
	}
	if len(in.Types) == 0 {
		in.Types = []string{"material"}
	}
	ex := map[uuid.UUID]bool{}
	for _, id := range in.ExcludeIDs {
		ex[id] = true
	}
	ctx := r.Context()
	items := []RetrieveHit{}
	mode := "hybrid"
	for _, t := range in.Types {
		switch t {
		case "material":
			hits, m, err := s.retrieveMaterials(ctx, a, in.Query, ex, in.Limit)
			if err != nil {
				return err
			}
			mode = m
			items = append(items, hits...)
		case "history":
			hits, err := s.retrieveHistory(ctx, a, in.Query, in.WorkID, in.Limit)
			if err != nil {
				return err
			}
			for _, h := range hits {
				wid := h.WorkID
				items = append(items, RetrieveHit{Type: "history", ID: h.ID, Score: h.Score, Reason: matchReason(h.Matched, nil, false),
					Title: h.Title, Heading: h.Heading, Excerpt: h.Excerpt, WorkID: &wid})
			}
		}
	}
	return ok(w, map[string]any{"items": items, "mode": mode})
}

// ---------- 向量检索（DEV-V332）：未配置 embedding 路由时自动回退 ----------

type embedRoute struct {
	baseURL, apiKey, model string
}

func (s *Server) embeddingRoute(ctx context.Context) (*embedRoute, bool) {
	if request, ok := desktopRequestOf(ctx); ok {
		route, err := s.resolveDesktopRouteTier(ctx, "embedding", "", request)
		if err != nil || route.Desktop != nil {
			return nil, false
		}
		return &embedRoute{baseURL: route.BaseURL, apiKey: route.APIKey, model: route.Model}, true
	}
	var rt embedRoute
	var enc []byte
	err := s.db.QueryRow(ctx, `SELECT p.base_url, p.api_key_enc, r.model FROM model_route r JOIN model_provider p ON p.id=r.provider_id
		WHERE r.workspace_id=$1 AND r.task_type='embedding' AND p.execution_location='server' AND p.status='active'`, ident(ctx).WorkspaceID).Scan(&rt.baseURL, &enc, &rt.model)
	if err != nil {
		return nil, false
	}
	key, err := s.box.Decrypt(enc)
	if err != nil {
		return nil, false
	}
	rt.apiKey = key
	return &rt, true
}

func cosine(a, b []float32) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

// ensureEmbeddings returns cached vectors for cands, computing (and caching) at most 256 missing or stale ones.
func (s *Server) ensureEmbeddings(ctx context.Context, rt *embedRoute, objectType string, cands []*matCandidate) (map[uuid.UUID][]float32, error) {
	ids := make([]uuid.UUID, len(cands))
	for i, c := range cands {
		ids[i] = c.id
	}
	cached := map[uuid.UUID][]float32{}
	hashes := map[uuid.UUID]string{}
	rows, err := s.db.Query(ctx, `SELECT object_id, content_hash, embedding FROM content_embedding WHERE object_type=$1 AND object_id = ANY($2) AND chunk_no=0 AND model=$3`,
		objectType, ids, rt.model)
	if err == nil {
		for rows.Next() {
			var id uuid.UUID
			var h string
			var v []float32
			if rows.Scan(&id, &h, &v) == nil {
				cached[id], hashes[id] = v, h
			}
		}
		rows.Close()
	}
	var missing []*matCandidate
	for _, c := range cands {
		if hashes[c.id] != secure.SHA256Hex([]byte(c.content)) {
			missing = append(missing, c)
		}
	}
	if len(missing) > 256 {
		missing = missing[:256]
	}
	for start := 0; start < len(missing); start += 64 {
		batch := missing[start:min(start+64, len(missing))]
		inputs := make([]string, len(batch))
		for i, c := range batch {
			inputs[i] = truncate(c.content, 2000)
		}
		vecs, err := ai.Embed(ctx, s.aiHTTP, rt.baseURL, rt.apiKey, rt.model, inputs)
		if err != nil {
			return cached, err
		}
		for i, c := range batch {
			cached[c.id] = vecs[i]
			_, _ = s.db.Exec(ctx, `INSERT INTO content_embedding (workspace_id, object_type, object_id, chunk_no, content_hash, model, embedding)
				VALUES ($1,$2,$3,0,$4,$5,$6) ON CONFLICT (object_type, object_id, chunk_no) DO UPDATE SET content_hash=excluded.content_hash,
				model=excluded.model, embedding=excluded.embedding, updated_at=now()`,
				ident(ctx).WorkspaceID, objectType, c.id, secure.SHA256Hex([]byte(c.content)), rt.model, vecs[i])
		}
	}
	return cached, nil
}

func (s *Server) markEmbeddingStale(ctx context.Context, objectType string, id uuid.UUID) {
	_, _ = s.db.Exec(ctx, `DELETE FROM content_embedding WHERE object_type=$1 AND object_id=$2`, objectType, id)
}

// reindexEmbeddings precomputes material vectors for workspaces that configured an embedding route.
func (s *Server) reindexEmbeddings(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT r.workspace_id FROM model_route r JOIN model_provider p ON p.id=r.provider_id
		WHERE r.task_type='embedding' AND p.execution_location='server' AND p.status='active'`)
	if err != nil {
		return
	}
	var wss []uuid.UUID
	for rows.Next() {
		var ws uuid.UUID
		if rows.Scan(&ws) == nil {
			wss = append(wss, ws)
		}
	}
	rows.Close()
	for _, ws := range wss {
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
		rt, okRoute := s.embeddingRoute(jctx)
		if !okRoute {
			continue
		}
		mrows, err := s.db.Query(jctx, `SELECT m.id, m.content FROM material m WHERE m.workspace_id=$1 AND m.deleted_at IS NULL
			AND NOT EXISTS (SELECT 1 FROM content_embedding e WHERE e.object_type='material' AND e.object_id=m.id AND e.model=$2) LIMIT 256`, ws, rt.model)
		if err != nil {
			continue
		}
		var cands []*matCandidate
		for mrows.Next() {
			c := &matCandidate{}
			if mrows.Scan(&c.id, &c.content) == nil {
				cands = append(cands, c)
			}
		}
		mrows.Close()
		if len(cands) == 0 {
			continue
		}
		ectx, cancel := context.WithTimeout(jctx, time.Minute)
		if _, err := s.ensureEmbeddings(ectx, rt, "material", cands); err != nil {
			slog.Warn("后台向量化失败", "workspace", ws, "err", err)
		}
		cancel()
	}
}

// vectorScores fills c.vec for every candidate, computing and caching missing embeddings.
func (s *Server) vectorScores(ctx context.Context, query, objectType string, cands []*matCandidate) (bool, error) {
	rt, okRoute := s.embeddingRoute(ctx)
	if !okRoute || len(cands) == 0 {
		return false, nil
	}
	ectx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cached, err := s.ensureEmbeddings(ectx, rt, objectType, cands)
	if err != nil {
		slog.Warn("向量化失败，回退到全文检索", "err", err)
		return false, err
	}
	qv, err := ai.Embed(ectx, s.aiHTTP, rt.baseURL, rt.apiKey, rt.model, []string{query})
	if err != nil {
		return false, err
	}
	for _, c := range cands {
		if v, ok := cached[c.id]; ok {
			c.vec = cosine(qv[0], v)
		}
	}
	return true, nil
}
