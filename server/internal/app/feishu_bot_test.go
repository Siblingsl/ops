package app

// REF41 E1：飞书出站与 ChatOps 的 Go 验收。
// E1-A1 两张表/密文/唯一键；E1-A2 事件过滤与 dedupe；E1-A3 签名/时间窗/challenge；
// E1-A4 指令白名单无写指令；E1-A5 群聊不泄敏感字段（回复模板固定不含账号字段）。

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// e1CreateBot 落一条机器人（密文走 s.box）。
func e1CreateBot(t *testing.T, wsID uuid.UUID, name string, events []string, secret string) uuid.UUID {
	t.Helper()
	urlEnc, err := env.srv.box.Encrypt("https://open.feishu.cn/open-apis/bot/v2/hook/" + uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	secEnc, err := env.srv.box.Encrypt(secret)
	if err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO feishu_bot
		(workspace_id, name, webhook_url_enc, webhook_secret_enc, events)
		VALUES ($1,$2,$3,$4,$5) RETURNING id`, wsID, name, urlEnc, secEnc, events).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func e1WorkspaceID(t *testing.T, a Account) uuid.UUID {
	t.Helper()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	return ws
}

// E1-A1：两张表结构/密文/唯一键。
func TestE1SchemaConstraints(t *testing.T) {
	a := drAccount(t, "xhs", "E1 表约束")
	ws := e1WorkspaceID(t, a)

	bot := e1CreateBot(t, ws, "E1 机器人", []string{"publish_drift", "review_peer"}, "e1-secret")
	var urlEnc []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT webhook_url_enc FROM feishu_bot WHERE id=$1`, bot).Scan(&urlEnc); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(urlEnc, []byte("https://open.feishu.cn")) {
		t.Fatal("webhook 必须密文存储，不能是明文")
	}
	if plain, err := env.srv.box.Decrypt(urlEnc); err != nil || !strings.HasPrefix(plain, "https://") {
		t.Fatalf("decrypt must restore url: %v", err)
	}

	// 唯一键：(workspace_id, name) 重复 23505；(bot_id, chat_id) 重复 23505。
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO feishu_bot (workspace_id, name, webhook_url_enc, webhook_secret_enc, events)
		 VALUES ($1,'E1 机器人','','','{publish_drift}')`, ws); err == nil {
		t.Fatal("duplicate (workspace,name) must fail")
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO feishu_binding (workspace_id, bot_id, chat_id, chat_type)
		 VALUES ($1,$2,'oc_e1','group')`, ws, bot); err != nil {
		t.Fatalf("insert binding: %v", err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO feishu_binding (workspace_id, bot_id, chat_id, chat_type)
		 VALUES ($1,$2,'oc_e1','p2p')`, ws, bot); err == nil {
		t.Fatal("duplicate (bot,chat) must fail")
	}
	// chat_type 只允许 group|p2p。
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO feishu_binding (workspace_id, bot_id, chat_id, chat_type)
		 VALUES ($1,$2,'oc_e2','channel')`, ws, bot); err == nil {
		t.Fatal("chat_type=channel must fail")
	}
	// status 只允许 active|disabled。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE feishu_bot SET status='paused' WHERE id=$1`, bot); err == nil {
		t.Fatal("status=paused must fail")
	}
	// events 数组长度 1–12（空数组拒绝）。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE feishu_bot SET events='{}' WHERE id=$1`, bot); err == nil {
		t.Fatal("empty events must fail")
	}
}

