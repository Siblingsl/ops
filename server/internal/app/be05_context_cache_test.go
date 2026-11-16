package app

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// BE-05 短 TTL 缓存：命中后提示词字节不变、跨工作区隔离、写路径显式失效、开关可关。

func TestBE05ContextPackCacheHitPreservesBytes(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")
	t.Setenv("OPS_CONTEXT_PACK_CACHE", "1")
	env.srv.contextPacks = newContextPackCache(env.srv.now)

	userID := uuid.MustParse(env.me(t).UserID)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)
	var acct Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "BE-05 缓存账号", "content_format": "long_article"}, &acct)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, acct.ID)
	})
	jctx := context.WithValue(context.Background(), ctxMember, &identity{UserID: userID, WorkspaceID: workspaceID, Role: "owner"})
	a, err := env.srv.account(jctx, acct.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, e1 := env.srv.suggestMemory(jctx, a.ID, "wording", "all", "BE-05 缓存偏好：避免口语化", "instruction", nil); e1 != nil {
		t.Fatal(e1)
	}
	if _, err := env.srv.db.Exec(jctx, `UPDATE account_memory SET status='active' WHERE account_id=$1 AND text LIKE 'BE-05 缓存%'`, a.ID); err != nil {
		t.Fatal(err)
	}

	beforeHits, beforeMisses, _ := env.srv.contextPacks.stats()
	pack1, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "BE-05 缓存输入"})
	if err != nil {
		t.Fatal(err)
	}
	pack2, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "BE-05 缓存输入"})
	if err != nil {
		t.Fatal(err)
	}
	if pack1.System != pack2.System {
		t.Fatal("缓存命中后 system 字节变化——会触发 skill_context_changed 误判")
	}
	if !containsAll(pack1.System, "BE-05 缓存偏好") {
		t.Fatal("夹具记忆未注入")
	}
	hits, misses, size := env.srv.contextPacks.stats()
	if misses < beforeMisses+1 {
		t.Fatalf("期望至少一次 miss，misses=%d→%d", beforeMisses, misses)
	}
	if hits < beforeHits+1 {
		t.Fatalf("期望第二次命中，hits=%d→%d", beforeHits, hits)
	}
	if size < 1 {
		t.Fatal("缓存条目未写入")
	}
}

func TestBE05ContextPackCacheWorkspaceIsolation(t *testing.T) {
	c := newContextPackCache(time.Now)
	ws1, ws2 := uuid.New(), uuid.New()
	acct := uuid.New()
	key1 := contextPackBasisKey(ws1, acct, "long_article", "title", false, false, true, nil)
	key2 := contextPackBasisKey(ws2, acct, "long_article", "title", false, false, true, nil)
	c.put(key1, contextPackBasis{Prof: &Profile{AccountID: acct, PersonaTone: "ws1-only"}})
	if _, hit := c.get(key2); hit {
		t.Fatal("不同 workspace 不得命中同一账号缓存")
	}
	got, hit := c.get(key1)
	if !hit || got.Prof == nil || got.Prof.PersonaTone != "ws1-only" {
		t.Fatal("本工作区应得命中")
	}
	c.invalidateAccount(ws1, acct)
	if _, hit := c.get(key1); hit {
		t.Fatal("显式失效后仍命中")
	}
}

func TestBE05ContextPackCacheDisabled(t *testing.T) {
	t.Setenv("OPS_CONTEXT_PACK_CACHE", "0")
	c := newContextPackCache(time.Now)
	if c.enabled {
		t.Fatal("OPS_CONTEXT_PACK_CACHE=0 时应关闭")
	}
	key := contextPackBasisKey(uuid.New(), uuid.New(), "long_article", "title", false, false, false, nil)
	c.put(key, contextPackBasis{Prof: &Profile{PersonaTone: "x"}})
	if _, hit := c.get(key); hit {
		t.Fatal("关闭时不得命中")
	}
	hits, misses, size := c.stats()
	if hits != 0 || size != 0 {
		t.Fatalf("关闭时不应记账命中/存条 hits=%d size=%d misses=%d", hits, size, misses)
	}
}

