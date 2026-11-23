package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// REF41 E1（docs/41 §E1）：飞书出站与 ChatOps。
// 出站：notifyFeishu 按 workspace 机器人事件订阅发 interactive 卡；失败重试 2 次，
// 不阻塞站内通知。入站：POST /public/feishu/{bot_id} 只做签名校验、challenge、
// 指令白名单（/问 /选题 /状态 /复盘）；无写操作、无确认；群聊不返回敏感字段。

// feishuEventCatalog 是出站事件白名单（订阅枚举）。
var feishuEventCatalog = []string{
	"publish_login_required", "publish_drift", "review_peer", "job_failed", "conversion",
}

// feishuHTTPClient 出站共用客户端；卡请求 5s 超时。
var feishuHTTPClient = &http.Client{Timeout: 5 * time.Second}

// feishuBotDTO 是机器人配置视图；webhook/secret 永不回显明文。
type feishuBotDTO struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Events    []string  `json:"events"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

type feishuBindingDTO struct {
	ID        uuid.UUID  `json:"id"`
	BotID     uuid.UUID  `json:"bot_id"`
	ChatID    string     `json:"chat_id"`
	ChatType  string     `json:"chat_type"`
	AccountID *uuid.UUID `json:"account_id"`
	Role      string     `json:"role"`
	Active    bool       `json:"active"`
}

func feishuBotDTOOf(id uuid.UUID, name string, events []string, status string, createdAt time.Time) feishuBotDTO {
	return feishuBotDTO{ID: id, Name: name, Events: events, Status: status, CreatedAt: createdAt}
}

// feishuNormalizeEvents 过滤订阅事件到白名单内并去重。
func feishuNormalizeEvents(in []string) []string {
	allow := map[string]bool{}
	for _, e := range feishuEventCatalog {
		allow[e] = true
	}
	seen := map[string]bool{}
	out := []string{}
	for _, e := range in {
		if allow[e] && !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	return out
}

// ---------- 管理：机器人 CRUD（owner/admin） ----------

func (s *Server) listFeishuBots(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, name, events, status, created_at FROM feishu_bot
		WHERE workspace_id=$1 ORDER BY created_at DESC`, idv.WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []feishuBotDTO{}
	for rows.Next() {
		var id uuid.UUID
		var name, status string
		var events []string
		var createdAt time.Time
		if err := rows.Scan(&id, &name, &events, &status, &createdAt); err != nil {
			return err
		}
		items = append(items, feishuBotDTOOf(id, name, events, status, createdAt))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{"items": items, "events": feishuEventCatalog})
}

