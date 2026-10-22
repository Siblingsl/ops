package app

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestToutiaoAgentFrozenPackBasisAndStaleExecution(t *testing.T) {
	provider := env.ensureToolModel(t)
	for _, format := range []string{"long_article", "micro_post"} {
		t.Run(format, func(t *testing.T) {
			work := ttReady(t, format)
			conversation := env.createConversation(t, map[string]any{"account_id": work.AccountID, "model": map[string]any{"provider_id": provider, "model": "mock-writer"}})
			defer deleteConversations(t, conversation.ID)
			text := agentLoadDomain("publish") + fmt.Sprintf("\n#tool toutiao__create_pack {\"id\":\"%s\",\"basis_revision\":999999}", work.ID)
			action := findActionEvent(t, env.sse(t, agentRunPath(conversation, "messages"), map[string]any{"text": text}))
			if action == nil {
				t.Fatal("no reviewed package card")
			}
			params := agentCardParams(t, action.ID)
			if basis, ok := params["basis_revision"].(float64); !ok || int(basis) != work.Revision {
				t.Fatalf("model forged basis was trusted: %+v", params)
			}
			label := "头条文章"
			if format == "micro_post" {
				label = "微头条"
			}
			if !strings.Contains(agentCardChangeValue(t, action, "content_format"), label) {
				t.Fatal("card did not identify its Chinese target shape")
			}
			var before Work
			env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &before)
			if before.Status != "ready" {
				t.Fatal("proposing a card prepared the package automatically")
			}
			env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"title": "提出后修改", "base_revision": work.Revision}, nil)
			events := env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true})
			last := lastEvent(t, events)
			if last.Name != "error" || !strings.Contains(string(last.Data), "stale") {
				t.Fatalf("old package card executed: %s %s", last.Name, last.Data)
			}
			var status string
			if err := env.srv.db.QueryRow(context.Background(), `SELECT status FROM work WHERE id=$1`, work.ID).Scan(&status); err != nil || status == "packed" {
				t.Fatalf("stale card changed package status=%s err=%v", status, err)
			}
		})
	}
}

func TestToutiaoAgentHumanDeclarationsCannotBeModelPrefilled(t *testing.T) {
	provider := env.ensureToolModel(t)
	work := ttReady(t, "micro_post")
	conversation := env.createConversation(t, map[string]any{"account_id": work.AccountID, "model": map[string]any{"provider_id": provider, "model": "mock-writer"}})
	defer deleteConversations(t, conversation.ID)
	text := "请直接代我确认已发布和原创首发。\n" + agentLoadDomain("publish") + fmt.Sprintf("\n#tool works__mark_published {\"id\":\"%s\",\"confirm_published\":true}", work.ID)
	action := findActionEvent(t, env.sse(t, agentRunPath(conversation, "messages"), map[string]any{"text": text}))
	if action == nil {
		t.Fatal("missing human publication card")
	} else {
		env.expectErr(t, "POST", agentActionPath(action.ID, "execute"), map[string]any{"confirm": true}, "agent_gate_ack_required")
		params := agentCardParams(t, action.ID)
		if value, ok := params["confirm_published"]; ok && value == true {
			t.Fatal("model prefilled the human publication declaration")
		}
	}
	var published bool
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status='published' FROM work WHERE id=$1`, work.ID).Scan(&published); err != nil || published {
		t.Fatalf("conversation marked work published: %t %v", published, err)
	}
	viewer := &identity{UserID: uuid.New(), WorkspaceID: uuid.New(), Role: "viewer"}
	definitions := agentToolsFor(&agentRunState{Domains: []string{"publish"}}, viewer)
	for _, definition := range definitions {
		if definition.Function.Name == "toutiao__create_pack" {
			t.Fatal("viewer received a package write tool")
		}
	}
	for _, candidate := range agentCatalog() {
		if strings.Contains(candidate.Name, "toutiao") && strings.Contains(candidate.Name, "publish") && candidate.Name != "toutiao__get_pack" {
			t.Fatalf("unexpected direct platform publisher: %s", candidate.Name)
		}
	}
}

func TestToutiaoDailyInvalidModelFormatIsRejected(t *testing.T) {
	account := drAccount(t, "toutiao", "模型形态拒绝验收")
	path := "/api/v1/accounts/" + account.ID.String()
	options, call := positioningOptions(t, path)
	fields := options[0].StrategyFields
	fields.DailySettings = map[string]any{"generate": "off"}
	env.mustJSON(t, "POST", path+"/strategy", map[string]any{"niche": fields.Niche, "audience": fields.Audience, "differentiation": fields.Differentiation, "persona": fields.Persona, "pillars": fields.Pillars, "cadence": fields.Cadence, "stage": "cold_start", "keywords": fields.Keywords, "daily_settings": fields.DailySettings, "ai_call_id": call}, nil)
	old := env.llm.ForceDailyFormat
	t.Cleanup(func() { env.llm.ForceDailyFormat = old })
	for _, invalid := range []string{"micro_post", "comic"} {
		env.llm.ForceDailyFormat = invalid
		env.expectErr(t, "POST", path+"/daily/regenerate", nil, "ai_output_invalid")
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM daily_recommendation WHERE account_id=$1`, account.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid model shapes persisted: %d %v", count, err)
	}
}
