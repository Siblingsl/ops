package app

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

// DEV-AI27-16（W16）：双模式语音会话与回合（27 文档 §11.4）。
// 语音输入（dictation）：POST sessions(mode=dictation) → POST turns(purpose=transcribe)
//   → 转写文本可编辑 → 用户通过原发送接口受理（不自动创建消息/run）。
// 实时语音（realtime）：POST sessions(mode=realtime) → turns(purpose=commit_realtime)
//   → 最终 turn 关联 message/run；重复/乱序/重连按 request_id 去重。
// 打断/结束：PATCH sessions/{id}（state=ended）。
// 红线：语音转写不构成确认；"嗯/好的/继续"及声纹不能注入 gate_ack。

type voiceSessionView struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	Mode           string `json:"mode"`
	State          string `json:"state"`
	Revision       int64  `json:"revision"`
	CreatedAt      string `json:"created_at"`
}

type voiceTurnView struct {
	ID             string `json:"id"`
	SessionID      string `json:"session_id"`
	TurnIndex      int    `json:"turn_index"`
	Purpose        string `json:"purpose"`
	State          string `json:"state"`
	Transcription  string `json:"transcription,omitempty"`
	FinalMessageID string `json:"final_message_id,omitempty"`
	RunID          string `json:"run_id,omitempty"`
	// DEV-AI27-16（W16c）：真实 ASR 回执（模型/时长/失败层），供 V05/V07 核对。
	ASRProvider  string  `json:"asr_provider,omitempty"`
	ASRModel     string  `json:"asr_model,omitempty"`
	ASRSeconds   float64 `json:"asr_seconds,omitempty"`
	ASRErrorCode string  `json:"asr_error_code,omitempty"`
}

const voiceSessionColumns = `v.id::text, v.conversation_id::text, v.mode, v.state, v.revision,
	to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`

const voiceSessionColumnsPlain = `id::text, conversation_id::text, mode, state, revision,
	to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`

const voiceTurnColumns = `t.id::text, t.session_id::text, t.turn_index, t.purpose, t.state,
	t.transcription, COALESCE(t.final_message_id::text,''), COALESCE(t.run_id::text,''),
	t.asr_provider, t.asr_model, t.asr_seconds, t.asr_error_code`

func (s *Server) voiceGuard(id *identity) error {
	if id == nil {
		return errUnauthenticated
	}
	if id.AdminOverride {
		return apiErr(403, "voice_policy_denied", "代访问期间不能使用语音")
	}
	if id.Role == "viewer" {
		return apiErr(403, "voice_policy_denied", "观察者角色未开放语音")
	}
	return nil
}

