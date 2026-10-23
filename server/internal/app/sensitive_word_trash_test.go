package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestSensitiveWordTrashLifecycle(t *testing.T) {
	accounts := env.accounts(t)
	workspaceID, err := uuid.Parse(env.me(t).Workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	word := "st08-" + uuid.NewString()

	var created struct {
		Added   int `json:"added"`
		Skipped int `json:"skipped"`
	}
	env.mustJSON(t, "POST", "/api/v1/sensitive-words", map[string]any{"words": []string{word}, "category": "st08"}, &created)
	if created.Added != 1 || created.Skipped != 0 {
		t.Fatalf("create result: %+v", created)
	}
	var words []struct {
		ID     uuid.UUID `json:"id"`
		Word   string    `json:"word"`
		Source string    `json:"source"`
	}
	env.mustJSON(t, "GET", "/api/v1/sensitive-words", nil, &words)
	var wordID uuid.UUID
	for _, item := range words {
		if item.Word == word && item.Source == "custom" {
			wordID = item.ID
		}
	}
	if wordID == uuid.Nil {
		t.Fatalf("custom word %q not found", word)
	}

	checkCtx := context.WithValue(context.Background(), ctxMember, &identity{WorkspaceID: workspaceID})
	containsWord := func() bool {
		checks, err := env.srv.checkWords(checkCtx, accounts.wechat.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range checks {
			if item.w == word && item.source == "custom" {
				return true
			}
		}
		return false
	}
	if !containsWord() {
		t.Fatalf("custom word %q missing from checks before delete", word)
	}

	env.mustJSON(t, "DELETE", "/api/v1/sensitive-words/"+wordID.String(), nil, nil)
	env.mustJSON(t, "GET", "/api/v1/sensitive-words", nil, &words)
	for _, item := range words {
		if item.ID == wordID {
			t.Fatalf("deleted word remains in normal list: %+v", item)
		}
	}
	if containsWord() {
		t.Fatalf("deleted word %q remains in compliance checks", word)
	}

	var trash []struct {
		ID    uuid.UUID `json:"id"`
		Type  string    `json:"type"`
		Title string    `json:"title"`
	}
	env.mustJSON(t, "GET", "/api/v1/trash?type=sensitive_word", nil, &trash)
	foundInTrash := false
	for _, item := range trash {
		if item.ID == wordID && item.Type == "sensitive_word" && item.Title == word {
			foundInTrash = true
		}
	}
	if !foundInTrash {
		t.Fatalf("deleted word %q missing from trash: %+v", word, trash)
	}

	env.mustJSON(t, "POST", "/api/v1/trash/sensitive_word/"+wordID.String()+"/restore", nil, nil)
	env.mustJSON(t, "GET", "/api/v1/sensitive-words", nil, &words)
	foundActive := false
	for _, item := range words {
		if item.ID == wordID && item.Word == word {
			foundActive = true
		}
	}
	if !foundActive || !containsWord() {
		t.Fatalf("restored word %q missing from list or checks", word)
	}

	// Re-adding a still-trashed term must reactivate the unique row instead of
	// failing against the workspace/word uniqueness constraint.
	env.mustJSON(t, "DELETE", "/api/v1/sensitive-words/"+wordID.String(), nil, nil)
	created = struct {
		Added   int `json:"added"`
		Skipped int `json:"skipped"`
	}{}
	env.mustJSON(t, "POST", "/api/v1/sensitive-words", map[string]any{"words": []string{word}, "category": "st08"}, &created)
	if created.Added != 1 || created.Skipped != 0 {
		t.Fatalf("re-add trashed word result: %+v", created)
	}
	env.mustJSON(t, "GET", "/api/v1/sensitive-words", nil, &words)
	foundActive = false
	for _, item := range words {
		if item.ID == wordID && item.Word == word {
			foundActive = true
		}
	}
	if !foundActive || !containsWord() {
		t.Fatalf("re-added word %q was not reactivated", word)
	}
}
