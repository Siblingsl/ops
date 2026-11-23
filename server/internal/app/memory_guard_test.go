package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func a4InsertMemory(t *testing.T, accountID uuid.UUID, kind, text string, confidence float64, lastUsedAt *time.Time, confirmedAt *time.Time, injectionDisabled bool) uuid.UUID {
	t.Helper()
	var lastUsed, confirmed any
	if lastUsedAt != nil {
		lastUsed = *lastUsedAt
	}
	if confirmedAt != nil {
		confirmed = *confirmedAt
	}
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO account_memory (account_id, kind, scope, text, status, source, confidence, last_used_at, confirmed_at, injection_disabled)
		 VALUES ($1,$2,'all',$3,'active','manual',$4,$5,$6,$7) RETURNING id`,
		accountID, kind, text, confidence, lastUsed, confirmed, injectionDisabled).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestA4InjectionGateConfidenceAndDisabled(t *testing.T) {
	// A4-A2：注入只取 active && confidence>=0.6 && !injection_disabled。
	a := drAccount(t, "xhs", "A4注入小红书")
	future := time.Now().Add(time.Hour)
	a4InsertMemory(t, a.ID, "tone", "高置信记忆，应注入", 0.9, &future, nil, false)
	a4InsertMemory(t, a.ID, "tone", "低置信记忆，不注入", 0.5, &future, nil, false)
	a4InsertMemory(t, a.ID, "tone", "被禁用注入的记忆", 0.9, &future, nil, true)

	memories, err := env.srv.activeMemories(context.Background(), a.ID, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(memories) != 1 || memories[0].Text != "高置信记忆，应注入" {
		t.Fatalf("gate failed: %+v", memories)
	}
}

func TestA4GuardLimitsEightItemsAndTwoThousandChars(t *testing.T) {
	// A4-A2：硬闸 8 条 / 2000 字（服务端 memoryGuardInject）。
	a := drAccount(t, "xhs", "A4硬闸小红书")
	future := time.Now().Add(time.Hour)
	for i := 0; i < 10; i++ {
		a4InsertMemory(t, a.ID, "tone", strings.Repeat("字", 300), 0.9, &future, nil, false)
	}
	memories, err := env.srv.activeMemories(context.Background(), a.ID, "", false)
	if err != nil {
		t.Fatal(err)
	}
	kept, dropped, total := memoryGuardInject(memories)
	// 10 条 ×300 字：字数闸在 2000/300=6 条后截断（6×300=1800，第 7 条 2100>2000）；
	// 条数闸 8 未触达。两个闸都有效即可。
	if len(kept) != 6 {
		t.Fatalf("kept = %d, want 6 (2000-char cap binds first)", len(kept))
	}
	if len(dropped) != 4 {
		t.Fatalf("dropped = %d, want 4", len(dropped))
	}
	if total != 1800 {
		t.Fatalf("total chars = %d, want 1800", total)
	}
	// 条数闸单独验证：7 条短文本 → 第 8 条后截断。
	short := make([]Memory, 0, 9)
	for i := 0; i < 9; i++ {
		short = append(short, Memory{ID: uuid.New(), Kind: "tone", Text: "短"})
	}
	keptShort, droppedShort, _ := memoryGuardInject(short)
	if len(keptShort) != 8 || len(droppedShort) != 1 {
		t.Fatalf("8-item cap broken: kept=%d dropped=%d", len(keptShort), len(droppedShort))
	}
}

func TestA4SortOrderAvoidUseCountCreatedAt(t *testing.T) {
	// A4-A3：排序保持 avoid 优先 → use_count → created_at（注入闸不影响顺序）。
	a := drAccount(t, "xhs", "A4排序小红书")
	future := time.Now().Add(time.Hour)
	old := time.Now().Add(-2 * time.Hour)
	a4InsertMemory(t, a.ID, "tone", "普通-高使用", 0.9, &future, nil, false)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE account_memory SET use_count=5 WHERE text='普通-高使用'`); err != nil {
		t.Fatal(err)
	}
	a4InsertMemory(t, a.ID, "avoid", "避坑-低使用", 0.9, &future, nil, false)
	a4InsertMemory(t, a.ID, "tone", "普通-旧创建", 0.9, &old, nil, false)

	memories, err := env.srv.activeMemories(context.Background(), a.ID, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(memories) != 3 {
		t.Fatalf("count = %d", len(memories))
	}
	if memories[0].Kind != "avoid" {
		t.Fatalf("avoid must sort first, got %s", memories[0].Kind)
	}
	if memories[1].Text != "普通-高使用" || memories[2].Text != "普通-旧创建" {
		t.Fatalf("use_count then created_at order broken: %s / %s", memories[1].Text, memories[2].Text)
	}
}

func a4PtrTime(t time.Time) *time.Time { return &t }

