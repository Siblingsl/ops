package app

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

// DEV-AI27-16（W16）双模式语音测试（27 §11.4 服务端子项）：
// V01 转写终稿可编辑（reviewable 状态）；临时转写不自动创建消息/run；
// V02 同 request_id 幂等重放；V03 红线（语音不注入 gate_ack——结构断言）；V04 结束/打断语义分离；
// V06 音频不落盘（无音频持久化列/端点——结构断言）；V07 计费记账留 W06 模型循环增量。

func w16CreateConv(t *testing.T) agentConversation {
	t.Helper()
	// 组合跑时前序测试的 registerClient 可能污染 env 会话——强制重登 owner。
	if st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		t.Fatalf("W16 恢复 owner 会话失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
	providerID := env.ensureToolModel(t)
	return env.agentRunConversation(t, providerID)
}

func w16CreateSession(t *testing.T, conv agentConversation, mode string) voiceSessionView {
	t.Helper()
	var session voiceSessionView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/voice-sessions", map[string]any{
		"mode": mode,
	}, &session)
	return session
}

func TestW16FeatureGatesAndSessionLifecycle(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "")
	conv := w16CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/voice-sessions", map[string]any{"mode": "dictation"}, "agent_feature_unavailable")

	// 只开 dictation：realtime 不可用
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,voice_dictation")
	var session1 voiceSessionView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/voice-sessions", map[string]any{"mode": "dictation"}, &session1)
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+uuid.NewString()+"/voice-sessions", map[string]any{"mode": "realtime"}, "agent_feature_unavailable")

	// dictation 会话冲突（一设备一个活动会话）
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/voice-sessions", map[string]any{"mode": "dictation"}, "voice_session_active")

	// 开 realtime：结束当前会话后可创建 realtime
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,voice_dictation,voice_realtime")
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session1.ID, map[string]any{"state": "ended"}, nil)
	realtime := w16CreateSession(t, conv, "realtime")
	if realtime.Mode != "realtime" {
		t.Fatalf("realtime 会话模式错误：%+v", realtime)
	}
	// 清理：结束活动会话（同用户共享库，后续测试需能创建新会话）
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+realtime.ID, map[string]any{"state": "ended"}, nil)
}