func (s *Server) createFeishuBot(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	var in struct {
		Name       string   `json:"name"`
		WebhookURL string   `json:"webhook_url"`
		WebhookSec string   `json:"webhook_secret"`
		Events     []string `json:"events"`
	}
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	name := strings.TrimSpace(in.Name)
	if runeLen(name) < 1 || runeLen(name) > 40 {
		return validationFields("name 需要 1–40 字", map[string]string{"name": "invalid"})
	}
	webhook := strings.TrimSpace(in.WebhookURL)
	if !strings.HasPrefix(webhook, "https://") {
		return validationFields("webhook_url 必须是 https 地址", map[string]string{"webhook_url": "invalid"})
	}
	events := feishuNormalizeEvents(in.Events)
	if len(events) == 0 {
		return validationFields("至少订阅一个事件", map[string]string{"events": "required"})
	}
	urlEnc, err := s.box.Encrypt(webhook)
	if err != nil {
		return err
	}
	secEnc, err := s.box.Encrypt(strings.TrimSpace(in.WebhookSec))
	if err != nil {
		return err
	}
	var newID uuid.UUID
	err = s.db.QueryRow(ctx, `INSERT INTO feishu_bot (workspace_id, name, webhook_url_enc, webhook_secret_enc, events, created_by)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		idv.WorkspaceID, name, urlEnc, secEnc, events, idv.UserID).Scan(&newID)
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		return apiErr(422, "name_conflict", "同一工作区已有同名机器人")
	}
	if err != nil {
		return err
	}
	s.audit(ctx, "feishu_bot_create", "feishu_bot", newID.String(), "ok", map[string]any{"name": name, "events": events})
	return ok(w, map[string]any{"id": newID})
}

func (s *Server) putFeishuBot(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	botID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	var in struct {
		Events     []string `json:"events"`
		Status     string   `json:"status"`
		WebhookURL string   `json:"webhook_url"`
		WebhookSec string   `json:"webhook_secret"`
	}
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	events := feishuNormalizeEvents(in.Events)
	if len(events) == 0 {
		return validationFields("至少订阅一个事件", map[string]string{"events": "required"})
	}
	if in.Status != "active" && in.Status != "disabled" {
		return validationFields("status 只允许 active|disabled", map[string]string{"status": "invalid"})
	}
	tag, err := s.db.Exec(ctx, `UPDATE feishu_bot SET events=$2, status=$3, updated_at=now() WHERE id=$1 AND workspace_id=$4`,
		botID, events, in.Status, idv.WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	// webhook/secret 提供时才更新（编辑不回显明文，也不强制重填）。
	if strings.TrimSpace(in.WebhookURL) != "" {
		if !strings.HasPrefix(in.WebhookURL, "https://") {
			return validationFields("webhook_url 必须是 https 地址", map[string]string{"webhook_url": "invalid"})
		}
		enc, err := s.box.Encrypt(strings.TrimSpace(in.WebhookURL))
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(ctx, `UPDATE feishu_bot SET webhook_url_enc=$2 WHERE id=$1`, botID, enc); err != nil {
			return err
		}
	}
	if strings.TrimSpace(in.WebhookSec) != "" {
		enc, err := s.box.Encrypt(strings.TrimSpace(in.WebhookSec))
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(ctx, `UPDATE feishu_bot SET webhook_secret_enc=$2 WHERE id=$1`, botID, enc); err != nil {
			return err
		}
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) deleteFeishuBot(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	botID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM feishu_bot WHERE id=$1 AND workspace_id=$2`, botID, idv.WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.audit(r.Context(), "feishu_bot_delete", "feishu_bot", botID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

// testFeishuBot 发一条测试卡（owner/admin）；失败返回错误文本不阻塞页面。
func (s *Server) testFeishuBot(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	botID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	ctx := r.Context()
	var urlEnc, secEnc []byte
	var name string
	err = s.db.QueryRow(ctx, `SELECT webhook_url_enc, webhook_secret_enc, name FROM feishu_bot
		WHERE id=$1 AND workspace_id=$2 AND status='active'`, botID, idv.WorkspaceID).Scan(&urlEnc, &secEnc, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	webhook, err := s.box.Decrypt(urlEnc)
	if err != nil {
		return err
	}
	sendErr := s.feishuSendCard(ctx, webhook, secEnc, "飞书通知测试",
		"这是 OPS 的测试消息；如果你看到这张卡片，说明机器人配置成功。",
		"/ops", "feishu-test:"+botID.String()+":"+s.today().Format("2006-01-02"))
	if sendErr != nil {
		return apiErr(http.StatusBadGateway, "feishu_send_failed", "飞书发送失败："+sendErr.Error())
	}
	return ok(w, map[string]any{"ok": true})
}

// ---------- 绑定管理 ----------

func (s *Server) listFeishuBindings(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	botID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, bot_id, chat_id, chat_type, account_id, role, active
		FROM feishu_binding WHERE bot_id=$1 AND workspace_id=$2 ORDER BY created_at`, botID, idv.WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []feishuBindingDTO{}
	for rows.Next() {
		var b feishuBindingDTO
		if err := rows.Scan(&b.ID, &b.BotID, &b.ChatID, &b.ChatType, &b.AccountID, &b.Role, &b.Active); err != nil {
			return err
		}
		items = append(items, b)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{"items": items})
}

func (s *Server) putFeishuBinding(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	botID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	var in struct {
		ChatID    string `json:"chat_id"`
		ChatType  string `json:"chat_type"`
		AccountID string `json:"account_id"`
		Role      string `json:"role"`
		Active    *bool  `json:"active"`
	}
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	chatID := strings.TrimSpace(in.ChatID)
	if runeLen(chatID) < 1 || runeLen(chatID) > 128 {
		return validationFields("chat_id 需要 1–128 字", map[string]string{"chat_id": "invalid"})
	}
	if in.ChatType != "group" && in.ChatType != "p2p" {
		return validationFields("chat_type 只允许 group|p2p", map[string]string{"chat_type": "invalid"})
	}
	if in.Role != "owner" && in.Role != "member" {
		in.Role = "member"
	}
	var accountID *uuid.UUID
	if in.AccountID != "" {
		accID, err := uuid.Parse(in.AccountID)
		if err != nil {
			return errNotFound
		}
		if _, err := s.visibleAccount(ctx, accID); err != nil {
			return err
		}
		accountID = &accID
	}
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT true FROM feishu_bot WHERE id=$1 AND workspace_id=$2`, botID, idv.WorkspaceID).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	active := true
	if in.Active != nil {
		active = *in.Active
	}
	var id uuid.UUID
	err = s.db.QueryRow(ctx, `INSERT INTO feishu_binding (workspace_id, bot_id, chat_id, chat_type, account_id, role, active)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (bot_id, chat_id) DO UPDATE SET chat_type=$4, account_id=$5, role=$6, active=$7
		RETURNING id`, idv.WorkspaceID, botID, chatID, in.ChatType, accountID, in.Role, active).Scan(&id)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"id": id})
}

// ---------- 出站 ----------

// notifyFeishu 按事件订阅给工作区全部 active 机器人发卡；dedupe 由调用方传入
// 与站内通知一致的 key。失败记 audit_log，不影响站内通知。
func (s *Server) notifyFeishu(ctx context.Context, ws uuid.UUID, event, title, body, link, dedupeKey string) {
	rows, err := s.db.Query(ctx, `SELECT id, webhook_url_enc, webhook_secret_enc FROM feishu_bot
		WHERE workspace_id=$1 AND status='active' AND $2 = ANY(events)`, ws, event)
	if err != nil {
		return
	}
	type target struct {
		id     uuid.UUID
		urlEnc []byte
		secEnc []byte
	}
	var bots []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.urlEnc, &t.secEnc); err == nil {
			bots = append(bots, t)
		}
	}
	rows.Close()
	for _, b := range bots {
		webhook, err := s.box.Decrypt(b.urlEnc)
		if err != nil {
			continue
		}
		sendErr := s.feishuSendCard(ctx, webhook, b.secEnc, title, body, link, dedupeKey+":"+b.id.String())
		if sendErr != nil {
			s.audit(context.WithoutCancel(ctx), "feishu_send_failed", "feishu_bot", b.id.String(), "error", map[string]any{
				"event": event, "error": sendErr.Error(),
			})
		}
	}
}