func TestBE05ContextPackCacheTTLExpiry(t *testing.T) {
	now := time.Now()
	clock := now
	c := newContextPackCache(func() time.Time { return clock })
	c.ttl = 10 * time.Millisecond
	key := contextPackBasisKey(uuid.New(), uuid.New(), "long_article", "all", false, false, false, nil)
	c.put(key, contextPackBasis{Prof: &Profile{PersonaTone: "ttl"}})
	if _, hit := c.get(key); !hit {
		t.Fatal("TTL 内应得命中")
	}
	clock = now.Add(20 * time.Millisecond)
	if _, hit := c.get(key); hit {
		t.Fatal("过期后不得命中")
	}
}

func TestBE05ContextPackCacheInvalidateOnProfileWrite(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv("OPS_CONTEXT_PACK_CACHE", "1")
	env.srv.contextPacks = newContextPackCache(env.srv.now)

	userID := uuid.MustParse(env.me(t).UserID)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)
	var acct Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "BE-05 失效账号", "content_format": "long_article"}, &acct)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, acct.ID)
	})
	jctx := context.WithValue(context.Background(), ctxMember, &identity{UserID: userID, WorkspaceID: workspaceID, Role: "owner"})
	a, err := env.srv.account(jctx, acct.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "x"}); err != nil {
		t.Fatal(err)
	}
	_, _, sizeBefore := env.srv.contextPacks.stats()
	if sizeBefore < 1 {
		t.Fatal("预热未写入缓存")
	}
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+acct.ID.String()+"/profile", map[string]any{
		"persona_tone": "BE-05 失效后语气", "default_theme": "ink",
		"wechat_defaults": map[string]any{},
	}, &Profile{})
	_, _, sizeAfter := env.srv.contextPacks.stats()
	if sizeAfter != 0 {
		t.Fatalf("写档案后缓存应清空，size=%d", sizeAfter)
	}
	pack, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if !containsAll(pack.System, "BE-05 失效后语气") {
		t.Fatal("失效后应读到新档案语气")
	}
}

func TestBE05ContextPackAssembleInfoLog(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv("OPS_CONTEXT_PACK_CACHE", "1")
	env.srv.contextPacks = newContextPackCache(env.srv.now)

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	userID := uuid.MustParse(env.me(t).UserID)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)
	var acct Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "BE-05 耗时日志", "content_format": "long_article"}, &acct)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, acct.ID)
	})
	jctx := context.WithValue(context.Background(), ctxMember, &identity{UserID: userID, WorkspaceID: workspaceID, Role: "owner"})
	a, err := env.srv.account(jctx, acct.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "BE-05 秘密正文不应入日志"}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "BE-05 秘密正文不应入日志"}); err != nil {
		t.Fatal(err)
	}

	raw := buf.String()
	if strings.Contains(raw, "BE-05 秘密正文不应入日志") {
		t.Fatal("组装日志泄漏了 user 正文")
	}
	var miss, hit map[string]any
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, `"msg":"context pack assemble"`) {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatal(err)
		}
		if rec["task_type"] != "title" {
			t.Fatalf("task_type=%v", rec["task_type"])
		}
		if rec["workspace_id"] != workspaceID.String() {
			t.Fatalf("workspace_id=%v", rec["workspace_id"])
		}
		if rec["account_id"] != acct.ID.String() {
			t.Fatalf("account_id=%v", rec["account_id"])
		}
		if _, ok := rec["duration_ms"].(float64); !ok {
			t.Fatalf("缺 duration_ms: %v", rec["duration_ms"])
		}
		if _, ok := rec["prefetch_ms"].(float64); !ok {
			t.Fatalf("缺 prefetch_ms: %v", rec["prefetch_ms"])
		}
		if rec["cache_hit"] == false {
			miss = rec
		} else if rec["cache_hit"] == true {
			hit = rec
		}
	}
	if miss == nil {
		t.Fatal("未见 cache_hit=false 的组装日志")
	}
	if hit == nil {
		t.Fatal("未见 cache_hit=true 的组装日志")
	}
	if miss["cache_misses"].(float64) < 1 {
		t.Fatalf("miss 累计 cache_misses=%v", miss["cache_misses"])
	}
	if hit["cache_hits"].(float64) < 1 {
		t.Fatalf("hit 累计 cache_hits=%v", hit["cache_hits"])
	}
}
