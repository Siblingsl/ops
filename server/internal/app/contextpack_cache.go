package app

import (
	"context"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// BE-05 短 TTL 上下文片段缓存（docs/33 §3.5 / BE-05）。
// 与 lastPacks（提示词回归快照）分离；键含 workspace_id；个人技能不进此缓存
//（技能槽仍只来自 skillSnapshotFromCtx）。默认开启；OPS_CONTEXT_PACK_CACHE=0 关闭。
// 失效用显式 invalidate（写路径 + afterAISuccess 记忆计数）+ 短 TTL 兜底。

const contextPackCacheTTL = 3 * time.Second

type contextPackBasis struct {
	Prof     *Profile
	Strategy *Strategy
	Mems     []Memory
	Prefs    []DataPreference
	Samples  []perfTopSample
}

type contextPackCacheEntry struct {
	expires time.Time
	basis   contextPackBasis
}

type contextPackCache struct {
	mu      sync.Mutex
	entries map[string]contextPackCacheEntry
	ttl     time.Duration
	now     func() time.Time
	enabled bool
	hits    int
	misses  int
}

func newContextPackCache(now func() time.Time) *contextPackCache {
	if now == nil {
		now = time.Now
	}
	return &contextPackCache{
		entries: map[string]contextPackCacheEntry{},
		ttl:     contextPackCacheTTL,
		now:     now,
		enabled: contextPackCacheEnabledFromEnv(),
	}
}

func contextPackCacheEnabledFromEnv() bool {
	v := strings.TrimSpace(os.Getenv("OPS_CONTEXT_PACK_CACHE"))
	if v == "0" || strings.EqualFold(v, "false") || strings.EqualFold(v, "off") {
		return false
	}
	return true
}

func contextPackBasisKey(workspaceID, accountID uuid.UUID, targetFormat, scope string, factsOnly, prefOn, perfOn bool, workID *uuid.UUID) string {
	work := ""
	if workID != nil {
		work = workID.String()
	}
	facts, pref, perf := "0", "0", "0"
	if factsOnly {
		facts = "1"
	}
	if prefOn {
		pref = "1"
	}
	if perfOn {
		perf = "1"
	}
	return workspaceID.String() + "|" + accountID.String() + "|" + targetFormat + "|" + scope + "|" + facts + "|" + pref + "|" + perf + "|" + work
}

func (c *contextPackCache) get(key string) (contextPackBasis, bool) {
	if c == nil || !c.enabled {
		return contextPackBasis{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	ent, ok := c.entries[key]
	if !ok {
		c.misses++
		return contextPackBasis{}, false
	}
	if !c.now().Before(ent.expires) {
		delete(c.entries, key)
		c.misses++
		return contextPackBasis{}, false
	}
	c.hits++
	return cloneContextPackBasis(ent.basis), true
}

func (c *contextPackCache) put(key string, basis contextPackBasis) {
	if c == nil || !c.enabled {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = contextPackCacheEntry{
		expires: c.now().Add(c.ttl),
		basis:   cloneContextPackBasis(basis),
	}
}

func (c *contextPackCache) invalidateAccount(workspaceID, accountID uuid.UUID) {
	if c == nil || workspaceID == uuid.Nil || accountID == uuid.Nil {
		return
	}
	prefix := workspaceID.String() + "|" + accountID.String() + "|"
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.entries {
		if strings.HasPrefix(k, prefix) {
			delete(c.entries, k)
		}
	}
}

func (c *contextPackCache) stats() (hits, misses, size int) {
	if c == nil {
		return 0, 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hits, c.misses, len(c.entries)
}

func (s *Server) invalidateContextPackCache(ctx context.Context, accountID uuid.UUID) {
	if s == nil || s.contextPacks == nil || accountID == uuid.Nil {
		return
	}
	id := ident(ctx)
	if id == nil || id.WorkspaceID == uuid.Nil {
		return
	}
	s.contextPacks.invalidateAccount(id.WorkspaceID, accountID)
}

func cloneContextPackBasis(in contextPackBasis) contextPackBasis {
	out := contextPackBasis{}
	if in.Prof != nil {
		p := *in.Prof
		// nil/空 slice 与 JSON 往返等价性：DB 读出的空 text[] 是非 nil `[]`，
		// append(nil-slice, 空...) 会把它 nil 化（marshal 成 null），导致
		// verifyCXWritingSource 的五字段哈希在缓存命中路径与 DB 路径不一致
		//（CF-AW-06 收口实测暴露）。copy 保留空 slice 的非 nil 语义。
		p.PositioningTags = make([]string, len(in.Prof.PositioningTags))
		copy(p.PositioningTags, in.Prof.PositioningTags)
		p.BannedWords = make([]string, len(in.Prof.BannedWords))
		copy(p.BannedWords, in.Prof.BannedWords)
		if in.Prof.TopicStockPolicy != nil {
			pol := *in.Prof.TopicStockPolicy
			p.TopicStockPolicy = &pol
		}
		out.Prof = &p
	}
	if in.Strategy != nil {
		st := *in.Strategy
		st.Pillars = append([]Pillar(nil), in.Strategy.Pillars...)
		st.Goals = append([]string(nil), in.Strategy.Goals...)
		st.Benchmarks = append([]Benchmark(nil), in.Strategy.Benchmarks...)
		st.Keywords = append([]string(nil), in.Strategy.Keywords...)
		st.Taboo = append([]string(nil), in.Strategy.Taboo...)
		st.BlockedWords = append([]string(nil), in.Strategy.BlockedWords...)
		st.Cadence.Days = append([]int(nil), in.Strategy.Cadence.Days...)
		if in.Strategy.DailySettings != nil {
			st.DailySettings = map[string]any{}
			for k, v := range in.Strategy.DailySettings {
				st.DailySettings[k] = v
			}
		}
		if in.Strategy.HotEnabled != nil {
			h := *in.Strategy.HotEnabled
			st.HotEnabled = &h
		}
		out.Strategy = &st
	}
	if len(in.Mems) > 0 {
		out.Mems = make([]Memory, len(in.Mems))
		copy(out.Mems, in.Mems)
		for i := range out.Mems {
			if in.Mems[i].Evidence != nil {
				out.Mems[i].Evidence = append([]byte(nil), in.Mems[i].Evidence...)
			}
		}
	}
	if len(in.Prefs) > 0 {
		out.Prefs = append([]DataPreference(nil), in.Prefs...)
	}
	if len(in.Samples) > 0 {
		out.Samples = append([]perfTopSample(nil), in.Samples...)
	}
	return out
}