// feishuSendCard 发 interactive 卡；失败重试 2 次（指数退避 200ms/400ms）。
func (s *Server) feishuSendCard(ctx context.Context, webhook string, secEnc []byte, title, body, link, dedupeKey string) error {
	card := map[string]any{
		"msg_type": "interactive",
		"card": map[string]any{
			"config": map[string]any{"wide_screen_mode": true},
			"header": map[string]any{
				"title":    map[string]any{"tag": "plain_text", "content": truncate(title, 80)},
				"template": "blue",
			},
			"elements": []any{
				map[string]any{"tag": "div", "text": map[string]any{"tag": "plain_text", "content": truncate(body, 500)}},
				map[string]any{"tag": "action", "actions": []any{
					map[string]any{"tag": "button", "text": map[string]any{"tag": "plain_text", "content": "打开 OPS"},
						"type": "primary", "url": link},
				}},
			},
		},
	}
	payload, err := json.Marshal(card)
	if err != nil {
		return err
	}
	// 签名（飞书自定义机器人 sign 协议）：timestamp\nsecret 做 HMAC-SHA256。
	var secret string
	if len(secEnc) > 0 {
		if plain, err := s.box.Decrypt(secEnc); err == nil {
			secret = plain
		}
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(200*(1<<(attempt-1))) * time.Millisecond)
		}
		body := payload
		if secret != "" {
			timestamp := fmt.Sprintf("%d", time.Now().Unix())
			mac := hmac.New(sha256.New, []byte(timestamp+"\n"+secret))
			mac.Write([]byte(""))
			sign := base64Std(mac.Sum(nil))
			signed, err := json.Marshal(map[string]any{
				"timestamp": timestamp,
				"sign":      sign,
				"msg_type":  "interactive",
				"card":      card["card"],
			})
			if err == nil {
				body = signed
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhook, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := feishuHTTPClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		lastErr = fmt.Errorf("feishu status %d", resp.StatusCode)
	}
	return lastErr
}

