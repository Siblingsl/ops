package app

import (
	"testing"

	"github.com/google/uuid"
)

func TestReferenceTrashUsesURLWhenTitleUnavailable(t *testing.T) {
	account := env.accounts(t).wechat
	url := "https://xiaohongshu.com/qa26-trash-" + uuid.NewString()
	var added struct {
		IDs []uuid.UUID `json:"ids"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/references", map[string]any{"links": []string{url}}, &added)
	if len(added.IDs) != 1 {
		t.Fatalf("add reference response: %+v", added)
	}
	referenceID := added.IDs[0]
	env.mustJSON(t, "DELETE", "/api/v1/references/"+referenceID.String(), nil, nil)

	var trash []struct {
		ID    uuid.UUID `json:"id"`
		Type  string    `json:"type"`
		Title string    `json:"title"`
	}
	env.mustJSON(t, "GET", "/api/v1/trash?type=reference", nil, &trash)
	for _, item := range trash {
		if item.ID == referenceID {
			if item.Type != "reference" || item.Title != url {
				t.Fatalf("reference trash should show its source URL when no title was fetched: %+v", item)
			}
			return
		}
	}
	t.Fatalf("deleted reference %s missing from trash: %+v", referenceID, trash)
}