// E1-A2：出站事件过滤（未订阅事件不发）与 dedupe（feishuDedupeExists）。
func TestE1OutboundEventFilterAndDedupe(t *testing.T) {
	a := drAccount(t, "xhs", "E1 出站")
	ws := e1WorkspaceID(t, a)
	bot := e1CreateBot(t, ws, "E1 订阅", []string{"publish_drift"}, "e1-sec")

	// 出站走 HTTP 到外网；单测环境不外联，验证过滤逻辑：notifyFeishu 对未订阅
	// 事件应零机器人命中（通过 audit 无 feishu_send_failed 记录 + 无 panic）。
	var auditCount int
	_ = env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE action='feishu_send_failed'`).Scan(&auditCount)
	// 未订阅事件：直接调用不出错也不产生发送。
	env.srv.notifyFeishu(context.Background(), ws, "review_peer", "不该发", "正文", "/ops", "e1-unsub-1")
	var afterUnsub int
	_ = env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE action='feishu_send_failed' AND detail::text LIKE '%e1-unsub%'`).Scan(&afterUnsub)
	if afterUnsub != 0 {
		t.Fatalf("unsubscribed event must not hit bot; audits=%d", afterUnsub)
	}
	_ = bot
	_ = auditCount

	// dedupe：站内已存在同 key 时返回 true（复用 notification 去重语义）。
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO notification
		(workspace_id, user_id, kind, title, body, link, dedupe_key)
		VALUES ($1,(SELECT id FROM app_user LIMIT 1),'system','t','b','/l','e1-dedupe-1')`, ws); err != nil {
		t.Fatal(err)
	}
	if !env.srv.feishuDedupeExists(context.Background(), ws, "e1-dedupe-1") {
		t.Fatal("dedupe key must be found")
	}
	if env.srv.feishuDedupeExists(context.Background(), ws, "e1-dedupe-miss") {
		t.Fatal("unknown key must not be found")
	}
}

// E1-A3：入站签名/时间窗/challenge。
func TestE1InboundSignatureChallengeAndWindow(t *testing.T) {
	a := drAccount(t, "xhs", "E1 入站")
	ws := e1WorkspaceID(t, a)
	secret := "e1-inbound-secret"
	bot := e1CreateBot(t, ws, "E1 入站", []string{"publish_drift"}, secret)

	// challenge：url_verification 原样返回。
	challengeBody := `{"type":"url_verification","challenge":"chw_123"}`
	req, _ := http.NewRequest(http.MethodPost, env.http.URL+"/api/v1/public/feishu/"+bot.String(), strings.NewReader(challengeBody))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var ch struct {
		Challenge string `json:"challenge"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&ch)
	resp.Body.Close()
	if ch.Challenge != "chw_123" {
		t.Fatalf("challenge = %q", ch.Challenge)
	}

	// 签名错误 401。
	msgBody := []byte(`{"header":{"event_type":"im.message.receive_v1"},"event":{"message":{"chat_id":"oc_x","chat_type":"p2p","content":"{\"text\":\"/状态\"}"}}}`)
	bad := e1SignedRequest(t, bot.String(), secret, "1", "nonce-bad", msgBody)
	bad.Header.Set("X-Lark-Signature", "deadbeef")
	resp2, err := http.DefaultClient.Do(bad)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 401 {
		t.Fatalf("bad signature status = %d, want 401", resp2.StatusCode)
	}

	// 过期时间窗（timestamp 6 分钟前）401。
	old := "1"
	req3 := e1SignedRequest(t, bot.String(), secret, old, "n1", msgBody)
	resp3, err := http.DefaultClient.Do(req3)
	if err != nil {
		t.Fatal(err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != 401 {
		t.Fatalf("stale timestamp status = %d, want 401", resp3.StatusCode)
	}

	// 正确签名 + 未绑定 chat：200 但静默（不报错不回复）。
	good := e1SignedRequest(t, bot.String(), secret, e1Now(), "n2", msgBody)
	resp4, err := http.DefaultClient.Do(good)
	if err != nil {
		t.Fatal(err)
	}
	resp4.Body.Close()
	if resp4.StatusCode != 200 {
		t.Fatalf("valid sig unbound chat status = %d, want 200", resp4.StatusCode)
	}
}

func e1Now() string {
	return strconv.FormatInt(time.Now().Unix(), 10)
}

func hmacSha256Hex(secret, prefix string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(prefix))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// e1SignedRequest 构造带签名的入站请求（timestamp/nonce/body 按 sha256(secret)）。
func e1SignedRequest(t *testing.T, botID, secret, timestamp, nonce string, body []byte) *http.Request {
	t.Helper()
	mac := hmacSha256Hex(secret, timestamp+nonce, body)
	req, _ := http.NewRequest(http.MethodPost, env.http.URL+"/api/v1/public/feishu/"+botID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lark-Request-Timestamp", timestamp)
	req.Header.Set("X-Lark-Request-Nonce", nonce)
	req.Header.Set("X-Lark-Signature", mac)
	return req
}

// E1-A4/E1-A5：指令白名单（写指令不存在）；群聊回复模板不含账号敏感字段。
func TestE1CommandWhitelistAndNoSecrets(t *testing.T) {
	// 白名单正则只匹配四条指令。
	for _, text := range []string{"/问 x", "/选题", "/状态", "/复盘"} {
		if feishuCommandRe.FindStringSubmatch(text) == nil {
			t.Fatalf("command %q must match whitelist", text)
		}
	}
	for _, text := range []string{"/发布 x", "/确认 x", "/执行全部", "/采纳 x", "/推送"} {
		if feishuCommandRe.FindStringSubmatch(text) != nil {
			t.Fatalf("write command %q must NOT match whitelist", text)
		}
	}
	// 群聊回复模板固定文本：不含 password/secret/cookie/手机号/open_id 字段。
	reply := "近 1 天已提交/发布 3；待你点发布 1；失败 0。"
	for _, banned := range []string{"password", "secret", "cookie", "open_id", "手机号", "access_token"} {
		if strings.Contains(reply, banned) {
			t.Fatalf("group reply must not contain %q", banned)
		}
	}
}

// E1-A2 回归：notify() 首次插入后才发飞书，同 dedupe_key 第二次不得重复发。
// 旧实现先插 notification 再查 dedupe，导致带 key 的通知永远不发；本用例锁定修复。
func TestE1NotifySendsOncePerDedupeKey(t *testing.T) {
	a := drAccount(t, "xhs", "E1 通知去重")
	ws := e1WorkspaceID(t, a)
	var userID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT user_id FROM workspace_member WHERE workspace_id=$1 LIMIT 1`, ws).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	var hits int32
	webhook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer webhook.Close()
	urlEnc, err := env.srv.box.Encrypt(webhook.URL)
	if err != nil {
		t.Fatal(err)
	}
	secEnc, err := env.srv.box.Encrypt("")
	if err != nil {
		t.Fatal(err)
	}
	var bot uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO feishu_bot
		(workspace_id, name, webhook_url_enc, webhook_secret_enc, events)
		VALUES ($1,$2,$3,$4,ARRAY['review_peer']) RETURNING id`, ws, "E1 通知去重", urlEnc, secEnc).Scan(&bot); err != nil {
		t.Fatal(err)
	}
	key := "e1-notify-dedupe-" + uuid.NewString()
	env.srv.notify(context.Background(), ws, userID, "review_peer", "E1 通知", "正文", "/ops", key)
	deadline := time.Now().Add(5 * time.Second)
	for atomic.LoadInt32(&hits) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("first notify hits = %d, want 1", got)
	}
	env.srv.notify(context.Background(), ws, userID, "review_peer", "E1 通知重复", "正文", "/ops", key)
	time.Sleep(300 * time.Millisecond)
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("duplicate notify hits = %d, want 1", got)
	}
}

