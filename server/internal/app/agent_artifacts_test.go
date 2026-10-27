package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	wantImageURL := "/api/v1/agent/attachments/" + attachment.ID.String() + "/file?variant=thumb&conversation_id=" + conversation.ID.String()
	if imageDetails.CurrentVersion.SourceKind != "attachment" || !imageDetails.CurrentVersion.Available || imageDetails.CurrentVersion.ImageURL != wantImageURL {
		t.Fatalf("uploaded image artifact source = %+v", imageDetails.CurrentVersion)
	}
}

func TestAW08ChatArtifactsAreVersionedAndCitationsAreRevalidated(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "artifacts,event_resume,context_refs")
	provider := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, provider)
	defer deleteConversations(t, conversation.ID)
	content := "本周阅读增长，优先优化标题。"
	status, accepted := env.do(http.MethodPost, agentRunPath(conversation, "messages"), map[string]any{
		"text": "整理结果\n#tool present_artifact " + string(mustJSON(map[string]any{
			"title": "本周运营建议", "kind": "markdown", "chat_content": content,
		})), "request_id": uuid.NewString(), "protocol_version": 2,
	})
	if status != http.StatusAccepted {
		t.Fatalf("present_artifact run not accepted: %d %s", status, accepted)
	}
	aw06WaitRun(t, accepted)
	var artifactID uuid.UUID
	var sourceKind string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT a.id,v.source_kind FROM agent_artifact a
		JOIN agent_artifact_version v ON v.id=a.current_version_id WHERE a.conversation_id=$1 AND a.title='本周运营建议'`,
		conversation.ID).Scan(&artifactID, &sourceKind); err != nil {
		t.Fatalf("chat draft artifact was not persisted: %v", err)
	}
	if sourceKind != "chat" {
		t.Fatalf("ordinary chat must remain an unqualified draft, source=%q", sourceKind)
	}
	versionRequest := map[string]any{"request_id": uuid.NewString(), "expected_version": 1, "content": "本周阅读增长，先优化标题与开头。"}
	versionPath := "/api/v1/agent/artifacts/" + artifactID.String() + "/versions"
	var versionReceipt struct {
		VersionID uuid.UUID `json:"version_id"`
		Version   int       `json:"version"`
	}
	env.mustJSON(t, http.MethodPost, versionPath, versionRequest, &versionReceipt)
	if versionReceipt.VersionID == uuid.Nil || versionReceipt.Version != 2 {
		t.Fatalf("new immutable version receipt = %+v", versionReceipt)
	}
	var replay struct {
		VersionID uuid.UUID `json:"version_id"`
		Version   int       `json:"version"`
		Replayed  bool      `json:"replayed"`
	}
	env.mustJSON(t, http.MethodPost, versionPath, versionRequest, &replay)
	if replay.VersionID != versionReceipt.VersionID || replay.Version != 2 || !replay.Replayed {
		t.Fatalf("same version request must replay its original version: %+v", replay)
	}
	env.expectErr(t, http.MethodPost, versionPath, map[string]any{
		"request_id": uuid.NewString(), "expected_version": 1, "content": "旧版本覆盖不应成功",
	}, "agent_revision_conflict")

	quote := "先优化标题"
	start := len([]rune("本周阅读增长，"))
	end := start + len([]rune(quote))
	hash := sha256.Sum256([]byte(quote))
	citation := agentContextReference{Type: "artifact_version", ID: versionReceipt.VersionID, Scope: "turn",
		Anchor: &agentArtifactAnchor{Start: start, End: end, QuoteHash: hex.EncodeToString(hash[:]), Quote: quote}}
	status, body := env.do(http.MethodPost, agentRunPath(conversation, "messages"), map[string]any{
		"text": "请只围绕所选标题段落继续调整。", "context_refs": []agentContextReference{citation},
		"request_id": uuid.NewString(), "protocol_version": 2,
	})
	if status != http.StatusAccepted {
		t.Fatalf("exact artifact citation was rejected: %d %s", status, body)
	}
	aw06WaitRun(t, body)
	var saved []agentContextReference
	if err := env.srv.db.QueryRow(t.Context(), `SELECT context_refs FROM agent_message WHERE conversation_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1`, conversation.ID).Scan(&saved); err != nil || len(saved) != 1 || saved[0].Type != "artifact_version" || saved[0].Anchor == nil || saved[0].Anchor.Quote != quote {
		t.Fatalf("artifact version anchor was not persisted with the new message: %+v %v", saved, err)
	}
	changed := citation
	changed.Anchor = &agentArtifactAnchor{Start: start, End: end, QuoteHash: hex.EncodeToString(hash[:]), Quote: "已变化的选段"}
	env.expectErr(t, http.MethodPost, agentRunPath(conversation, "messages"), map[string]any{
		"text": "不应猜位置", "context_refs": []agentContextReference{changed}, "request_id": uuid.NewString(), "protocol_version": 2,
	}, "agent_context_unavailable")

	other := env.agentRunConversation(t, provider)
	defer deleteConversations(t, other.ID)
	env.expectErr(t, http.MethodPost, agentRunPath(other, "messages"), map[string]any{
		"text": "跨对话引用", "context_refs": []agentContextReference{{Type: "artifact_version", ID: versionReceipt.VersionID, Scope: "turn"}},
		"request_id": uuid.NewString(), "protocol_version": 2,
	}, "agent_context_unavailable")
}
