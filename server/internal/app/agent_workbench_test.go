package app

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestAW01BootstrapFeatureSwitchesDefaultClosed(t *testing.T) {
	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "")
	env.ensureToolModel(t)
	var body struct {
		Features map[string]bool `json:"features"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/bootstrap", nil, &body)
	want := []string{"workbench_ui", "conversation_organize", "context_refs", "skill_requests", "artifacts", "run_control", "event_resume", "plans", "goals", "routines", "document_parse"}
	if len(body.Features) != len(want) {
		t.Fatalf("bootstrap features = %#v, want all %d documented flags", body.Features, len(want))
	}
	for _, name := range want {
		if enabled, ok := body.Features[name]; !ok || enabled {
			t.Errorf("feature %q = %v, present=%v; want present and disabled by default", name, enabled, ok)
		}
	}

	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "workbench_ui, conversation_organize, unknown_feature")
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/bootstrap", nil, &body)
	if len(body.Features) != len(want) || !body.Features["workbench_ui"] || !body.Features["conversation_organize"] || body.Features["context_refs"] {
		t.Fatalf("configured feature switches were not isolated: %#v", body.Features)
	}
}

func TestAW01ConversationPatchUsesRevisionCAS(t *testing.T) {
	env.ensureToolModel(t)
	c := env.createConversation(t, map[string]any{})
	t.Cleanup(func() { deleteConversations(t, c.ID) })
	var patched struct {
		ID       uuid.UUID `json:"id"`
		Title    string    `json:"title"`
		Revision int64     `json:"revision"`
	}
	env.mustJSON(t, http.MethodPatch, "/api/v1/agent/conversations/"+c.ID.String(), map[string]any{
		"expected_revision": 1,
		"title":             "第一次修改",
	}, &patched)
	if patched.Title != "第一次修改" || patched.Revision != 2 {
		t.Fatalf("first CAS patch = %+v, want title and revision 2", patched)
	}
	status, raw := env.do(http.MethodPatch, "/api/v1/agent/conversations/"+c.ID.String(), map[string]any{
		"expected_revision": 1,
		"title":             "过期修改",
	})
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(raw), &failure); err != nil {
		t.Fatal(err)
	}
	if status != http.StatusConflict || failure.Error.Code != "agent_revision_conflict" {
		t.Fatalf("stale CAS patch = %d %s, want 409 agent_revision_conflict", status, raw)
	}
}

func TestAW01ConversationCreateRequestIDIsIdempotent(t *testing.T) {
	env.ensureToolModel(t)
	requestID := uuid.NewString()
	input := map[string]any{"request_id": requestID, "title": "同一创建请求"}
	var first, replay struct {
		ID       uuid.UUID `json:"id"`
		Title    string    `json:"title"`
		Revision int64     `json:"revision"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations", input, &first)
	t.Cleanup(func() { deleteConversations(t, first.ID) })
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations", input, &replay)
	if first.ID == uuid.Nil || replay.ID != first.ID {
		t.Fatalf("idempotent create returned ids %s and %s", first.ID, replay.ID)
	}

	status, raw := env.do(http.MethodPost, "/api/v1/agent/conversations", map[string]any{
		"request_id": requestID,
		"title":      "同一请求ID的不同内容",
	})
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(raw), &failure); err != nil {
		t.Fatal(err)
	}
	if status != http.StatusConflict || failure.Error.Code != "agent_request_conflict" {
		t.Fatalf("conflicting request id = %d %s, want 409 agent_request_conflict", status, raw)
	}
}