func TestW16V01DictationTranscribeEdit(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,voice_dictation")
	conv := w16CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	session := w16CreateSession(t, conv, "dictation")

	// 转写提交（reviewable）——不创建消息/run
	var turnResp struct {
		Turn voiceTurnView `json:"turn"`
	}
	requestID := uuid.NewString()
	env.mustJSON(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/turns", map[string]any{
		"purpose": "transcribe", "transcription": "帮我写一篇关于春季护肤的微头条", "request_id": requestID,
	}, &turnResp)
	turn := turnResp.Turn
	if turn.State != "reviewable" || turn.FinalMessageID != "" || turn.RunID != "" {
		t.Fatalf("transcribe 回合应 reviewable 且无消息/run：%+v", turn)
	}

	// V01：终稿可编辑
	var editedResp struct {
		Turn voiceTurnView `json:"turn"`
	}
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session.ID+"/turns/"+turn.ID, map[string]any{
		"transcription": "帮我写一篇关于春季护肤的微头条，重点讲敏感肌注意事项",
	}, &editedResp)
	edited := editedResp.Turn
	if edited.Transcription != "帮我写一篇关于春季护肤的微头条，重点讲敏感肌注意事项" {
		t.Fatalf("编辑后转写文本不一致：%+v", edited)
	}

	// 幂等重放（V02 子项）
	var replayResp struct {
		Turn voiceTurnView `json:"turn"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/turns", map[string]any{
		"purpose": "transcribe", "transcription": "原文", "request_id": requestID,
	}, &replayResp)
	replay := replayResp.Turn
	if replay.ID != turn.ID {
		t.Fatalf("同 request_id 应幂等返回原 turn：%+v vs %+v", turn, replay)
	}

	// 无消息/run 产生（临时转写不发送不作为指令）
	var msgCount int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1`, conv.ID).Scan(&msgCount); err != nil {
		t.Fatal(err)
	}
	if msgCount != 0 {
		t.Fatalf("转写不得自动创建消息：%d", msgCount)
	}

	// 结束会话后回合拒绝
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{"state": "ended"}, nil)
	env.expectErr(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/turns", map[string]any{
		"purpose": "transcribe", "transcription": "迟到", "request_id": uuid.NewString(),
	}, "voice_session_ended")

	// 结束后可查询
	var detail struct {
		Session voiceSessionView `json:"session"`
		Turns   []voiceTurnView  `json:"turns"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{}, &detail)
	if detail.Session.State != "ended" || len(detail.Turns) != 1 {
		t.Fatalf("结束后查询状态错误：%+v turns=%d", detail.Session, len(detail.Turns))
	}
}

func TestW16V02RealtimeCommitAndDedup(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,voice_dictation,voice_realtime")
	conv := w16CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	session := w16CreateSession(t, conv, "realtime")

	// 实时 commit（submitted 状态）
	var turnResp struct {
		Turn voiceTurnView `json:"turn"`
	}
	requestID := uuid.NewString()
	env.mustJSON(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/turns", map[string]any{
		"purpose": "commit_realtime", "transcription": "帮我查一下最近的竞品动态", "request_id": requestID,
	}, &turnResp)
	turn := turnResp.Turn
	if turn.State != "submitted" {
		t.Fatalf("realtime commit 应 submitted：%+v", turn)
	}

	// 同 request_id 幂等（重连/重复事件去重，V02）
	var replayResp struct {
		Turn voiceTurnView `json:"turn"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/turns", map[string]any{
		"purpose": "commit_realtime", "transcription": "帮我查一下最近的竞品动态", "request_id": requestID,
	}, &replayResp)
	replay := replayResp.Turn
	if replay.ID != turn.ID || replay.TurnIndex != turn.TurnIndex {
		t.Fatalf("实时回合同 request_id 应幂等：%+v vs %+v", turn, replay)
	}

	// 打断（恢复 active）
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{"state": "active"}, nil)

	// 跨用户不可见（V06 隐私）
	other := env.registerClient(t, "w16-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	other.expectErr(t, "GET", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{}, "not_found")
	other.restore(env)

	// viewer 403
	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "w16-viewer-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	if st, _ := viewer.do("POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/voice-sessions", map[string]any{"mode": "dictation"}); st != http.StatusForbidden {
		t.Fatalf("viewer 应 403，got %d", st)
	}
	viewer.restore(env)
	// 清理：结束活动会话（同用户共享库）
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{"state": "ended"}, nil)
}

// seedASRRoute 在测试库内播种一条 asr 供应商与路由，返回清理函数。
// 密钥用与生产一致的 box 加密；测试只使用占位值，不是真实凭据。
func seedASRRoute(t *testing.T, baseURL, model string) {
	t.Helper()
	ws := env.me(t).Workspace.ID
	enc, err := env.srv.box.Encrypt("asr-test-placeholder-not-a-secret")
	if err != nil {
		t.Fatal(err)
	}
	var providerID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO model_provider (workspace_id, name, base_url, api_key_enc, key_version, models, status, execution_location)
		 VALUES ($1,'ASR 测试供应商',$2,$3,$4,$5,'active','server') RETURNING id`,
		ws, baseURL, enc, env.srv.box.Version, []string{model}).Scan(&providerID); err != nil {
		t.Fatalf("播种 ASR 供应商失败：%v", err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO model_route (workspace_id, task_type, provider_id, model, execution_location)
		 VALUES ($1,'asr',$2,$3,'server')
		 ON CONFLICT (workspace_id, task_type) DO UPDATE
		 SET provider_id=EXCLUDED.provider_id, model=EXCLUDED.model`,
		ws, providerID, model); err != nil {
		t.Fatalf("播种 asr 路由失败：%v", err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM model_route WHERE workspace_id=$1 AND task_type='asr'`, ws)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM model_provider WHERE id=$1`, providerID)
	})
}

