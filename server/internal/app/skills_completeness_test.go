package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// 独立读取契约正文，不拿由同一注册表生成的值与注册表自身比较。
func TestSkillBuiltinRegistryMatchesDocument(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "23-技能系统设计.md"))
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	names := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "| builtin:") {
			continue
		}
		cols := strings.Split(line, "|")
		if len(cols) == 5 {
			key, name := strings.TrimSpace(cols[1]), strings.TrimSpace(cols[2])
			def := skillBuiltinByKey(key)
			if def == nil || def.Fields.Name != name {
				t.Fatalf("builtin name differs from document: %s", key)
			}
			names[key] = true
			continue
		}
		if len(cols) != 9 {
			continue
		}
		for i := range cols {
			cols[i] = strings.TrimSpace(cols[i])
		}
		def := skillBuiltinByKey(cols[1])
		if def == nil {
			t.Fatalf("document builtin missing: %s", cols[1])
		}
		seen[cols[1]] = true
		if def.Fields.Summary != cols[2] || def.Fields.Triggers != cols[3] || def.Fields.Instructions != cols[7] {
			t.Fatalf("builtin differs from document: %s", cols[1])
		}
		for i, actual := range [][]string{def.Fields.Platforms, def.Fields.ContentFormats, def.Fields.TaskTypes} {
			text := strings.Trim(cols[i+4], "[]")
			expected := []string{}
			if text != "" {
				expected = strings.Split(text, ",")
			}
			if !reflect.DeepEqual(normalizeEnumArray(actual), normalizeEnumArray(expected)) {
				t.Fatalf("%s array %d differs from document", cols[1], i)
			}
		}
		if def.Revision != 1 || def.ID != uuid.NewSHA1(uuid.MustParse("5ee2a4a9-9633-4a48-b64c-587acbce98d0"), []byte(cols[1])) {
			t.Fatalf("%s version/UUID differs from v0.3", cols[1])
		}
	}
	if len(names) != 8 || len(seen) != 8 || len(seen) != len(builtinSkills) {
		t.Fatalf("document/registry count: %d/%d", len(seen), len(builtinSkills))
	}
}