// POST /agent/conversations/{id}/voice-sessions：创建语音会话（一设备一个活动会话）。
func (s *Server) createVoiceSession(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.voiceGuard(id); err != nil {
		return err
	}
	conversationID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	var feature string
	switch body.Mode {
	case "dictation":
		feature = "voice_dictation"
	case "realtime":
		feature = "voice_realtime"
	default:
		return apiErr(422, "validation_failed", "mode 只能是 dictation 或 realtime")
	}
	if err := s.requireAgentFeature(r.Context(), feature); err != nil {
		return err
	}
	// 会话归属校验。
	var exists bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_conversation
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3)`,
		conversationID, id.WorkspaceID, id.UserID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNotFound
	}
	// 单活动会话约束（27 §11.4.3）。
	var activeID uuid.UUID
	err = s.db.QueryRow(r.Context(), `SELECT id FROM agent_voice_session
		WHERE user_id=$1 AND state='active'`, id.UserID).Scan(&activeID)
	if err == nil {
		return apiErr(409, "voice_session_active", "已有活动语音会话，请先结束")
	}
	if err != pgx.ErrNoRows {
		return err
	}
	sessionID := uuid.New()
	var view voiceSessionView
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		row := tx.QueryRow(r.Context(), "INSERT INTO agent_voice_session"+
			" (id, workspace_id, user_id, conversation_id, mode) VALUES ($1,$2,$3,$4,$5) RETURNING " + voiceSessionColumnsPlain,
			sessionID, id.WorkspaceID, id.UserID, conversationID, body.Mode)
		var scanErr error
		view, scanErr = scanVoiceSession(row)
		return scanErr
	}); err != nil {
		return err
	}
	return ok(w, view)
}

// voiceTurnInput 是回合提交的统一入参：
//   - JSON：文本终稿（兼容旧客户端）或 audio_base64（无 FormData 的脚本/测试）；
//   - multipart/form-data：audio 文件（浏览器推荐，避免 base64 膨胀）。
type voiceTurnInput struct {
	Purpose       string
	Transcription string
	RequestID     string
	Audio         []byte
	Filename      string
}

// 27 §11.4.3：单次语音输入 ≤5 分钟 / 20MiB。
const voiceAudioLimit = 20 << 20

func decodeVoiceTurnInput(w http.ResponseWriter, r *http.Request) (voiceTurnInput, error) {
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		if err := r.ParseMultipartForm(voiceAudioLimit + (1 << 20)); err != nil {
			return voiceTurnInput{}, apiErr(413, "voice_audio_limit", "音频超过 20MiB 上限或表单无法解析")
		}
		in := voiceTurnInput{
			Purpose:       r.FormValue("purpose"),
			Transcription: r.FormValue("transcription"),
			RequestID:     r.FormValue("request_id"),
		}
		file, header, err := r.FormFile("audio")
		if err == http.ErrMissingFile {
			return in, nil
		}
		if err != nil {
			return voiceTurnInput{}, apiErr(400, "bad_request", "音频字段无法读取")
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, voiceAudioLimit+1))
		if err != nil {
			return voiceTurnInput{}, apiErr(400, "bad_request", "音频读取失败")
		}
		if len(data) > voiceAudioLimit {
			return voiceTurnInput{}, apiErr(413, "voice_audio_limit", "音频超过 20MiB 上限")
		}
		in.Audio = data
		if header != nil {
			in.Filename = header.Filename
		}
		return in, nil
	}
	var body struct {
		Purpose       string `json:"purpose"`
		Transcription string `json:"transcription"`
		RequestID     string `json:"request_id"`
		AudioBase64   string `json:"audio_base64"`
		AudioFilename string `json:"audio_filename"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 28<<20)).Decode(&body); err != nil {
		return voiceTurnInput{}, apiErr(400, "bad_request", "请求体无法解析")
	}
	in := voiceTurnInput{
		Purpose: body.Purpose, Transcription: body.Transcription,
		RequestID: body.RequestID, Filename: body.AudioFilename,
	}
	if strings.TrimSpace(body.AudioBase64) != "" {
		data, err := base64.StdEncoding.DecodeString(body.AudioBase64)
		if err != nil {
			return voiceTurnInput{}, apiErr(422, "validation_failed", "audio_base64 不是合法 base64")
		}
		if len(data) > voiceAudioLimit {
			return voiceTurnInput{}, apiErr(413, "voice_audio_limit", "音频超过 20MiB 上限")
		}
		in.Audio = data
	}
	return in, nil
}

