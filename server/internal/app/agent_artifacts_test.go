package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestAW05ArtifactsAreFeatureGatedAndPrivate(t *testing.T) {
	env.ensureToolModel(t)
	conversation := env.createConversation(t, map[string]any{})
	t.Cleanup(func() { deleteConversations(t, conversation.ID) })
	path := "/api/v1/agent/conversations/" + conversation.ID.String() + "/artifacts"

	t.Setenv(agentWorkbenchFeatureEnv, "")
	if status, body := env.do(http.MethodGet, path, nil); status != http.StatusConflict || agentErrCodeOf(t, body) != "agent_feature_unavailable" {
		t.Fatalf("feature-off artifact list = %d %s", status, body)
	}
	t.Setenv(agentWorkbenchFeatureEnv, "artifacts")

	var artifactID, versionID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO agent_artifact (conversation_id,kind,title)
		VALUES ($1,'markdown','私有测试产物') RETURNING id`, conversation.ID).Scan(&artifactID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO agent_artifact_version
		(artifact_id,version,source_kind,content_ref,hash,status)
		VALUES ($1,1,'g_tool','{"tool_name":"works__summary","content":"仅本人可见"}', 'hash-aw05','draft') RETURNING id`, artifactID).Scan(&versionID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE agent_artifact SET current_version_id=$2 WHERE id=$1`, artifactID, versionID); err != nil {
		t.Fatal(err)
	}

	var list struct {
		Items []struct {
			ID    uuid.UUID `json:"id"`
			Title string    `json:"title"`
		} `json:"items"`
		NextCursor *string `json:"next_cursor"`
	}
	env.mustJSON(t, http.MethodGet, path, nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID != artifactID || list.Items[0].Title != "私有测试产物" {
		t.Fatalf("artifact list = %+v", list)
	}

	var detail struct {
		Artifact struct {
			ID    uuid.UUID `json:"id"`
			Title string    `json:"title"`
		} `json:"artifact"`
		Version struct {
			ID        uuid.UUID       `json:"id"`
			Version   int             `json:"version"`
			Content   json.RawMessage `json:"content"`
			OpenURL   string          `json:"open_url"`
			Available bool            `json:"available"`
		} `json:"current_version"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/artifacts/"+artifactID.String(), nil, &detail)
	if detail.Artifact.ID != artifactID || detail.Version.ID != versionID || detail.Version.Version != 1 || !detail.Version.Available {
		t.Fatalf("artifact detail = %+v", detail)
	}

	other := env.registerClient(t, "aw05-private-"+uuid.NewString()[:8], testPassword)
	defer other.restore(env)
	var me meInfo
	other.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	other.csrf = me.CSRF
	other.expectErr(t, http.MethodGet, "/api/v1/agent/artifacts/"+artifactID.String(), nil, "not_found")
	other.expectErr(t, http.MethodGet, path, nil, "not_found")
}

func TestAW05ControlledGenerationResultCreatesPreviewableArtifact(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "artifacts")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t)
	work := env.readyWork(t, account.wechat, "AW05 生成结果产物来源验收")
	conversation := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conversation.ID) })
	status, attachment, body := agentUploadAttachment(t, "参考图片.png", testPNG(80, 60), conversation.ID.String())
	if status != http.StatusOK {
		t.Fatalf("上传图片失败：%d %s", status, body)
	}
	text := agentLoadDomain("writing") + "\n#tool works__titles {\"id\":\"" + work.ID.String() + "\"}"
	env.sse(t, agentRunPath(conversation, "messages"), map[string]any{"text": text, "attachment_ids": []string{attachment.ID.String()}})

	var list struct {
		Items []struct {
			ID        uuid.UUID `json:"id"`
			Kind      string    `json:"kind"`
			Title     string    `json:"title"`
			SourceRun uuid.UUID `json:"source_run_id"`
		} `json:"items"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+conversation.ID.String()+"/artifacts", nil, &list)
	if len(list.Items) != 2 {
		t.Fatalf("generated artifact = %+v", list.Items)
	}
	var titleID, imageID uuid.UUID
	for _, item := range list.Items {
		switch item.Kind {
		case "title":
			if item.Title == "" || item.SourceRun == uuid.Nil {
				t.Fatalf("generated title artifact = %+v", item)
			}
			titleID = item.ID
		case "image":
			imageID = item.ID
		default:
			t.Fatalf("unexpected artifact kind: %+v", item)
		}
	}
	if titleID == uuid.Nil || imageID == uuid.Nil {
		t.Fatalf("title and uploaded image artifacts expected: %+v", list.Items)
	}

	var details struct {
		CurrentVersion struct {
			SourceKind string `json:"source_kind"`
			OpenURL    string `json:"open_url"`
			Available  bool   `json:"available"`
		} `json:"current_version"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/artifacts/"+titleID.String(), nil, &details)
	if details.CurrentVersion.SourceKind != "g_tool" || !details.CurrentVersion.Available || details.CurrentVersion.OpenURL != "/works/"+work.ID.String() {
		t.Fatalf("generated artifact source = %+v", details.CurrentVersion)
	}
	var imageDetails struct {
		CurrentVersion struct {
			SourceKind string `json:"source_kind"`
			ImageURL   string `json:"image_url"`
			Available  bool   `json:"available"`
		} `json:"current_version"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/artifacts/"+imageID.String(), nil, &imageDetails)
	if imageDetails.CurrentVersion.SourceKind != "attachment" || !imageDetails.CurrentVersion.Available || imageDetails.CurrentVersion.ImageURL != attachment.URL+"?variant=thumb" {
		t.Fatalf("uploaded image artifact source = %+v", imageDetails.CurrentVersion)
	}
}
