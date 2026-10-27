package app

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestAW11DocumentsRequireFeatureAndParseRealCSV(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "")
	code, _, body := agentUploadAttachment(t, "report.csv", []byte("title,value\nhello,1\n"), "")
	if code != 409 || agentErrCodeOf(t, body) != "agent_feature_unavailable" {
		t.Fatalf("document upload must be feature gated: %d %s", code, body)
	}
	t.Setenv(agentWorkbenchFeatureEnv, "document_parse,context_refs")
	conversation := env.agentRunConversation(t, env.ensureToolModel(t))
	defer deleteConversations(t, conversation.ID)
	const marker = "AW11原始资料只作外部来源"
	code, attachment, body := agentUploadAttachment(t, "report.csv", []byte("title,value\n"+marker+",42\n"), conversation.ID.String())
	if code != 200 || attachment.Kind != "document" || attachment.ParseStatus != "ready" || attachment.ParserVersion == "" ||
		attachment.RowCount == nil || *attachment.RowCount != 2 || attachment.ExtractedChars == nil ||
		attachment.InjectedChars == nil || *attachment.InjectedChars != *attachment.ExtractedChars {
		t.Fatalf("real CSV must return a usable parse receipt: %d %+v %s", code, attachment, body)
	}
	var loadCount int
	if err := env.srv.db.QueryRow(context.Background(), "SELECT count(*) FROM agent_attachment_load WHERE attachment_id=$1", attachment.ID).Scan(&loadCount); err != nil || loadCount != 0 {
		t.Fatalf("upload must not claim loaded: %d %v", loadCount, err)
	}
	env.llm.ResetRequests()
	env.sse(t, agentRunPath(conversation, "messages"), map[string]any{
		"text": "请概括上传的运营资料", "attachment_ids": []string{attachment.ID.String()},
	})
	requests := env.llm.Requests()
	if len(requests) == 0 || !strings.Contains(requests[0], marker) {
		t.Fatal("extracted document text did not reach the existing agent model loop")
	}
	var loadedChars int
	if err := env.srv.db.QueryRow(context.Background(), "SELECT chars FROM agent_attachment_load WHERE attachment_id=$1", attachment.ID).Scan(&loadedChars); err != nil || loadedChars != *attachment.InjectedChars {
		t.Fatalf("actual request assembly receipt: %d %v", loadedChars, err)
	}
	sources, err := env.srv.agentCollectSources(context.Background(), conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, source := range sources.sources {
		if strings.Contains(source.Text, marker) {
			if source.Kind != agentSrcAttachment || source.Purpose != agentPurposeBusiness {
				t.Fatalf("document text must remain an external attachment source: %+v", source)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("extracted document source was not collected")
	}
}

func TestAW11AttachmentUploadRequestIsIdempotentAndPayloadBound(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "document_parse")
	requestID := uuid.NewString()
	code, first, body := agentUploadAttachment(t, "retry.csv", []byte("a,b\nx,1\n"), "", requestID)
	if code != 200 {
		t.Fatalf("first upload: %d %s", code, body)
	}
	defer func() { _, _ = env.do("DELETE", agentAttachmentPath(first.ID), nil) }()
	code, replay, body := agentUploadAttachment(t, "retry.csv", []byte("a,b\nx,1\n"), "", requestID)
	if code != 200 || replay.ID != first.ID {
		t.Fatalf("same upload request must return one resource: %d %+v %s", code, replay, body)
	}
	code, _, body = agentUploadAttachment(t, "retry.csv", []byte("a,b\nchanged,2\n"), "", requestID)
	if code != 409 || agentErrCodeOf(t, body) != "agent_request_conflict" {
		t.Fatalf("request payload conflict: %d %s", code, body)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(), "SELECT count(*) FROM agent_attachment WHERE upload_request_id=$1", requestID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate attachment created: %d %v", count, err)
	}
}

func TestAW11AttachmentTextCountsTowardWindowBeforeRunAccepted(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "document_parse")
	conversation := env.agentRunConversation(t, env.ensureToolModel(t))
	defer deleteConversations(t, conversation.ID)
	var ids []string
	for i := 0; i < 3; i++ {
		code, attachment, body := agentUploadAttachment(t, "large.csv", []byte("value\n"+strings.Repeat("x", 20000)+"\n"), conversation.ID.String())
		if code != 200 {
			t.Fatalf("upload: %d %s", code, body)
		}
		ids = append(ids, attachment.ID.String())
	}
	env.expectErr(t, "POST", agentRunPath(conversation, "messages"), map[string]any{"text": "请读取资料", "attachment_ids": ids}, "context_budget_exceeded")
	var messages, loads int
	if err := env.srv.db.QueryRow(context.Background(), "SELECT count(*) FROM agent_message WHERE conversation_id=$1", conversation.ID).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(), "SELECT count(*) FROM agent_attachment_load l JOIN agent_run r ON r.id=l.run_id WHERE r.conversation_id=$1", conversation.ID).Scan(&loads); err != nil {
		t.Fatal(err)
	}
	if messages != 0 || loads != 0 {
		t.Fatalf("rejected context must not save a message or a loaded receipt: %d %d", messages, loads)
	}
}

