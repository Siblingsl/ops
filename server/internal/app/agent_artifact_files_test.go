package app

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"image"
	"io"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func aw11Artifact(t *testing.T, conversationID uuid.UUID, kind, source string, contents ...[]byte) uuid.UUID {
	t.Helper()
	var artifactID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), "INSERT INTO agent_artifact(conversation_id,kind,title) VALUES($1,$2,'文件测试') RETURNING id", conversationID, kind).Scan(&artifactID); err != nil {
		t.Fatal(err)
	}
	for i, content := range contents {
		var versionID uuid.UUID
		if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO agent_artifact_version(artifact_id,version,source_kind,content_ref,hash,status)
			VALUES($1,$2,$3,$4,$5,'draft') RETURNING id`, artifactID, i+1, source, content, uuid.NewString()).Scan(&versionID); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(context.Background(), "UPDATE agent_artifact SET current_version_id=$2 WHERE id=$1", artifactID, versionID); err != nil {
			t.Fatal(err)
		}
	}
	return artifactID
}

func TestAW11ArtifactDownloadsArePrivateVersionedAndCSVSafe(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "artifacts")
	conversation := env.createConversation(t, map[string]any{})
	defer deleteConversations(t, conversation.ID)
	v1, _ := agentArtifactTextContent("markdown", "第一版正文")
	v2, _ := agentArtifactTextContent("markdown", "第二版正文")
	artifactID := aw11Artifact(t, conversation.ID, "markdown", "chat", v1, v2)
	path := "/api/v1/agent/artifacts/" + artifactID.String() + "/file"
	response := env.request("GET", path+"?version=1&format=md", nil, "")
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || string(body) != "第一版正文" ||
		!strings.Contains(response.Header.Get("Content-Disposition"), "ops-artifact-v1.md") || response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("versioned download: %d %s %+v", response.StatusCode, body, response.Header)
	}
	if status, body := env.do("GET", path+"?version=2&format=txt", nil); status != 200 || string(body) != "第二版正文" {
		t.Fatalf("v2 download: %d %s", status, body)
	}
	for _, query := range []string{"?format=md", "?version=1&format=html", "?version=1&format=original", "?version=1&format=csv"} {
		if status, body := env.do("GET", path+query, nil); status != 422 {
			t.Fatalf("invalid export format: %d %s", status, body)
		}
	}
	other := env.registerClient(t, "aw11-artifact-reader", testPassword)
	other.use()
	status, body := env.do("GET", path+"?version=1&format=txt", nil)
	other.restore(env)
	if status != 404 || strings.Contains(string(body), "第一版") {
		t.Fatalf("private export leaked: %d %s", status, body)
	}
	tableText := "name,value\n'=literal,ok\n=SUM(A1),+cmd\n<script>alert(1)</script>,https://example.invalid\n"
	content, err := agentArtifactTextContent("table", tableText)
	if err != nil {
		t.Fatal(err)
	}
	tableID := aw11Artifact(t, conversation.ID, "table", "chat", content)
	status, body = env.do("GET", "/api/v1/agent/artifacts/"+tableID.String()+"/file?version=1&format=csv", nil)
	if status != 200 {
		t.Fatalf("CSV download: %d %s", status, body)
	}
	rows, err := csv.NewReader(strings.NewReader(string(body))).ReadAll()
	if err != nil || rows[2][0] != "文本：=SUM(A1)" || rows[2][1] != "文本：+cmd" || rows[3][0] != "<script>alert(1)</script>" {
		t.Fatalf("CSV cells must be escaped and formulas neutralized: %#v %v", rows, err)
	}
	if _, _, err := agentReadArtifactTable("a,b\none\n"); err == nil {
		t.Fatal("ragged table must not be represented as a valid table")
	}
}

func TestAW11ArtifactDownloadRechecksSourceAndSecrets(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "artifacts")
	conversation := env.createConversation(t, map[string]any{})
	defer deleteConversations(t, conversation.ID)
	account := env.accounts(t)
	work := env.readyWork(t, account.wechat, "下载来源权限")
	defer agentDropWork(work.ID)
	content, _ := json.Marshal(map[string]any{"format": "json", "data": map[string]any{"summary": "来自可读作品的摘要"}, "object_ref": map[string]any{"type": "work", "id": work.ID}})
	artifactID := aw11Artifact(t, conversation.ID, "markdown", "g_tool", content)
	path := "/api/v1/agent/artifacts/" + artifactID.String() + "/file?version=1&format=txt"
	if status, body := env.do("GET", path, nil); status != 200 {
		t.Fatalf("readable source export: %d %s", status, body)
	}
	if _, err := env.srv.db.Exec(context.Background(), "UPDATE work SET deleted_at=now() WHERE id=$1", work.ID); err != nil {
		t.Fatal(err)
	}
	if status, body := env.do("GET", path, nil); status != 404 {
		t.Fatalf("revoked source must fail download: %d %s", status, body)
	}
	const testSecret = "sk-abcdefghijklmnopqrstuvwxyz0123456789"
	secretContent, _ := json.Marshal(map[string]any{"format": "text", "text": testSecret})
	secretID := aw11Artifact(t, conversation.ID, "markdown", "chat", secretContent)
	status, body := env.do("GET", "/api/v1/agent/artifacts/"+secretID.String()+"/file?version=1&format=txt", nil)
	if status != 422 || strings.Contains(string(body), testSecret) {
		t.Fatalf("sensitive export must fail without echo: %d %s", status, body)
	}
}

func TestAW11CSVFormulaPrefixesAreNeutralized(t *testing.T) {
	for _, value := range []string{"=1+1", "+cmd", "-cmd", "@SUM(A1)", "  =1", "\tformula", "\rformula", "\nformula", "＝1", "＋1", "－1", "＠SUM(A1)", "\uFEFF=1", "\u3000=1", "'=1", "''+cmd"} {
		if got := agentCSVSafeCell(value); got != "文本："+value {
			t.Errorf("unsafe CSV prefix %q => %q", value, got)
		}
	}
	for _, value := range []string{"plain", "123", "'already safe", "https://example.invalid"} {
		if got := agentCSVSafeCell(value); got != value {
			t.Errorf("ordinary CSV cell changed %q => %q", value, got)
		}
	}
}

func TestAW11UploadedImageArtifactDownloadsItsOriginal(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "artifacts")
	provider := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, provider)
	defer deleteConversations(t, conversation.ID)
	status, attachment, body := agentUploadAttachment(t, "original.png", testPNG(80, 60), conversation.ID.String())
	if status != 200 {
		t.Fatalf("upload: %d %s", status, body)
	}
	env.sse(t, agentRunPath(conversation, "messages"), map[string]any{"text": "查看参考图", "attachment_ids": []string{attachment.ID.String()}})
	var artifactID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), "SELECT id FROM agent_artifact WHERE conversation_id=$1 AND kind='image'", conversation.ID).Scan(&artifactID); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/agent/artifacts/" + artifactID.String() + "/file?version=1&format=original"
	status, body = env.do("GET", path, nil)
	config, format, err := image.DecodeConfig(bytes.NewReader(body))
	if status != 200 || err != nil || format != "png" || config.Width != 80 || config.Height != 60 {
		t.Fatalf("original image: status %d, format %s, dimensions %+v, error %v", status, format, config, err)
	}
	other := env.registerClient(t, "aw11-image-reader", testPassword)
	other.use()
	status, _ = env.do("GET", path, nil)
	other.restore(env)
	if status != 404 {
		t.Fatalf("private original leaked: %d", status)
	}
}