func TestSkillBuiltinBindingNameAndExcludedAgentPreview(t *testing.T) {
	_, acc := skillRunState(t)
	builtin := skillBuiltinByKey("builtin:title_formulas")
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO skill_binding (account_id, builtin_key) VALUES ($1,$2)`, acc.ID, builtin.BuiltinKey); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM skill_binding WHERE account_id=$1 AND builtin_key=$2`, acc.ID, builtin.BuiltinKey)
	})
	t.Run("binding_display_name", func(t *testing.T) {
		var result struct {
			Public struct {
				Items []skillBindingItem `json:"items"`
			} `json:"public"`
		}
		env.mustJSON(t, "GET", "/api/v1/accounts/"+acc.ID.String()+"/skill-bindings", nil, &result)
		for _, item := range result.Public.Items {
			if item.SkillID == builtin.ID {
				if item.Name != builtin.Fields.Name {
					t.Fatalf("display name %q != %q", item.Name, builtin.Fields.Name)
				}
				return
			}
		}
		t.Fatal("builtin binding missing")
	})
	t.Run("builtin_task_and_legacy_history", func(t *testing.T) {
		ctx, _ := skillAIEnv(t)
		env.llm.ResetRequests()
		if _, err := env.srv.runAI(ctx, aiTask{Type: "title", Account: acc, User: "验证内置标题技能"}, nil); err != nil {
			t.Fatal(err)
		}
		requests := env.llm.Requests()
		if len(requests) == 0 || !strings.Contains(systemOf(t, requests[len(requests)-1]), builtin.Fields.Instructions) {
			t.Fatal("builtin body missing from actual task request")
		}
		var callID uuid.UUID
		if err := env.srv.db.QueryRow(ctx, `SELECT id FROM ai_call WHERE account_id=$1 AND task_type='title' ORDER BY created_at DESC LIMIT 1`, acc.ID).Scan(&callID); err != nil {
			t.Fatal(err)
		}
		legacyID := uuid.NewMD5(uuid.MustParse("5ee2a4a9-9633-4a48-b64c-587acbce98d0"), []byte(builtin.BuiltinKey))
		history, err := json.Marshal([]SkillUseItem{{ID: legacyID, Name: builtin.Fields.Name, Scope: "builtin", Revision: 1, Selected: true, Used: true, Chars: 120}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(ctx, `UPDATE ai_call SET context_refs=jsonb_set(context_refs,'{skills,items}',$2::jsonb) WHERE id=$1`, callID, history); err != nil {
			t.Fatal(err)
		}
		var receipt struct {
			Items []SkillUseItem `json:"items"`
		}
		env.mustJSON(t, "GET", "/api/v1/ai-calls/"+callID.String()+"/skill-context", nil, &receipt)
		if len(receipt.Items) != 1 || receipt.Items[0].ID != legacyID {
			t.Fatal("historical IDs must remain frozen after UUID algorithm correction")
		}
		if skillBuiltinByID(legacyID) != nil {
			t.Fatal("current object lookup must not silently alias a historical UUID")
		}
	})
	t.Run("excluded_agent_reason", func(t *testing.T) {
		personal := skillPersonalCreate(t, "预览停用入口-"+uuid.NewString()[:8])
		id := skillIDOf(t, personal)
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE skill SET agent_enabled=false WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		skillAgentBindPersonal(t, acc.ID, id)
		var result struct {
			Items []SkillUseItem `json:"items"`
		}
		env.mustJSON(t, "GET", "/api/v1/accounts/"+acc.ID.String()+"/skill-context?surface=agent", nil, &result)
		for _, item := range result.Items {
			if item.ID == id {
				if item.Selected || item.Used || item.Reason == nil || *item.Reason != skillReasonAgentOff {
					t.Fatalf("wrong exclusion: %+v", item)
				}
				return
			}
		}
		t.Fatal("excluded candidate must carry a reason in agent preview")
	})
}

func TestSkillAgentBudgetRejectsWithoutChangingLoadedSet(t *testing.T) {
	st, acc := skillRunState(t)
	defer agentReleaseSkillState(st.RunID)
	ids := skillAgentBind(t, acc.ID, 3, true)
	ctx := context.WithValue(context.Background(), ctxMember, &identity{UserID: st.UserID, WorkspaceID: st.WorkspaceID, Role: "owner"})
	for _, id := range ids {
		if _, err := env.srv.db.Exec(ctx, `UPDATE skill SET instructions=$2 WHERE id=$1`, id, strings.Repeat("长", 1200)); err != nil {
			t.Fatal(err)
		}
	}
	c, err := env.srv.agentSkillEnsureContext(ctx, st, acc, nil, acc.ContentFormat)
	if err != nil {
		t.Fatal(err)
	}
	loaded := 0
	rejected := false
	for _, item := range c.Items {
		if item.Def.ID != ids[0] && item.Def.ID != ids[1] && item.Def.ID != ids[2] {
			continue
		}
		before := agentSkillActive(st.RunID)
		count, chars := 0, 0
		if before != nil {
			count, chars = len(before.Loaded), before.LoadedChars
		}
		_, err := env.srv.agentSkillLoad(ctx, st, acc, map[string]any{"skill_ref": item.Ref, "catalog_id": c.CatalogID.String()})
		if err == nil {
			loaded++
			continue
		}
		ae, ok := err.(*APIError)
		if !ok || ae.Code != "skill_budget_exceeded" {
			t.Fatalf("unexpected error: %v", err)
		}
		after := agentSkillActive(st.RunID)
		if len(after.Loaded) != count || after.LoadedChars != chars {
			t.Fatal("rejected load changed active set/budget")
		}
		rejected = true
	}
	if loaded != 2 || !rejected {
		t.Fatalf("must fit two and reject the third: loaded=%d rejected=%v", loaded, rejected)
	}
	if agentSkillActive(st.RunID).LoadedChars > 3600 {
		t.Fatal("active zone exceeded budget")
	}
}