// TestW16V05ASRTranscribesWithConfiguredRoute：配置 asr 路由后，音频经真实
// OpenAI 兼容 /audio/transcriptions 协议转写，回执模型与时长入库（离线 mock，不产生费用）。
func TestW16V05ASRTranscribesWithConfiguredRoute(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,voice_dictation")

	var gotAuth, gotModel string
	asr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/transcriptions" {
			t.Errorf("ASR 路径错误：%s", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("ASR multipart 解析失败：%v", err)
		}
		gotModel = r.FormValue("model")
		file, _, err := r.FormFile("file")
		if err != nil {
			t.Errorf("ASR 缺少 file：%v", err)
			return
		}
		defer file.Close()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"这是真实转写链路产出的终稿","duration":8.25}`))
	}))
	defer asr.Close()
	seedASRRoute(t, asr.URL+"/v1", "asr-test-model")

	conv := w16CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	session := w16CreateSession(t, conv, "dictation")

	var resp struct {
		Turn voiceTurnView `json:"turn"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/turns", map[string]any{
		"purpose": "transcribe", "request_id": uuid.NewString(),
		"audio_base64":   base64.StdEncoding.EncodeToString([]byte("fake-audio-bytes")),
		"audio_filename": "clip.webm",
	}, &resp)

	turn := resp.Turn
	if turn.State != "reviewable" {
		t.Fatalf("转写成功应 reviewable：%+v", turn)
	}
	if turn.Transcription != "这是真实转写链路产出的终稿" {
		t.Fatalf("转写文本未落库：%q", turn.Transcription)
	}
	if turn.ASRSeconds != 8.25 || turn.ASRModel != "asr-test-model" || turn.ASRProvider == "" {
		t.Fatalf("V07 ASR 用量/模型回执未记录：%+v", turn)
	}
	if turn.FinalMessageID != "" || turn.RunID != "" {
		t.Fatal("转写回合不得自动创建消息或 run（V01）")
	}
	if gotModel != "asr-test-model" || gotAuth != "Bearer asr-test-placeholder-not-a-secret" {
		t.Fatalf("ASR 请求头/模型错误：model=%q auth=%q", gotModel, gotAuth)
	}
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{"state": "ended"}, nil)
}

// TestW16V05ASRFailureKeepsErrorTurn：上游失败时返回明确错误码并保留 error 回合，
// 不把失败伪装成「空转写」（27 §11.4.5）。
func TestW16V05ASRFailureKeepsErrorTurn(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,voice_dictation")

	asr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid key"}`))
	}))
	defer asr.Close()
	seedASRRoute(t, asr.URL+"/v1", "asr-test-model")

	conv := w16CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	session := w16CreateSession(t, conv, "dictation")

	env.expectErr(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/turns", map[string]any{
		"purpose": "transcribe", "request_id": uuid.NewString(),
		"audio_base64":   base64.StdEncoding.EncodeToString([]byte("fake-audio-bytes")),
		"audio_filename": "clip.webm",
	}, "voice_provider_unavailable")

	var detail struct {
		Turns []voiceTurnView `json:"turns"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{}, &detail)
	if len(detail.Turns) != 1 || detail.Turns[0].State != "error" || detail.Turns[0].ASRErrorCode != "voice_provider_unavailable" {
		t.Fatalf("失败回合未保留或错误码缺失：%+v", detail.Turns)
	}
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{"state": "ended"}, nil)
}

// TestW16V05ASRMissingRouteRejects：未配置 asr 路由时准确报能力缺失，不回退为空转写。
func TestW16V05ASRMissingRouteRejects(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,voice_dictation")

	conv := w16CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	session := w16CreateSession(t, conv, "dictation")

	env.expectErr(t, "POST", "/api/v1/agent/voice-sessions/"+session.ID+"/turns", map[string]any{
		"purpose": "transcribe", "request_id": uuid.NewString(),
		"audio_base64":   base64.StdEncoding.EncodeToString([]byte("fake-audio-bytes")),
		"audio_filename": "clip.webm",
	}, "voice_capability_unsupported")
	env.mustJSON(t, "PATCH", "/api/v1/agent/voice-sessions/"+session.ID, map[string]any{"state": "ended"}, nil)
}