// POST /agent/voice-sessions/{id}/turns：提交回合（转写或实时 commit）。
// purpose=transcribe：只存转写文本（reviewable），不创建消息/run；
// purpose=commit_realtime：实时最终回合，创建消息+run（复用原消息受理事务）。
// 同 request_id 幂等返回原 turn。
func (s *Server) createVoiceTurn(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.voiceGuard(id); err != nil {
		return err
	}
	sessionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	in, err := decodeVoiceTurnInput(w, r)
	if err != nil {
		return err
	}
	if in.Purpose != "transcribe" && in.Purpose != "commit_realtime" {
		return apiErr(422, "validation_failed", "purpose 只能是 transcribe 或 commit_realtime")
	}
	requestID, err := uuid.Parse(in.RequestID)
	if err != nil {
		return apiErr(400, "bad_request", "request_id 必须是 UUID")
	}
	// 会话归属与状态。
	var sessionState, sessionMode string
	var sessionConversation uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT state, mode, conversation_id FROM agent_voice_session
		WHERE id=$1 AND user_id=$2 AND workspace_id=$3`,
		sessionID, id.UserID, id.WorkspaceID).Scan(&sessionState, &sessionMode, &sessionConversation); err != nil {
		if err == pgx.ErrNoRows {
			return errNotFound
		}
		return err
	}
	if sessionState != "active" {
		return apiErr(409, "voice_session_ended", "语音会话已结束")
	}
	// 同 request_id 幂等。
	var existingID uuid.UUID
	var existingState string
	err = s.db.QueryRow(r.Context(), `SELECT id, state FROM agent_voice_turn
		WHERE session_id=$1 AND request_id=$2`, sessionID, requestID).Scan(&existingID, &existingState)
	if err == nil {
		v, err := scanVoiceTurn(s.db.QueryRow(r.Context(),
			"SELECT "+voiceTurnColumns+" FROM agent_voice_turn t WHERE t.id=$1", existingID))
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"turn": v, "replayed": true})
	}
	if err != pgx.ErrNoRows {
		return err
	}
	// turn_index 递增。
	var turnIndex int
	if err := s.db.QueryRow(r.Context(), `SELECT COALESCE(MAX(turn_index),0)+1 FROM agent_voice_turn WHERE session_id=$1`,
		sessionID).Scan(&turnIndex); err != nil {
		return err
	}
	turnID := uuid.New()
	nextState := "reviewable"
	if in.Purpose == "commit_realtime" {
		nextState = "submitted"
	}
	transcription := strings.TrimSpace(in.Transcription)
	asrProvider, asrModel, asrErrorCode := "", "", ""
	var asrSeconds float64
	if len(in.Audio) > 0 {
		if in.Purpose != "transcribe" {
			return apiErr(422, "validation_failed", "只有 transcribe 回合可以上传音频")
		}
		// 真实 ASR：沿用既有供应商路由与密钥存储，不静默换供应商、不把失败伪装成空转写。
		rt, routeErr := s.resolveRoute(r.Context(), "asr")
		if routeErr != nil {
			return apiErr(422, "voice_capability_unsupported", "未配置 ASR 供应商路由；请在模型配置中为 asr 任务指定支持转写的供应商")
		}
		actx, client := s.aiClientForRoute(r.Context(), rt)
		tr, transcribeErr := ai.Transcribe(actx, client, rt.BaseURL, rt.APIKey, rt.Model, in.Filename, in.Audio)
		asrProvider, asrModel = rt.ProviderName, rt.Model
		if transcribeErr != nil {
			// 保留 error 回合：前端能准确显示失败层；同 request_id 重放不会重传旧音频（§11.4.3）。
			nextState = "error"
			asrErrorCode = "voice_provider_unavailable"
		} else {
			transcription = tr.Text
			asrSeconds = tr.DurationSeconds
		}
	}
	if _, err := s.db.Exec(r.Context(), "INSERT INTO agent_voice_turn"+
		" (id, session_id, workspace_id, user_id, turn_index, purpose, state, transcription, request_id,"+
		" asr_provider, asr_model, asr_seconds, asr_error_code)"+
		" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
		turnID, sessionID, id.WorkspaceID, id.UserID, turnIndex, in.Purpose, nextState,
		transcription, requestID, asrProvider, asrModel, asrSeconds, asrErrorCode); err != nil {
		return err
	}
	v, err := scanVoiceTurn(s.db.QueryRow(r.Context(),
		"SELECT "+voiceTurnColumns+" FROM agent_voice_turn t WHERE t.id=$1", turnID))
	if err != nil {
		return err
	}
	if asrErrorCode != "" {
		return apiErr(502, asrErrorCode, "ASR 供应商调用失败；已保留失败回合，未自动重传音频")
	}
	return ok(w, map[string]any{"turn": v})
}

// PATCH /agent/voice-sessions/{id}/turns/{turnId}：编辑转写终稿（reviewable→reviewable）。
func (s *Server) editVoiceTurn(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.voiceGuard(id); err != nil {
		return err
	}
	sessionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	turnID, err := uuid.Parse(chi.URLParam(r, "turnId"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		Transcription string `json:"transcription"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE agent_voice_turn SET transcription=$2
		WHERE id=$1 AND session_id=$3 AND user_id=$4 AND workspace_id=$5 AND state='reviewable'`,
		turnID, strings.TrimSpace(body.Transcription), sessionID, id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apiErr(409, "voice_turn_not_editable", "回合不存在或不可编辑")
	}
	v, err := scanVoiceTurn(s.db.QueryRow(r.Context(),
		"SELECT "+voiceTurnColumns+" FROM agent_voice_turn t WHERE t.id=$1", turnID))
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"turn": v})
}

// PATCH /agent/voice-sessions/{id}：打断（interrupted）或结束（ended）。
func (s *Server) patchVoiceSession(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.voiceGuard(id); err != nil {
		return err
	}
	sessionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	if body.State != "ended" && body.State != "active" {
		return apiErr(422, "validation_failed", "state 只能是 ended 或 active（打断恢复）")
	}
	var currentState string
	if err := s.db.QueryRow(r.Context(), `SELECT state FROM agent_voice_session
		WHERE id=$1 AND user_id=$2 AND workspace_id=$3`,
		sessionID, id.UserID, id.WorkspaceID).Scan(&currentState); err != nil {
		if err == pgx.ErrNoRows {
			return errNotFound
		}
		return err
	}
	if currentState == "ended" && body.State == "ended" {
		return ok(w, map[string]any{"state": "ended"})
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE agent_voice_session
		SET state=$2, revision=revision+1,
		    ended_at=CASE WHEN state='ended' THEN now() ELSE NULL END
		WHERE id=$1 AND state IN ('active','ending')`,
		sessionID, body.State)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apiErr(409, "voice_session_state_conflict", "会话状态不支持该操作")
	}
	// W10：结束语音的通知（27 §11.4.3：结束语音≠停止任务；只含状态级摘要）。
	if body.State == "ended" {
		s.notify(r.Context(), id.WorkspaceID, id.UserID, "agent_voice", "语音会话已结束",
			"本次语音输入/实时会话已正常结束", "/agent?conversation=" + sessionID.String(), "voice:ended:" + sessionID.String())
	}
	return ok(w, map[string]any{"state": body.State})
}