func TestA4DecayJobNinetyDaysFloorHalf(t *testing.T) {
	// A4-A4：90 天未用未确认 → ×0.9 下限 0.5；不自动 disabled；已确认/最近使用不衰减。
	a := drAccount(t, "xhs", "A4衰减小红书")
	stale := time.Now().AddDate(0, 0, -120)
	a4InsertMemory(t, a.ID, "tone", "衰减目标-0.8", 0.8, &stale, nil, false)
	a4InsertMemory(t, a.ID, "tone", "衰减目标-0.52", 0.52, &stale, nil, false)
	a4InsertMemory(t, a.ID, "tone", "已确认不衰减", 0.7, &stale, a4PtrTime(time.Now().AddDate(0, 0, -10)), false)
	a4InsertMemory(t, a.ID, "tone", "最近使用不衰减", 0.7, a4PtrTime(time.Now().AddDate(0, 0, -10)), nil, false)

	env.srv.memoryDecayJob(context.Background())

	var conf08, conf052, confConfirmed, confRecent float64
	var status08 string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT confidence, status FROM account_memory WHERE text='衰减目标-0.8'`).Scan(&conf08, &status08); err != nil {
		t.Fatal(err)
	}
	if conf08 != 0.72 {
		t.Fatalf("0.8 * 0.9 = %v, want 0.72", conf08)
	}
	if status08 != "active" {
		t.Fatalf("decay must not disable, got %s", status08)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT confidence FROM account_memory WHERE text='衰减目标-0.52'`).Scan(&conf052); err != nil {
		t.Fatal(err)
	}
	if conf052 != 0.5 {
		t.Fatalf("floor must clamp to 0.5, got %v", conf052)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT confidence FROM account_memory WHERE text='已确认不衰减'`).Scan(&confConfirmed); err != nil {
		t.Fatal(err)
	}
	if confConfirmed != 0.7 {
		t.Fatalf("confirmed memory must not decay, got %v", confConfirmed)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT confidence FROM account_memory WHERE text='最近使用不衰减'`).Scan(&confRecent); err != nil {
		t.Fatal(err)
	}
	if confRecent != 0.7 {
		t.Fatalf("recently used memory must not decay, got %v", confRecent)
	}
}



func TestA4ConfirmDisableEnableAndPreview(t *testing.T) {
	// A4-A5：confirm（confidence=1、confirmed_at=now、清 decayed）、disable/enable、
	// 注入预览 items/dropped/total_chars；跨工作区 404。
	a := drAccount(t, "xhs", "A4确认小红书")
	stale := time.Now().AddDate(0, 0, -120)
	mid := a4InsertMemory(t, a.ID, "tone", "待确认记忆", 0.6, &stale, nil, false)

	var preview struct {
		Items      []Memory `json:"items"`
		TotalChars int      `json:"total_chars"`
		Dropped    []struct {
			ID     string `json:"id"`
			Reason string `json:"reason"`
		} `json:"dropped"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/memories/injection-preview", nil, &preview)
	if len(preview.Items) != 1 || preview.Items[0].ID != mid {
		t.Fatalf("preview items wrong: %+v", preview.Items)
	}
	if preview.TotalChars <= 0 {
		t.Fatalf("total_chars should be positive")
	}

	// confirm
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/memories/"+mid.String()+"/verify", nil, &struct{}{})
	var conf float64
	var confirmedAt *time.Time
	var decayed *time.Time
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT confidence, confirmed_at, decayed_at FROM account_memory WHERE id=$1`, mid).Scan(&conf, &confirmedAt, &decayed); err != nil {
		t.Fatal(err)
	}
	if conf != 1.0 || confirmedAt == nil || decayed != nil {
		t.Fatalf("confirm state wrong: conf=%v confirmed=%v decayed=%v", conf, confirmedAt, decayed)
	}

	// disable → 注入预览不再包含；enable 恢复。
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/memories/"+mid.String()+"/disable", nil, &struct{}{})
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/memories/injection-preview", nil, &preview)
	if len(preview.Items) != 0 {
		t.Fatalf("disabled memory must not inject: %+v", preview.Items)
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/memories/"+mid.String()+"/enable", nil, &struct{}{})
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/memories/injection-preview", nil, &preview)
	if len(preview.Items) != 1 {
		t.Fatalf("enabled memory should inject again: %+v", preview.Items)
	}

	// 跨工作区 404：另一用户访问不到该账号。
	g := env.registerClient(t, "a4_cross_"+uuid.NewString()[:8], testPassword)
	defer g.restore(env)
	env.mustJSONStatus(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/memories/"+mid.String()+"/verify", nil, nil, http.StatusNotFound)
	_ = g
}

func TestA4NewMemoryDefaultConfidence(t *testing.T) {
	// A4 边界：新建/采纳记忆默认 confidence=0.8（迁移 DEFAULT）。
	a := drAccount(t, "xhs", "A4默认小红书")
	var created Memory
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/memories",
		map[string]any{"kind": "tone", "scope": "all", "text": "新建默认置信记忆", "source": "manual"}, &created)
	if created.Confidence != 0.8 {
		t.Fatalf("create response confidence = %v, want 0.8", created.Confidence)
	}
	mid := created.ID
	var conf float64
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT confidence FROM account_memory WHERE id=$1`, mid).Scan(&conf); err != nil {
		t.Fatal(err)
	}
	if conf != 0.8 {
		t.Fatalf("new memory default confidence = %v, want 0.8", conf)
	}
	// 注入预览可见（0.8 >= 0.6）。
	var preview struct {
		Items []Memory `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/memories/injection-preview", nil, &preview)
	if len(preview.Items) != 1 {
		t.Fatalf("default memory should inject: %+v", preview.Items)
	}
}