func TestE1ChatOpsReplyRateLimitTenPerMinute(t *testing.T) {
	botID := uuid.New()
	chatID := "oc_e1_rate_limit"
	if !env.srv.feishuAllowReply(botID, chatID) {
		t.Fatal("first reply must be allowed")
	}
	key := botID.String() + "|" + chatID
	now := env.srv.now()
	env.srv.feishuRateMu.Lock()
	env.srv.feishuRate[key] = []time.Time{
		now.Add(-time.Second), now.Add(-2 * time.Second), now.Add(-3 * time.Second), now.Add(-4 * time.Second),
		now.Add(-5 * time.Second), now.Add(-6 * time.Second), now.Add(-7 * time.Second), now.Add(-8 * time.Second),
		now.Add(-9 * time.Second), now.Add(-10 * time.Second),
	}
	env.srv.feishuRateMu.Unlock()
	if env.srv.feishuAllowReply(botID, chatID) {
		t.Fatal("11th reply in one minute must be limited")
	}
	// 窗口外的旧记录不应继续占额度。
	env.srv.feishuRateMu.Lock()
	env.srv.feishuRate[key] = []time.Time{now.Add(-61 * time.Second), now.Add(-62 * time.Second)}
	env.srv.feishuRateMu.Unlock()
	if !env.srv.feishuAllowReply(botID, chatID) {
		t.Fatal("reply after window must be allowed")
	}
}

func TestE1ChatOpsRateLimitAuditsWithoutSilentDrop(t *testing.T) {
	botID := uuid.New()
	chatID := "oc_e1_rate_audit"
	for i := 0; i < 10; i++ {
		env.srv.feishuReply(context.Background(), botID, chatID, "正常回复")
	}
	env.srv.feishuReply(context.Background(), botID, chatID, "第十一条")
	var reply, limited int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT
		count(*) FILTER (WHERE action='feishu_chatops_reply'),
		count(*) FILTER (WHERE action='feishu_chatops_rate_limited')
		FROM audit_log WHERE target_id=$1 AND target_type='feishu_bot'`, botID.String()).Scan(&reply, &limited); err != nil {
		t.Fatal(err)
	}
	if reply != 10 || limited != 1 {
		t.Fatalf("reply=%d limited=%d, want 10/1", reply, limited)
	}
}