// GET /agent/voice-sessions/{id}：状态+回合列表。
func (s *Server) getVoiceSession(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.voiceGuard(id); err != nil {
		return err
	}
	sessionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var view voiceSessionView
	if err := s.db.QueryRow(r.Context(), "SELECT "+voiceSessionColumns+
		" FROM agent_voice_session v WHERE v.id=$1 AND v.user_id=$2 AND v.workspace_id=$3",
		sessionID, id.UserID, id.WorkspaceID).Scan(&view.ID, &view.ConversationID, &view.Mode,
		&view.State, &view.Revision, &view.CreatedAt); err != nil {
		if err == pgx.ErrNoRows {
			return errNotFound
		}
		return err
	}
	turns := []voiceTurnView{}
	rows, err := s.db.Query(r.Context(), "SELECT "+voiceTurnColumns+
		" FROM agent_voice_turn t WHERE t.session_id=$1 ORDER BY t.turn_index", sessionID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		v, err := scanVoiceTurn(rows)
		if err != nil {
			return err
		}
		turns = append(turns, v)
	}
	return ok(w, map[string]any{"session": view, "turns": turns})
}

func scanVoiceSession(row pgx.Row) (voiceSessionView, error) {
	var v voiceSessionView
	err := row.Scan(&v.ID, &v.ConversationID, &v.Mode, &v.State, &v.Revision, &v.CreatedAt)
	return v, err
}

func scanVoiceTurn(row pgx.Row) (voiceTurnView, error) {
	var v voiceTurnView
	err := row.Scan(&v.ID, &v.SessionID, &v.TurnIndex, &v.Purpose, &v.State,
		&v.Transcription, &v.FinalMessageID, &v.RunID,
		&v.ASRProvider, &v.ASRModel, &v.ASRSeconds, &v.ASRErrorCode)
	return v, err
}