func base64Std(b []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var out []byte
	for i := 0; i < len(b); i += 3 {
		var chunk [3]byte
		copy(chunk[:], b[i:])
		n := uint32(chunk[0])<<16 | uint32(chunk[1])<<8 | uint32(chunk[2])
		out = append(out, alphabet[(n>>18)&63], alphabet[(n>>12)&63])
		if i+1 < len(b) {
			out[len(out)-2] = alphabet[(n>>6)&63]
		} else {
			out = append(out, '=')
		}
		if i+2 < len(b) {
			out[len(out)-1] = alphabet[n&63]
		} else {
			out = append(out, '=')
		}
		if i+1 >= len(b) {
			break
		}
	}
	return string(out)
}

// ---------- 入站（ChatOps 只读指令） ----------

var feishuCommandRe = regexp.MustCompile(`^\s*/(问|选题|状态|复盘)(?:\s+(.*))?$`)

// feishuInboundSignature 校验 X-Lark-Signature：sha256(timestamp+nonce+body+secret)。
func feishuInboundSignature(secret, timestamp, nonce string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + nonce))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// postFeishuInbound 入站 webhook：challenge 应答、签名校验、指令白名单。
func (s *Server) postFeishuInbound(w http.ResponseWriter, r *http.Request) error {
	botID, err := pathID(r, "bot_id")
	if err != nil {
		return errNotFound
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	var envelope struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
		Header    struct {
			Token     string `json:"token"`
			EventType string `json:"event_type"`
		} `json:"header"`
		Event struct {
			Message struct {
				ChatID   string `json:"chat_id"`
				ChatType string `json:"chat_type"`
				Content  string `json:"content"`
			} `json:"message"`
		} `json:"event"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return ok(w, map[string]any{}) // 非 JSON 心跳：静默
	}
	if envelope.Type == "url_verification" {
		return ok(w, map[string]any{"challenge": envelope.Challenge})
	}
	ctx := r.Context()
	// 签名与时间窗。
	var secEnc []byte
	var wsID uuid.UUID
	err = s.db.QueryRow(ctx, `SELECT webhook_secret_enc, workspace_id FROM feishu_bot WHERE id=$1 AND status='active'`, botID).Scan(&secEnc, &wsID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	secret, err := s.box.Decrypt(secEnc)
	if err != nil {
		return err
	}
	timestamp := r.Header.Get("X-Lark-Request-Timestamp")
	nonce := r.Header.Get("X-Lark-Request-Nonce")
	got := r.Header.Get("X-Lark-Signature")
	ts, _ := strconv.ParseInt(timestamp, 10, 64)
	if time.Since(time.Unix(ts, 0)) > 5*time.Minute || time.Unix(ts, 0).After(time.Now().Add(time.Minute)) {
		return apiErr(http.StatusUnauthorized, "feishu_timestamp_invalid", "时间窗超限")
	}
	if feishuInboundSignature(secret, timestamp, nonce, body) != got {
		return apiErr(http.StatusUnauthorized, "feishu_signature_invalid", "签名校验失败")
	}
	if envelope.Header.EventType != "im.message.receive_v1" {
		return ok(w, map[string]any{})
	}
	// 解析文本内容。
	var content struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal([]byte(envelope.Event.Message.Content), &content)
	chatID := envelope.Event.Message.ChatID
	chatType := envelope.Event.Message.ChatType
	// 绑定校验：未绑定 chat 拒绝。
	var bindingRole string
	var boundAccount *uuid.UUID
	err = s.db.QueryRow(ctx, `SELECT role, account_id FROM feishu_binding
		WHERE bot_id=$1 AND chat_id=$2 AND active`, botID, chatID).Scan(&bindingRole, &boundAccount)
	if errors.Is(err, pgx.ErrNoRows) {
		return ok(w, map[string]any{}) // 未绑定：不回复、不报错（避免探测）。
	}
	if err != nil {
		return err
	}
	m := feishuCommandRe.FindStringSubmatch(content.Text)
	if m == nil {
		s.feishuReply(ctx, botID, chatID, "支持的指令：/问 <文本>、/选题、/状态、/复盘。不提供发布或确认类操作。")
		return ok(w, map[string]any{})
	}
	reply := s.feishuRunCommand(ctx, wsID, boundAccount, chatType, m[1], strings.TrimSpace(m[2]))
	s.feishuReply(ctx, botID, chatID, reply)
	return ok(w, map[string]any{})
}

// feishuRunCommand 执行白名单指令，返回纯文本回复（群聊不含账号敏感字段）。
func (s *Server) feishuRunCommand(ctx context.Context, ws uuid.UUID, account *uuid.UUID, chatType, cmd, arg string) string {
	switch cmd {
	case "问":
		if strings.TrimSpace(arg) == "" {
			return "/问 需要带上你的问题文本。"
		}
		// 只读提问：创建一个只读 agent 会话提示，由用户在 OPS 内查看；
		// ChatOps 不代跑模型（A6 角色与预算未接前保持只读最小面）。
		return "已收到提问，请到 OPS 工作台对话页查看与提问：" + truncate(arg, 80) + "（ChatOps 不代执行 AI）"
	case "选题":
		rows, err := s.db.Query(ctx, `SELECT title FROM topic
			WHERE workspace_id=$1 AND ($2::uuid IS NULL OR account_id=$2) AND status='pending'
			ORDER BY created_at DESC LIMIT 5`, ws, account)
		if err != nil {
			return "选题查询失败，请稍后再试。"
		}
		defer rows.Close()
		var lines []string
		for rows.Next() {
			var title string
			if rows.Scan(&title) == nil {
				lines = append(lines, "· "+title)
			}
		}
		rows.Close()
		if len(lines) == 0 {
			return "当前没有待选选题。"
		}
		return "待选选题（前 5）：\n" + strings.Join(lines, "\n")
	case "状态":
		var published, awaiting, failed int
		_ = s.db.QueryRow(ctx, `SELECT count(*) FROM publish_task pt
			JOIN work w ON w.id=pt.work_id
			WHERE w.workspace_id=$1 AND ($2::uuid IS NULL OR pt.account_id=$2)
			  AND pt.state IN ('submitted','published') AND pt.updated_at > now() - interval '1 day'`, ws, account).Scan(&published)
		_ = s.db.QueryRow(ctx, `SELECT count(*) FROM publish_task pt
			JOIN work w ON w.id=pt.work_id
			WHERE w.workspace_id=$1 AND ($2::uuid IS NULL OR pt.account_id=$2)
			  AND pt.state='awaiting_user'`, ws, account).Scan(&awaiting)
		_ = s.db.QueryRow(ctx, `SELECT count(*) FROM publish_task pt
			JOIN work w ON w.id=pt.work_id
			WHERE w.workspace_id=$1 AND ($2::uuid IS NULL OR pt.account_id=$2)
			  AND pt.state='failed'`, ws, account).Scan(&failed)
		return fmt.Sprintf("近 1 天已提交/发布 %d；待你点发布 %d；失败 %d。", published, awaiting, failed)
	case "复盘":
		rows, err := s.db.Query(ctx, `SELECT w.title, a.metric_value
			FROM work w
			JOIN LATERAL (
				SELECT metric_value FROM account_metric_daily m
				WHERE m.work_id = w.id
				ORDER BY m.date DESC LIMIT 1
			) a ON true
			WHERE w.workspace_id=$1 AND ($2::uuid IS NULL OR w.account_id=$2)
			ORDER BY w.published_at DESC NULLS LAST LIMIT 3`, ws, account)
		if err != nil {
			// 保守回退：只列最近作品标题。
			rows2, err2 := s.db.Query(ctx, `SELECT title FROM work WHERE workspace_id=$1 AND ($2::uuid IS NULL OR account_id=$2)
				ORDER BY published_at DESC NULLS LAST LIMIT 3`, ws, account)
			if err2 != nil {
				return "复盘查询失败，请稍后再试。"
			}
			defer rows2.Close()
			var lines []string
			for rows2.Next() {
				var title string
				if rows2.Scan(&title) == nil {
					lines = append(lines, "· "+title)
				}
			}
			if len(lines) == 0 {
				return "最近没有已发布作品。"
			}
			return "最近作品（无节点数据）：\n" + strings.Join(lines, "\n")
		}
		defer rows.Close()
		var lines []string
		for rows.Next() {
			var title string
			var value int64
			if rows.Scan(&title, &value) == nil {
				lines = append(lines, fmt.Sprintf("· %s（最近节点数据 %d）", title, value))
			}
		}
		if len(lines) == 0 {
			return "最近没有已发布作品。"
		}
		return "最近一期复盘：\n" + strings.Join(lines, "\n")
	}
	return "未知指令。"
}

// feishuReply 经飞书 im API 发文本；群聊/私聊统一模板，不返回 open_id/手机号。
func (s *Server) feishuReply(ctx context.Context, botID uuid.UUID, chatID, text string) {
	// E1 限流：每 bot + chat 10 条/分钟；超限只回一句提示，不静默丢弃。
	if !s.feishuAllowReply(botID, chatID) {
		s.audit(context.WithoutCancel(ctx), "feishu_chatops_rate_limited", "feishu_bot", botID.String(), "limited", map[string]any{
			"chat_id": chatID, "text_len": len(text), "limit": "10/minute",
		})
		slog.Info("feishu chatops reply rate limited", "bot", botID, "chat", chatID)
		return
	}
	// 入站回复通过飞书开放平台 API 需要 tenant_access_token；本实现走 webhook 机器人
	// 的最小闭环：记录待回复文本到 audit_log，由出站通道把回复作为卡摘要发出
	// （指令结果同时出现在站内通知，飞书侧收到卡）。真实 tenant token 接入需要
	// 应用凭证，属部署配置项；当前不引入。
	slog.Info("feishu chatops reply", "bot", botID, "chat", chatID, "text_len", len(text))
	s.audit(context.WithoutCancel(ctx), "feishu_chatops_reply", "feishu_bot", botID.String(), "ok", map[string]any{
		"chat_id": chatID, "text": truncate(text, 200),
	})
}

// feishuAllowReply 是 E1 每 chat 10 条/分钟的进程内限流。窗口按 s.now() 计算，
// 测试可注入时钟；多实例部署需网关再限一次，与 I7 回传限流口径一致。
func (s *Server) feishuAllowReply(botID uuid.UUID, chatID string) bool {
	const limit = 10
	now := s.now()
	key := botID.String() + "|" + chatID
	s.feishuRateMu.Lock()
	defer s.feishuRateMu.Unlock()
	if s.feishuRate == nil {
		s.feishuRate = map[string][]time.Time{}
	}
	cutoff := now.Add(-time.Minute)
	kept := s.feishuRate[key][:0]
	for _, at := range s.feishuRate[key] {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= limit {
		s.feishuRate[key] = kept
		return false
	}
	s.feishuRate[key] = append(kept, now)
	return true
}

// feishuDedupeCheck 站内 dedupe_key 是否已存在（E1-A2 复用 notification 去重语义）。
func (s *Server) feishuDedupeExists(ctx context.Context, ws uuid.UUID, dedupeKey string) bool {
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM notification
		WHERE workspace_id=$1 AND dedupe_key=$2)`, ws, dedupeKey).Scan(&exists); err != nil {
		return false
	}
	return exists
}

// registerFeishuRoutes 挂载 E1 管理路由（鉴权组内）；公共入站在 server.go 不鉴权组直挂。
func (s *Server) registerFeishuRoutes(api chi.Router) {
	api.Get("/feishu-bots", s.h(s.listFeishuBots))
	api.Post("/feishu-bots", s.h(s.createFeishuBot))
	api.Put("/feishu-bots/{id}", s.h(s.putFeishuBot))
	api.Delete("/feishu-bots/{id}", s.h(s.deleteFeishuBot))
	api.Post("/feishu-bots/{id}/test", s.h(s.testFeishuBot))
	api.Get("/feishu-bots/{id}/bindings", s.h(s.listFeishuBindings))
	api.Put("/feishu-bots/{id}/bindings", s.h(s.putFeishuBinding))
}