func TestAW11DocumentSecretIsQuarantinedAndCannotBeSentOrDownloaded(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "document_parse,context_refs")
	conversation := env.agentRunConversation(t, env.ensureToolModel(t))
	defer deleteConversations(t, conversation.ID)
	const testSecret = "sk-abcdefghijklmnopqrstuvwxyz0123456789"
	code, attachment, body := agentUploadAttachment(t, "private.csv", []byte("label,value\nkey,"+testSecret+"\n"), conversation.ID.String())
	if code != 200 || attachment.ParseStatus != "quarantined" || attachment.URL != "" ||
		attachment.InjectedChars == nil || *attachment.InjectedChars != 0 || strings.Contains(string(body), testSecret) {
		t.Fatalf("secret-bearing document was not quarantined without echo: %d %+v %s", code, attachment, body)
	}
	var storedText *string
	if err := env.srv.db.QueryRow(context.Background(), "SELECT text_content FROM agent_attachment WHERE id=$1", attachment.ID).Scan(&storedText); err != nil {
		t.Fatal(err)
	}
	if storedText != nil {
		t.Fatal("quarantined document must not retain model-readable text")
	}
	if status, response := agentAttachmentFileBytes(t, attachment.ID, ""); status != 404 || strings.Contains(string(response), testSecret) {
		t.Fatalf("quarantined document must not have a file preview: %d %s", status, response)
	}
	env.expectErr(t, "POST", agentRunPath(conversation, "messages"),
		map[string]any{"text": "使用该文档", "attachment_ids": []string{attachment.ID.String()}}, "agent_attachment_invalid")
	env.expectErr(t, "POST", "/api/v1/agent/context-preview",
		map[string]any{"attachment_ids": []string{attachment.ID.String()}}, "agent_attachment_invalid")
	if status, response := env.do("DELETE", agentAttachmentPath(attachment.ID), nil); status != 200 {
		t.Fatalf("owner must be able to delete quarantined upload: %d %s", status, response)
	}
}

func TestAW11DocumentPreviewRechecksSecretsAndOriginalFileIsPrivate(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "document_parse,context_refs")
	code, attachment, body := agentUploadAttachment(t, "private.csv", []byte("title,value\npublic,42\n"), "")
	if code != 200 {
		t.Fatalf("upload: %d %s", code, body)
	}
	defer func() { _, _ = env.do("DELETE", agentAttachmentPath(attachment.ID), nil) }()
	other := env.registerClient(t, "aw11-private-reader", testPassword)
	other.use()
	status, response := env.do("GET", agentAttachmentPath(attachment.ID)+"/file", nil)
	other.restore(env)
	if status != 404 || strings.Contains(string(response), "public") {
		t.Fatalf("other member must not read a private original: %d %s", status, response)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		"UPDATE agent_attachment SET text_content='sk-abcdefghijklmnopqrstuvwxyz0123456789' WHERE id=$1", attachment.ID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", "/api/v1/agent/context-preview",
		map[string]any{"attachment_ids": []string{attachment.ID.String()}}, "agent_attachment_parse_failed")
	var parseStatus string
	if err := env.srv.db.QueryRow(context.Background(), "SELECT parse_status FROM agent_attachment WHERE id=$1", attachment.ID).Scan(&parseStatus); err != nil {
		t.Fatal(err)
	}
	if parseStatus != "quarantined" {
		t.Fatal("preview must quarantine newly detected sensitive content")
	}
}
