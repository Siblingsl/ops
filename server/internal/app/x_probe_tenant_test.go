package app

// 跨租户越权（IDOR）探针：只读、只报告，不修改任何非测试源码。
//
// 做法：所有者账号用真实 HTTP API 造一批资源并记录 ID，然后用第二个工作区的访客账号
// 逐个按 ID 发起 GET / PATCH / PUT / DELETE / confirm 类 POST，观察返回码：
//   - 403 / 404：说明按工作区（或按用户）隔离，符合预期；
//   - 200 / 201 / 204：越权成功，断言失败（并在响应里找所有者埋的标记串作为证据）；
//   - 5xx：服务端错误，断言失败；
//   - 400 / 409 / 422 / 429：语义未定，只记录不判失败（多数是请求体形状不合，不是越权）。
//
// 运行：cd server; go test ./internal/app -run TestXProbeCrossTenant -count=1 -v

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

const (
	xpIsolated = "已隔离(403/404)"
	xpLeak     = "越权成功(2xx)"
	xpServer   = "服务端错误(5xx)"
	xpAmbig    = "语义未定(4xx)"
	xpPublic   = "公开设计(不判)"
	xpNoData   = "空响应(未泄露)"
	xpNoop     = "无副作用(未泄露)"
)

// xProbe 是一次以访客身份发出的越权尝试。
type xProbe struct {
	label  string
	method string
	path   string
	body   any
	marker string // 所有者的独特标记串；出现在响应里即为数据泄露的铁证
	phase  int    // 1 读/无害写；2 破坏性；3 终局（删除作品/账号、切换工作区）
	public bool   // 公开接口（例如预览链接），2xx 不算越权
	softOK bool   // 接口对不存在的 ID 幂等返回 2xx；需另查数据是否真的变化
}

type xProbeResult struct {
	xProbe
	status int
	class  string
	snippet string
	note   string
}

func xpClassify(status int, body []byte, marker string, public bool) (string, string) {
	switch {
	case public:
		return xpPublic, ""
	case status >= 500:
		return xpServer, "处理器返回 5xx，可能是未处理的权限分支"
	case status >= 200 && status < 300:
		if marker != "" && strings.Contains(string(body), marker) {
			return xpLeak, "响应中出现所有者标记 " + strconv.Quote(marker)
		}
		if marker != "" {
			return xpLeak, "请求成功但未在响应体中发现所有者标记（仍可能是越权写入）"
		}
		return xpLeak, "另一个租户的请求得到成功响应"
	case status == 401, status == 403, status == 404:
		return xpIsolated, ""
	default:
		return xpAmbig, ""
	}
}

func xpEmptyBody(b []byte) bool {
	s := strings.TrimSpace(string(b))
	return s == "" || s == "[]" || s == "{}" || s == "null" || s == "{\"items\":[]}"
}

func xpSnippet(b []byte) string {
	s := strings.Join(strings.Fields(string(b)), " ")
	if len([]rune(s)) > 220 {
		s = string([]rune(s)[:220]) + "…"
	}
	return s
}

func xpDoRaw(t *testing.T, client *http.Client, csrf, method, path string, body []byte, headers map[string]string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, env.http.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request %s %s: %v", method, path, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	out := make([]byte, 0, 4096)
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		out = append(out, buf[:n]...)
		if err != nil {
			break
		}
	}
	return resp.StatusCode, out
}

// xpChallenge 以当前会话申请一次设备证明，返回挑战 ID 与待签名载荷。
func xpChallenge(t *testing.T, deviceID uuid.UUID, publicKey string, op, method, path string, body []byte) (uuid.UUID, []byte) {
	t.Helper()
	sum := sha256.Sum256(body)
	in := map[string]any{
		"device_id": deviceID, "operation": op, "method": method, "path": path,
		"body_sha256": hex.EncodeToString(sum[:]),
	}
	if publicKey != "" {
		in["public_key"] = publicKey
	}
	st, b := env.do("POST", "/api/v1/desktop/challenges", in)
	if st != 200 {
		t.Fatalf("desktop challenge %s %s: %d %s", op, path, st, b)
	}
	var out struct {
		ChallengeID uuid.UUID `json:"challenge_id"`
		Payload     string    `json:"signature_payload"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("desktop challenge decode: %v (%s)", err, b)
	}
	payload, err := base64.StdEncoding.DecodeString(out.Payload)
	if err != nil {
		t.Fatalf("desktop challenge payload: %v", err)
	}
	return out.ChallengeID, payload
}

// xpSigned 以当前会话、指定设备发起一次带 ed25519 证明的桌面请求。
func xpSigned(t *testing.T, deviceID uuid.UUID, priv ed25519.PrivateKey, op, method, path string, body []byte) (int, []byte) {
	t.Helper()
	challenge, payload := xpChallenge(t, deviceID, "", op, method, path, body)
	headers := map[string]string{
		"X-OPS-Desktop-Device":    deviceID.String(),
		"X-OPS-Desktop-Challenge": challenge.String(),
		"X-OPS-Desktop-Signature": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload)),
	}
	return xpDoRaw(t, env.client, env.csrf, method, path, body, headers)
}

func TestXProbeCrossTenant(t *testing.T) {
	// 手动探针：默认跳过，避免与常规套件抢同一台测试服务器。
	// 运行：$env:OPS_XPROBE='1'; go test ./internal/app -run TestXProbeCrossTenant -count=1 -v
	if os.Getenv("OPS_XPROBE") != "1" {
		t.Skip("set OPS_XPROBE=1 to run the cross-tenant probe")
	}
	u := strconv.FormatInt(time.Now().UnixNano(), 36)
	marker := "XP-" + u
	accPath := func(a Account) string { return "/api/v1/accounts/" + a.ID.String() }

	f := env.accounts(t)
	owner := f.wechat

	// ---------- 所有者：用真实 API 造富资源 ----------
	work := env.readyWork(t, owner, marker+" 的独到观点")
	workID := work.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+workID, map[string]any{"title": "XP 跨租户文章 " + marker}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+workID, nil, &work)
	if len(work.Sections) == 0 || len(work.Assets) == 0 {
		t.Fatalf("owner work lacks sections/assets: %+v", work)
	}
	secID := work.Sections[0].ID.String()
	secRev := work.Sections[0].Revision
	lastSecID := work.Sections[len(work.Sections)-1].ID.String()
	assetID := work.Assets[0].ID.String()

	var comment struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+workID+"/comments",
		map[string]any{"section_id": secID, "body": marker + " 的批注"}, &comment)

	var mat struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/materials",
		map[string]any{"account_id": owner.ID, "kind": "experience", "content": marker + " 的素材内容", "source": "亲身经历"}, &mat)

	var topic struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", accPath(owner)+"/topics",
		map[string]any{"title": marker + " 的选题", "angle": "独特角度", "source": "ai"}, &topic)

	// 角色设定卡只对「漫画」内容类型的账号开放，单独建一个漫画号。
	var comicAcc Account
	env.mustJSON(t, "POST", "/api/v1/accounts",
		map[string]string{"platform": "xhs", "name": "XP漫画号" + u, "content_format": "comic"}, &comicAcc)
	var char struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", accPath(comicAcc)+"/characters",
		map[string]any{"name": "小周" + u, "appearance": "短发圆眼镜", "personality": "谨慎"}, &char)

	var sample struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", accPath(owner)+"/style-samples",
		map[string]any{"title": marker + " 的风格", "content_md": marker + " 正文风格样本"}, &sample)

	var memory struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", accPath(owner)+"/memories",
		map[string]any{"kind": "structure", "text": marker + " 的记忆", "source": "breakdown"}, &memory)

	var series struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", accPath(owner)+"/series",
		map[string]any{"name": marker + " 的系列", "outline": "系列大纲"}, &series)

	var refRes struct {
		IDs []uuid.UUID `json:"ids"`
	}
	env.mustJSON(t, "POST", accPath(owner)+"/references",
		map[string]any{"links": []string{"https://mp.weixin.qq.com/s/xp-" + u}}, &refRes)
	refID := uuid.Nil
	if len(refRes.IDs) > 0 {
		refID = refRes.IDs[0]
	} else {
		t.Logf("跳过参考探针（没有创建参考条目）")
	}

	var inbox struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/inbox",
		map[string]any{"account_id": owner.ID, "content": marker + " 的灵感", "source": "quick"}, &inbox)

	var provider struct {
		ID uuid.UUID `json:"id"`
	}
	env.reauth(t)
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "XP 供应商 " + marker, "base_url": "http://127.0.0.1:8091/v1", "api_key": "xp-probe-key-" + u,
		"models": []string{"mock-chat"},
	}, &provider)

	// 敏感词：创建接口只回计数，按列表取回 ID。
	env.mustJSON(t, "POST", "/api/v1/sensitive-words", map[string]any{"words": []string{marker + "敏感词"}, "category": "custom"}, nil)
	var words []struct {
		ID   uuid.UUID `json:"id"`
		Word string    `json:"word"`
	}
	env.mustJSON(t, "GET", "/api/v1/sensitive-words", nil, &words)
	wordID := uuid.Nil
	for _, w := range words {
		if strings.Contains(w.Word, marker) {
			wordID = w.ID
		}
	}
	if wordID == uuid.Nil {
		t.Fatalf("owner sensitive word not found in list: %+v", words)
	}

	// 提示词评测用例（需要最近一次可编辑任务的调用快照，readyWork 已产生）。
	var evalCase struct {
		ID uuid.UUID `json:"id"`
	}
	evalSt, evalBody := env.do("POST", "/api/v1/prompt-eval/cases", map[string]any{"task_type": "outline", "name": marker + " 评测"})
	if evalSt == 200 {
		_ = json.Unmarshal(evalBody, &evalCase)
	} else {
		t.Logf("跳过 prompt-eval 用例探针（创建失败 %d %s）", evalSt, xpSnippet(evalBody))
	}

	// 自定义大纲模板 + 自定义提示词：用于跨租户“写串”检查。
	env.mustJSON(t, "PUT", "/api/v1/outline-templates", map[string]any{"items": []map[string]any{
		{"name": "XP模板" + u, "structure": marker + " 的结构"},
	}}, nil)
	var promptList []struct {
		TaskType string `json:"task_type"`
		Content  string `json:"content"`
	}
	env.mustJSON(t, "GET", "/api/v1/prompt-templates", nil, &promptList)
	promptTask := ""
	for _, p := range promptList {
		if p.TaskType != "" {
			promptTask = p.TaskType
			break
		}
	}
	if promptTask == "" {
		t.Fatalf("no editable prompt template")
	}
	env.mustJSON(t, "PUT", "/api/v1/prompt-templates/"+promptTask,
		map[string]any{"content": marker + " 的任务指令"}, nil)

	// 通知：邀请码 → 第三个账号加入 → 所有者收到 member_joined 通知。
	var invite struct {
		ID   uuid.UUID `json:"id"`
		Code string    `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites",
		map[string]any{"role": "editor", "max_uses": 1, "days": 1}, &invite)
	var workspaces []struct {
		ID   uuid.UUID `json:"id"`
		Name string    `json:"name"`
	}
	env.mustJSON(t, "GET", "/api/v1/workspaces", nil, &workspaces)
	ownerWS := uuid.Nil
	for _, w := range workspaces {
		if ownerWS == uuid.Nil {
			ownerWS = w.ID
		}
	}
	var members []struct {
		UserID   uuid.UUID `json:"user_id"`
		Username string    `json:"username"`
		Role     string    `json:"role"`
	}
	env.mustJSON(t, "GET", "/api/v1/workspaces/current/members", nil, &members)
	ownerUser := uuid.Nil
	for _, m := range members {
		if m.Role == "owner" {
			ownerUser = m.UserID
		}
	}

	// 访客：独立工作区、独立用户。
	guest := env.registerClient(t, "probe-guest-"+u, "guest-password-123")
	guest.restore(env)

	joiner := env.registerClient(t, "probe-joiner-"+u, "probe-joiner-password")
	jst, jbody := joiner.do("POST", "/api/v1/workspaces/join", map[string]any{"code": invite.Code})
	if jst != 200 {
		t.Fatalf("joiner join: %d %s", jst, jbody)
	}
	joiner.restore(env)

	var notifs struct {
		Items []struct {
			ID    uuid.UUID `json:"id"`
			Title string    `json:"title"`
		} `json:"items"`
	}
	notifID := uuid.Nil
	for i := 0; i < 40 && notifID == uuid.Nil; i++ {
		env.mustJSON(t, "GET", "/api/v1/notifications", nil, &notifs)
		if len(notifs.Items) > 0 {
			notifID = notifs.Items[0].ID
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if notifID == uuid.Nil {
		t.Logf("跳过通知探针（所有者没有收到通知）")
	}

	// AI 任务：记忆提炼是异步任务，立即拿到 job_id。
	var distill struct {
		JobID uuid.UUID `json:"job_id"`
	}
	env.mustJSON(t, "POST", accPath(owner)+"/memories/distill", nil, &distill)

	// AI 调用：用于反馈接口越权探针。
	var calls []struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "GET", "/api/v1/quality/calls", nil, &calls)
	aiCallID := uuid.Nil
	if len(calls) > 0 {
		aiCallID = calls[0].ID
	}

	// 计划槽位：需要启用方案后才有槽位。
	env.mustJSON(t, "POST", accPath(owner)+"/strategy", map[string]any{
		"niche": "职场效率", "audience": "年轻上班族", "differentiation": marker + " 的差异",
		"persona": "理性作者", "stage": "cold_start",
		"pillars": []map[string]any{
			{"name": "效率工具", "ratio": 40, "desc": "工具测评"},
			{"name": "职场沟通", "ratio": 35, "desc": "沟通模板"},
			{"name": "成长复盘", "ratio": 25, "desc": "复盘方法"},
		},
		"cadence": map[string]any{"per_week": 3},
	}, nil)
	var plan struct {
		Slots []PlanSlot `json:"slots"`
	}
	env.mustJSON(t, "GET", accPath(owner)+"/plan", nil, &plan)
	slotID := uuid.Nil
	if len(plan.Slots) > 0 {
		slotID = plan.Slots[0].ID
	} else {
		t.Logf("跳过 plan-slots 探针（没有生成槽位）")
	}

	// 检查项：发起一次检查后取审批项 ID。
	env.mustJSON(t, "POST", "/api/v1/works/"+workID+"/checks", map[string]any{"html_chars": 3000, "html_bytes": 9000}, nil)
	var latest struct {
		Run *CheckRun `json:"run"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+workID+"/checks/latest", nil, &latest)
	checkItem := uuid.Nil
	fixItem := uuid.Nil // fixSuggest 只对 sensitive/ad_law/fact 类检查项开放
	checkRes := "fact_checked"
	if latest.Run != nil && len(latest.Run.Items) > 0 {
		it := latest.Run.Items[0]
		checkItem = it.ID
		if v, okv := allowedResolutions[it.Category]; okv && len(v) > 0 {
			checkRes = v[0]
		}
		for _, cand := range latest.Run.Items {
			if cand.Category == "sensitive" || cand.Category == "ad_law" || cand.Category == "fact" {
				fixItem = cand.ID
				break
			}
		}
	}
	if fixItem == uuid.Nil {
		fixItem = checkItem
	}

	// 指标：需要作品处于已发布态；先用 SQL 把真实作品推进到 published（仅测试数据准备），再用 API 录入。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET status='published', published_at=now() WHERE id=$1`, work.ID); err != nil {
		t.Fatalf("mark published: %v", err)
	}
	var metric struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+workID+"/metrics", map[string]any{"reads": 1200, "likes": 30}, &metric)

	// 段落历史版本：草稿已产生修订。
	var revisions []struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "GET", "/api/v1/sections/"+secID+"/revisions", nil, &revisions)
	revisionID := uuid.New()
	if len(revisions) > 0 {
		revisionID = revisions[0].ID
	}

	// 预览链接（公众号作品）。
	var preview struct {
		Token string `json:"token"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+workID+"/preview-link", nil, &preview)

	// 回收站：单独一个素材，删除后进入回收站。
	var trashMat struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/materials",
		map[string]any{"account_id": owner.ID, "kind": "experience", "content": marker + " 待回收素材", "source": "亲身经历"}, &trashMat)
	env.mustJSON(t, "DELETE", "/api/v1/materials/"+trashMat.ID.String(), nil, nil)

	// 代理对话。
	var conv struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/conversations",
		map[string]any{"title": marker + " 的对话", "account_id": owner.ID.String()}, &conv)

	// ---------- 访客视角的探针表 ----------
	probes := []xProbe{
		// 账号
		{label: "账号详情", method: "GET", path: accPath(owner), marker: marker, phase: 1},
		{label: "账号改名", method: "PATCH", path: accPath(owner), body: map[string]any{"name": "XP-hijack-" + u}, phase: 1},
		{label: "账号板块", method: "GET", path: accPath(owner) + "/board", marker: marker, phase: 1},
		{label: "账号简报", method: "GET", path: accPath(owner) + "/brief", marker: marker, phase: 1},
		{label: "账号健康分", method: "GET", path: accPath(owner) + "/health", marker: marker, phase: 1},
		{label: "账号下一步", method: "GET", path: accPath(owner) + "/next-actions", marker: marker, phase: 1},
		{label: "账号节奏", method: "GET", path: accPath(owner) + "/rhythm", marker: marker, phase: 1},
		{label: "账号档案", method: "GET", path: accPath(owner) + "/profile", marker: marker, phase: 1},
		{label: "账号档案写入", method: "PUT", path: accPath(owner) + "/profile", body: map[string]any{"audience": marker}, phase: 1},
		{label: "风格样本列表", method: "GET", path: accPath(owner) + "/style-samples", marker: marker, phase: 1},
		{label: "角色列表", method: "GET", path: accPath(comicAcc) + "/characters", marker: marker, phase: 1},
		{label: "记忆列表", method: "GET", path: accPath(owner) + "/memories", marker: marker, phase: 1},
		{label: "系列列表", method: "GET", path: accPath(owner) + "/series", marker: marker, phase: 1},
		{label: "参考列表", method: "GET", path: accPath(owner) + "/references", marker: marker, phase: 1},
		{label: "选题列表", method: "GET", path: accPath(owner) + "/topics", marker: marker, phase: 1},
		{label: "作品列表", method: "GET", path: accPath(owner) + "/works", marker: marker, phase: 1},
		{label: "方案详情", method: "GET", path: accPath(owner) + "/strategy", marker: marker, phase: 1},
		{label: "计划详情", method: "GET", path: accPath(owner) + "/plan", marker: marker, phase: 1},
		{label: "数据看板", method: "GET", path: accPath(owner) + "/dashboard", marker: marker, phase: 1},
		{label: "复盘列表", method: "GET", path: accPath(owner) + "/reviews", marker: marker, phase: 1},
		{label: "数据偏好", method: "GET", path: accPath(owner) + "/data-preferences", marker: marker, phase: 1},
		{label: "头部作品", method: "GET", path: accPath(owner) + "/top-works", marker: marker, phase: 1},
		{label: "数据摘要", method: "GET", path: accPath(owner) + "/digests", marker: marker, phase: 1},
		{label: "粉丝数据", method: "GET", path: accPath(owner) + "/followers", marker: marker, phase: 1},
		{label: "每日清单", method: "GET", path: accPath(owner) + "/daily", marker: marker, phase: 1},
		{label: "每日统计", method: "GET", path: accPath(owner) + "/daily/stats", marker: marker, phase: 1},
		{label: "热点趋势", method: "GET", path: accPath(owner) + "/hot/trends", marker: marker, phase: 1},
		{label: "未匹配指标", method: "GET", path: accPath(owner) + "/metrics/unmatched", marker: marker, phase: 1},
		{label: "自定义主题", method: "GET", path: accPath(owner) + "/custom-theme", marker: marker, phase: 1},
		{label: "自定义主题写入", method: "PUT", path: accPath(owner) + "/custom-theme", body: map[string]any{"theme": map[string]any{"name": marker}}, phase: 1},
		{label: "检索记忆", method: "POST", path: accPath(owner) + "/retrieve", body: map[string]any{"query": marker}, marker: marker, phase: 1},
		{label: "档案引导", method: "POST", path: accPath(owner) + "/profile/bootstrap", body: map[string]any{}, phase: 1},
		{label: "选题建议", method: "POST", path: accPath(owner) + "/topics/suggest", body: map[string]any{}, marker: marker, phase: 1},
		{label: "风格摘要", method: "POST", path: accPath(owner) + "/style-summary", body: map[string]any{}, marker: marker, phase: 1},
		{label: "微信凭证测试", method: "POST", path: accPath(owner) + "/wechat-credential/test", body: map[string]any{}, phase: 1},
		{label: "在所有者账号下建作品", method: "POST", path: accPath(owner) + "/works", body: map[string]any{"title": marker + " 越权作品"}, phase: 1},
		{label: "在所有者账号下建选题", method: "POST", path: accPath(owner) + "/topics", body: map[string]any{"title": marker + " 越权选题", "source": "ai"}, phase: 1},
		{label: "在所有者账号下建系列", method: "POST", path: accPath(owner) + "/series", body: map[string]any{"name": marker + " 越权系列"}, phase: 1},
		{label: "账号详情（漫画号）", method: "GET", path: accPath(comicAcc), marker: marker, phase: 1},
		{label: "漫画号作品列表", method: "GET", path: accPath(comicAcc) + "/works", marker: marker, phase: 1},
		{label: "在所有者账号下建角色", method: "POST", path: accPath(comicAcc) + "/characters", body: map[string]any{"name": marker + " 越权角色"}, phase: 1},
		{label: "在所有者账号下建样本", method: "POST", path: accPath(owner) + "/style-samples", body: map[string]any{"title": marker + " 越权样本", "content_md": marker}, phase: 1},
		{label: "在所有者账号下建记忆", method: "POST", path: accPath(owner) + "/memories", body: map[string]any{"kind": "structure", "text": marker + " 越权记忆"}, phase: 1},
		{label: "触发所有者记忆提炼", method: "POST", path: accPath(owner) + "/memories/distill", body: nil, phase: 1},

		// 作品
		{label: "作品详情", method: "GET", path: "/api/v1/works/" + workID, marker: marker, phase: 1},
		{label: "作品改名", method: "PATCH", path: "/api/v1/works/" + workID, body: map[string]any{"title": "XP-guest-" + u}, phase: 1},
		{label: "作品大纲写入", method: "PUT", path: "/api/v1/works/" + workID + "/outline", body: map[string]any{"items": []any{}, "confirm": false}, phase: 1},
		{label: "作品大纲审阅", method: "POST", path: "/api/v1/works/" + workID + "/outline/review", body: map[string]any{"items": []any{}}, marker: marker, phase: 1},
		{label: "作品分镜写入", method: "PUT", path: "/api/v1/works/" + workID + "/storyboard", body: map[string]any{"items": []any{}}, phase: 1},
		{label: "作品推送清单写入", method: "PUT", path: "/api/v1/works/" + workID + "/post-push-todos", body: map[string]any{"items": []any{}}, phase: 1},
		{label: "作品标题收藏写入", method: "PUT", path: "/api/v1/works/" + workID + "/title-favorites", body: map[string]any{"titles": []string{}}, phase: 1},
		{label: "作品版本列表", method: "GET", path: "/api/v1/works/" + workID + "/versions", marker: marker, phase: 1},
		{label: "作品版本详情", method: "GET", path: "/api/v1/works/" + workID + "/versions/1", phase: 1},
		{label: "作品版本恢复", method: "POST", path: "/api/v1/works/" + workID + "/versions/1/restore", body: map[string]any{}, phase: 1},
		{label: "作品源文差异", method: "GET", path: "/api/v1/works/" + workID + "/source-diff", marker: marker, phase: 1},
		{label: "作品家族", method: "GET", path: "/api/v1/works/" + workID + "/family", marker: marker, phase: 1},
		{label: "作品系列上下文", method: "GET", path: "/api/v1/works/" + workID + "/series-context", marker: marker, phase: 1},
		{label: "作品检查结果", method: "GET", path: "/api/v1/works/" + workID + "/checks/latest", marker: marker, phase: 1},
		{label: "作品检查报告", method: "GET", path: "/api/v1/works/" + workID + "/checks/report", marker: marker, phase: 1},
		{label: "对所有者作品发起检查", method: "POST", path: "/api/v1/works/" + workID + "/checks", body: map[string]any{"html_chars": 100, "html_bytes": 300}, phase: 1},
		{label: "完成所有者作品检查", method: "POST", path: "/api/v1/works/" + workID + "/checks/complete", body: nil, phase: 1},
		{label: "生成所有者作品预览链接", method: "POST", path: "/api/v1/works/" + workID + "/preview-link", body: nil, phase: 1},
		{label: "复制所有者作品", method: "POST", path: "/api/v1/works/" + workID + "/duplicate", body: nil, phase: 1},
		{label: "解锁所有者作品", method: "POST", path: "/api/v1/works/" + workID + "/unlock", body: map[string]any{}, phase: 1},
		{label: "通读所有者作品", method: "POST", path: "/api/v1/works/" + workID + "/read-through", body: map[string]any{}, phase: 1},
		{label: "作品灵感整理", method: "POST", path: "/api/v1/works/" + workID + "/organize-notes", body: map[string]any{}, marker: marker, phase: 1},
		{label: "作品标题建议", method: "POST", path: "/api/v1/works/" + workID + "/titles", body: map[string]any{}, phase: 1},
		{label: "作品摘要", method: "POST", path: "/api/v1/works/" + workID + "/summary", body: map[string]any{}, phase: 1},
		{label: "作品小红书页面建议", method: "POST", path: "/api/v1/works/" + workID + "/xhs/pages", body: map[string]any{}, phase: 1},
		{label: "作品微信预览", method: "GET", path: "/api/v1/works/" + workID + "/wechat/push-preview", marker: marker, phase: 1},
		{label: "作品 Copilot 历史", method: "GET", path: "/api/v1/works/" + workID + "/copilot", marker: marker, phase: 1},
		{label: "作品 Copilot 提问", method: "POST", path: "/api/v1/works/" + workID + "/copilot", body: map[string]any{"message": "这段怎么写"}, phase: 1},
		{label: "作品 Copilot 清空", method: "DELETE", path: "/api/v1/works/" + workID + "/copilot", phase: 2},
		{label: "作品检查建议", method: "POST", path: "/api/v1/works/" + workID + "/lint", body: map[string]any{"html": ""}, phase: 1},
		{label: "作品润色检查", method: "POST", path: "/api/v1/works/" + workID + "/polish-check", body: map[string]any{}, phase: 1},
		{label: "作品留言列表", method: "GET", path: "/api/v1/works/" + workID + "/comments", marker: marker, phase: 1},
		{label: "作品在场状态", method: "GET", path: "/api/v1/works/" + workID + "/presence", marker: marker, phase: 1},
		{label: "作品动态", method: "GET", path: "/api/v1/works/" + workID + "/activity", marker: marker, phase: 1},
		{label: "作品指标列表", method: "GET", path: "/api/v1/works/" + workID + "/metrics", phase: 1},
		{label: "给所有者作品录指标", method: "POST", path: "/api/v1/works/" + workID + "/metrics", body: map[string]any{"reads": 7}, phase: 1},
		{label: "标记所有者作品已发布", method: "POST", path: "/api/v1/works/" + workID + "/published", body: map[string]any{"url": "https://example.com/xp" + u}, phase: 1},
		{label: "在所有者作品下加段落", method: "POST", path: "/api/v1/works/" + workID + "/sections", body: map[string]any{"heading": marker + " 越权段落"}, phase: 1},
		{label: "重排所有者作品段落", method: "PUT", path: "/api/v1/works/" + workID + "/sections/order", body: map[string]any{"ids": []string{}}, phase: 1},
		{label: "复用所有者素材到作品", method: "POST", path: "/api/v1/works/" + workID + "/assets/reuse", body: map[string]any{"asset_ids": []string{assetID}}, phase: 1},

		// 段落
		{label: "段落详情改写", method: "PATCH", path: "/api/v1/sections/" + secID, body: map[string]any{"content_md": "XP-guest 改写", "base_revision": secRev}, phase: 1},
		{label: "段落历史", method: "GET", path: "/api/v1/sections/" + secID + "/revisions", marker: marker, phase: 1},
		{label: "段落历史恢复", method: "POST", path: "/api/v1/sections/" + secID + "/revisions/" + revisionID.String() + "/restore", body: map[string]any{}, phase: 1},
		{label: "段落素材绑定", method: "PUT", path: "/api/v1/sections/" + secID + "/materials", body: map[string]any{"material_ids": []string{mat.ID.String()}}, phase: 1},
		{label: "段落续写", method: "POST", path: "/api/v1/sections/" + secID + "/continue", body: map[string]any{}, phase: 1},
		{label: "段落钩子建议", method: "POST", path: "/api/v1/sections/" + secID + "/hooks", body: map[string]any{}, phase: 1},
		{label: "段落图片建议", method: "POST", path: "/api/v1/sections/" + secID + "/image-suggest", body: map[string]any{}, phase: 1},
		{label: "段落恢复", method: "POST", path: "/api/v1/sections/" + lastSecID + "/restore", body: map[string]any{}, phase: 2},
		{label: "删除所有者段落", method: "DELETE", path: "/api/v1/sections/" + lastSecID, phase: 2},

		// 素材 / 资产
		{label: "素材详情", method: "GET", path: "/api/v1/materials/" + mat.ID.String(), marker: marker, phase: 1},
		{label: "素材引用情况", method: "GET", path: "/api/v1/materials/" + mat.ID.String() + "/usage", marker: marker, phase: 1},
		{label: "素材改写", method: "PATCH", path: "/api/v1/materials/" + mat.ID.String(), body: map[string]any{"content": "XP-guest 素材"}, phase: 1},
		{label: "素材查重", method: "GET", path: "/api/v1/materials/duplicates?account_id=" + owner.ID.String(), marker: marker, phase: 1},
		{label: "资产文件", method: "GET", path: "/api/v1/assets/" + assetID + "/file", phase: 1},
		{label: "资产智能裁剪", method: "GET", path: "/api/v1/assets/" + assetID + "/smart-crop", phase: 1},
		{label: "资产改名", method: "PATCH", path: "/api/v1/assets/" + assetID, body: map[string]any{"alt": "XP-guest"}, phase: 1},
		{label: "资产替代文本建议", method: "POST", path: "/api/v1/assets/" + assetID + "/alt-suggestion", body: map[string]any{}, phase: 1},
		{label: "删除所有者资产", method: "DELETE", path: "/api/v1/assets/" + assetID, phase: 2},

		// 批注（没有 DELETE 路由，删除只能用作品的批注列表确认，故只测改写）
		{label: "改写所有者批注", method: "PATCH", path: "/api/v1/comments/" + comment.ID.String(), body: map[string]any{"body": "XP-guest 批注"}, phase: 1},

		// 指标
		{label: "改写所有者指标", method: "PATCH", path: "/api/v1/metrics/" + metric.ID.String(), body: map[string]any{"reads": 1}, phase: 1},
		{label: "删除所有者指标", method: "DELETE", path: "/api/v1/metrics/" + metric.ID.String(), phase: 2},

		// 选题 / 角色 / 样本 / 记忆 / 系列 / 参考
		{label: "选题改写", method: "PATCH", path: "/api/v1/topics/" + topic.ID.String(), body: map[string]any{"title": "XP-guest 选题"}, phase: 1},
		{label: "从所有者选题开工", method: "POST", path: "/api/v1/topics/" + topic.ID.String() + "/works", body: map[string]any{}, phase: 1},
		{label: "删除所有者选题", method: "DELETE", path: "/api/v1/topics/" + topic.ID.String(), phase: 2},
		{label: "角色改写", method: "PATCH", path: "/api/v1/characters/" + char.ID.String(), body: map[string]any{"name": "XP-guest 角色"}, phase: 1},
		{label: "删除所有者角色", method: "DELETE", path: "/api/v1/characters/" + char.ID.String(), phase: 2},
		{label: "样本改写", method: "PATCH", path: "/api/v1/style-samples/" + sample.ID.String(), body: map[string]any{"title": "XP-guest 样本"}, phase: 1},
		{label: "删除所有者样本", method: "DELETE", path: "/api/v1/style-samples/" + sample.ID.String(), phase: 2},
		{label: "记忆改写", method: "PATCH", path: "/api/v1/memories/" + memory.ID.String(), body: map[string]any{"text": "XP-guest 记忆"}, phase: 1},
		{label: "删除所有者记忆", method: "DELETE", path: "/api/v1/memories/" + memory.ID.String(), phase: 2},
		{label: "系列改写", method: "PATCH", path: "/api/v1/series/" + series.ID.String(), body: map[string]any{"name": "XP-guest 系列"}, phase: 1},
		{label: "系列选题建议", method: "POST", path: "/api/v1/series/" + series.ID.String() + "/suggest", body: map[string]any{}, phase: 1},
		{label: "删除所有者系列", method: "DELETE", path: "/api/v1/series/" + series.ID.String(), phase: 2},
		{label: "参考粘贴", method: "POST", path: "/api/v1/references/" + refID.String() + "/paste", body: map[string]any{}, phase: 1},
		{label: "删除所有者参考", method: "DELETE", path: "/api/v1/references/" + refID.String(), phase: 2},

		// 收件箱
		{label: "收件箱分诊", method: "POST", path: "/api/v1/inbox/" + inbox.ID.String() + "/triage", body: map[string]any{}, phase: 1},
		{label: "收件箱转选题", method: "POST", path: "/api/v1/inbox/" + inbox.ID.String() + "/convert", body: map[string]any{}, phase: 1},
		{label: "删除所有者收件箱", method: "DELETE", path: "/api/v1/inbox/" + inbox.ID.String(), phase: 2},

		// 敏感词 / 供应商 / 评测用例
		{label: "删除所有者敏感词", method: "DELETE", path: "/api/v1/sensitive-words/" + wordID.String(), phase: 2},
		{label: "改写所有者供应商", method: "PATCH", path: "/api/v1/model-providers/" + provider.ID.String(), body: map[string]any{"name": "XP-guest 供应商"}, phase: 1},
		{label: "测试所有者供应商", method: "POST", path: "/api/v1/model-providers/" + provider.ID.String() + "/test", body: map[string]any{}, phase: 1},
		{label: "自检所有者供应商", method: "POST", path: "/api/v1/model-providers/" + provider.ID.String() + "/selftest", body: map[string]any{}, phase: 1},
		{label: "删除所有者供应商", method: "DELETE", path: "/api/v1/model-providers/" + provider.ID.String(), phase: 2},

		// 检查项
		{label: "改写所有者检查项", method: "PATCH", path: "/api/v1/check-items/" + checkItem.String(), body: map[string]any{"resolution": checkRes}, phase: 1},
		{label: "检查项修复建议", method: "POST", path: "/api/v1/check-items/" + fixItem.String() + "/fix-suggest", body: map[string]any{}, phase: 1},

		// 计划槽位
		{label: "采用所有者槽位", method: "POST", path: "/api/v1/plan-slots/" + slotID.String() + "/adopt", body: map[string]any{"title": marker + " 越权采用"}, phase: 1},
		{label: "重生成所有者槽位", method: "POST", path: "/api/v1/plan-slots/" + slotID.String() + "/regenerate", body: map[string]any{}, phase: 1},
		{label: "清空所有者槽位", method: "POST", path: "/api/v1/plan-slots/" + slotID.String() + "/clear", body: map[string]any{}, phase: 2},

		// AI 任务 / 通知 / 对话
		{label: "AI 任务详情", method: "GET", path: "/api/v1/ai-jobs/" + distill.JobID.String(), marker: marker, phase: 1},
		{label: "取消所有者 AI 任务", method: "POST", path: "/api/v1/ai-jobs/" + distill.JobID.String() + "/cancel", body: nil, phase: 2},
		{label: "标记所有者通知已读", method: "POST", path: "/api/v1/notifications/" + notifID.String() + "/read", body: nil, phase: 2, softOK: true},
		{label: "对话详情", method: "GET", path: "/api/v1/agent/conversations/" + conv.ID.String(), marker: marker, phase: 1},
		{label: "改对话标题", method: "PATCH", path: "/api/v1/agent/conversations/" + conv.ID.String(), body: map[string]any{"title": "XP-guest 对话"}, phase: 1},
		{label: "对话消息", method: "POST", path: "/api/v1/agent/conversations/" + conv.ID.String() + "/messages", body: map[string]any{"text": "XP-guest 追加消息"}, phase: 1},
		{label: "删除所有者对话", method: "DELETE", path: "/api/v1/agent/conversations/" + conv.ID.String(), phase: 2},

		// 工作区 / 邀请
		{label: "改所有者工作区名", method: "PATCH", path: "/api/v1/workspaces/" + ownerWS.String(), body: map[string]any{"name": "XP-guest 工作区"}, phase: 2},
		{label: "撤销所有者邀请", method: "POST", path: "/api/v1/workspaces/current/invites/" + invite.ID.String() + "/revoke", body: nil, phase: 2},
		{label: "改所有者成员角色", method: "PATCH", path: "/api/v1/workspaces/current/members/" + ownerUser.String(), body: map[string]any{"role": "editor"}, phase: 2},
		{label: "删所有者素材", method: "DELETE", path: "/api/v1/materials/" + mat.ID.String(), phase: 2},

		// 回收站（工具本身的软删除结果）
		{label: "回收站恢复所有者素材", method: "POST", path: "/api/v1/trash/material/" + trashMat.ID.String() + "/restore", body: nil, phase: 2},

		// 终局破坏性操作：放最后，避免前面探针受污染。
		{label: "AI 调用反馈", method: "POST", path: "/api/v1/ai-calls/" + aiCallID.String() + "/feedback", body: map[string]any{"rating": 1}, phase: 3},
		{label: "删除所有者作品", method: "DELETE", path: "/api/v1/works/" + workID, phase: 3},
		{label: "切换进所有者工作区", method: "POST", path: "/api/v1/workspaces/" + ownerWS.String() + "/switch", body: map[string]any{}, phase: 3},
		{label: "转移所有者工作区所有权", method: "POST", path: "/api/v1/workspaces/current/transfer", body: map[string]any{"user_id": ownerUser.String()}, phase: 3},
		{label: "删除所有者账号", method: "DELETE", path: accPath(owner), phase: 3},
	}

	// 未取到 ID 的探针跳过（并在总结里说明）。
	if evalCase.ID == uuid.Nil {
		for i := len(probes) - 1; i >= 0; i-- {
			if strings.Contains(probes[i].path, "/prompt-eval/") {
				probes = append(probes[:i], probes[i+1:]...)
			}
		}
	} else {
		probes = append(probes,
			xProbe{label: "删除所有者评测用例", method: "DELETE", path: "/api/v1/prompt-eval/cases/" + evalCase.ID.String(), phase: 2},
			xProbe{label: "评测用例运行记录", method: "GET", path: "/api/v1/prompt-eval/cases/" + evalCase.ID.String() + "/runs", marker: marker, phase: 1},
		)
	}
	// 未创建成功的前置资源（通知/AI 任务/对话等）也可能缺失，统一在跑之前清理空 ID。
	clean := probes[:0]
	for _, p := range probes {
		if strings.Contains(p.path, "00000000-0000-0000-0000-000000000000") {
			t.Logf("跳过探针（前置资源缺失）：%s %s", p.method, p.path)
			continue
		}
		clean = append(clean, p)
	}
	probes = clean

	// 稳定排序，保持同一 phase 内的手工顺序（破坏性顺序很重要）。
	sort.SliceStable(probes, func(i, j int) bool { return probes[i].phase < probes[j].phase })

	var results []xProbeResult
	for _, p := range probes {
		st, body := guest.do(p.method, p.path, p.body)
		class, note := xpClassify(st, body, p.marker, p.public)
		// GET 返回 2xx 但响应体为空（[]、{}、null）说明没有读到任何数据，
		// 不构成数据泄露；仅记录“没有用 404 表达隔离”这一风格差异。
		if class == xpLeak && p.method == "GET" && xpEmptyBody(body) {
			class = xpNoData
			note = "返回 2xx 但响应为空，未发现所有者数据"
		}
		// 对不存在的 ID 幂等返回 2xx 的接口（例如通知已读），需要单独核对
		// 所有者数据是否真的被改动，不能仅凭状态码判定越权。
		if class == xpLeak && p.softOK {
			class = xpNoop
			note = "返回成功，但按 user/workspace 过滤后影响 0 行（需另行确认无副作用）"
		}
		r := xProbeResult{xProbe: p, status: st, class: class, snippet: xpSnippet(body), note: note}
		results = append(results, r)
		switch class {
		case xpLeak:
			if p.marker != "" && strings.Contains(string(body), p.marker) {
				t.Errorf("越权泄露：%s | %s %s => %d | 响应包含所有者标记 %q | %s", p.label, p.method, p.path, st, p.marker, r.snippet)
			} else {
				t.Errorf("越权成功：%s | %s %s => %d | %s | %s", p.label, p.method, p.path, st, note, r.snippet)
			}
		case xpServer:
			t.Errorf("服务端错误：%s | %s %s => %d | %s", p.label, p.method, p.path, st, r.snippet)
		case xpAmbig:
			t.Logf("语义未定（未断言）：%s | %s %s => %d %s", p.label, p.method, p.path, st, r.snippet)
		case xpNoData, xpNoop:
			t.Logf("%s：%s | %s %s => %d | %s", class, p.label, p.method, p.path, st, note)
		}
	}

	// ---------- 列表接口不泄露检查 ----------
	guest.restore(env)
	guestCSRF := guest.csrf
	_ = guestCSRF
	listChecks := []struct {
		label  string
		path   string
		marker string
	}{
		{"作品列表", "/api/v1/works", marker},
		{"素材列表", "/api/v1/materials?account_id=" + owner.ID.String(), marker},
		{"回收站", "/api/v1/trash", marker},
		{"通知", "/api/v1/notifications", ""},
		{"资料库资产", "/api/v1/assets", marker},
		{"收件箱", "/api/v1/inbox", marker},
		{"AI 任务", "/api/v1/ai-jobs", marker},
		{"账号列表", "/api/v1/accounts", "XP漫画号" + u},
		{"工作区列表", "/api/v1/workspaces", "测试公众号"},
		{"敏感词", "/api/v1/sensitive-words", marker},
		{"模型供应商", "/api/v1/model-providers", marker},
		{"评测用例", "/api/v1/prompt-eval/cases", marker},
		{"全局搜索", "/api/v1/search?q=" + marker, marker},
		{"日历", "/api/v1/calendar", marker},
		{"收藏", "/api/v1/stars", marker},
		{"AI 调用记录", "/api/v1/quality/calls", marker},
		{"提示词模板", "/api/v1/prompt-templates", marker},
		{"大纲模板", "/api/v1/outline-templates", marker},
		{"对话列表", "/api/v1/agent/conversations", marker},
	}
	listLeaks := 0
	for _, c := range listChecks {
		st, body := guest.do("GET", c.path, nil)
		if st >= 500 {
			t.Errorf("列表接口服务端错误：%s | GET %s => %d %s", c.label, c.path, st, xpSnippet(body))
			listLeaks++
			continue
		}
		if st >= 200 && st < 300 {
			if c.marker != "" && strings.Contains(string(body), c.marker) {
				t.Errorf("列表越权泄露：%s | GET %s => %d | 响应包含所有者标记 %q | %s", c.label, c.path, st, c.marker, xpSnippet(body))
				listLeaks++
			} else if c.marker == "" {
				t.Logf("列表可读（%s => %d），未埋标记无法判断内容归属：%s", c.path, st, xpSnippet(body))
			}
		}
	}

	// ---------- 通知已读探针的副作用核对 ----------
	// readNotification 用 WHERE id=$1 AND user_id=$2 更新，命中 0 行也返回 200；
	// 所以必须回查所有者的通知是否真的未读，才能判定有没有越权写。
	if notifID != uuid.Nil {
		guest.restore(env) // 列表检查把会话切到了访客，回查必须用所有者身份
		var notifAfter struct {
			Items []struct {
				ID     uuid.UUID  `json:"id"`
				ReadAt *time.Time `json:"read_at"`
			} `json:"items"`
			Unread int `json:"unread"`
		}
		env.mustJSON(t, "GET", "/api/v1/notifications", nil, &notifAfter)
		changed := false
		found := false
		for _, it := range notifAfter.Items {
			if it.ID == notifID {
				found = true
				if it.ReadAt != nil {
					changed = true
				}
			}
		}
		if changed {
			t.Errorf("越权写：访客把所有者通知 %s 标记为已读（所有者侧 read_at 非空）", notifID)
		} else {
			t.Logf("通知已读探针无副作用：所有者通知 %s 仍未读（found=%v, unread=%d）", notifID, found, notifAfter.Unread)
		}
	}

	// ---------- 跨租户“写串”：提示词模板 / 大纲模板 ----------
	// 注意：guest.do 会把 env 的会话切成访客，所以所有者侧的读取必须先 restore，
	// 并用独立的访客标记区分“访客写入的内容”和“所有者自己的内容”。
	guest.restore(env)
	guestMarker := "XPG-" + u
	ownerPromptBefore := map[string]string{}
	var promptBefore []struct {
		TaskType string `json:"task_type"`
		Content  string `json:"content"`
	}
	env.mustJSON(t, "GET", "/api/v1/prompt-templates", nil, &promptBefore)
	for _, p := range promptBefore {
		ownerPromptBefore[p.TaskType] = p.Content
	}
	var outlineBefore []map[string]any
	env.mustJSON(t, "GET", "/api/v1/outline-templates", nil, &outlineBefore)
	rawBefore, _ := json.Marshal(outlineBefore)

	gst, gbody := guest.do("PUT", "/api/v1/prompt-templates/"+promptTask, map[string]any{"content": guestMarker + " 访客写的指令"})
	gClass, _ := xpClassify(gst, gbody, guestMarker, false)
	t.Logf("访客写提示词模板：PUT /api/v1/prompt-templates/%s => %d（%s）", promptTask, gst, gClass)
	if gst >= 500 {
		t.Errorf("访客写提示词模板服务端错误：%d %s", gst, xpSnippet(gbody))
	}

	gost, gobody := guest.do("PUT", "/api/v1/outline-templates", map[string]any{"items": []map[string]any{
		{"name": "访客模板" + u, "structure": guestMarker + " 访客结构"},
	}})
	t.Logf("访客写大纲模板：PUT /api/v1/outline-templates => %d %s", gost, xpSnippet(gobody))
	if gost >= 500 {
		t.Errorf("访客写大纲模板服务端错误：%d %s", gost, xpSnippet(gobody))
	}

	// 访客自己的写入应当只落在访客自己的工作区：先确认它确实生效，
	// 否则“所有者没变化”可能只是请求被静默丢弃。
	if gst2, gbody2 := guest.do("GET", "/api/v1/prompt-templates", nil); gst2 == 200 && !strings.Contains(string(gbody2), guestMarker) {
		t.Logf("访客自己的提示词模板未生效（写入可能被忽略）：%s", xpSnippet(gbody2))
	}
	if gost2, gobody2 := guest.do("GET", "/api/v1/outline-templates", nil); gost2 == 200 && !strings.Contains(string(gobody2), guestMarker+" 访客结构") {
		t.Logf("访客自己的大纲模板未生效：%s", xpSnippet(gobody2))
	}

	guest.restore(env)
	var promptAfter []struct {
		TaskType string `json:"task_type"`
		Content  string `json:"content"`
	}
	env.mustJSON(t, "GET", "/api/v1/prompt-templates", nil, &promptAfter)
	for _, p := range promptAfter {
		if strings.Contains(p.Content, guestMarker) {
			t.Errorf("提示词模板被跨租户改写：任务 %s 的内容变成了访客标记 %q", p.TaskType, guestMarker)
		}
		if before, okb := ownerPromptBefore[p.TaskType]; okb && before != p.Content {
			t.Errorf("提示词模板被跨租户改写：任务 %s 从 %q 变成 %q", p.TaskType, before, p.Content)
		}
	}
	var outlineAfter []map[string]any
	env.mustJSON(t, "GET", "/api/v1/outline-templates", nil, &outlineAfter)
	raw, _ := json.Marshal(outlineAfter)
	if strings.Contains(string(raw), guestMarker+" 访客结构") {
		t.Errorf("大纲模板被跨租户改写：访客内容出现在所有者列表中")
	}
	if !strings.Contains(string(raw), marker+" 的结构") {
		t.Errorf("所有者自定义大纲模板丢失：%s", xpSnippet(raw))
	}
	if string(rawBefore) != string(raw) {
		t.Logf("所有者大纲模板内容有非预期变化：before=%s after=%s", xpSnippet(rawBefore), xpSnippet(raw))
	}

	// ---------- 桌面 AI：访客用自己的合法设备证明去动所有者的模型 ----------
	xpDesktopCrossTenant(t, u, marker, guest, "guest-password-123")

	// ---------- 汇总 ----------
	counts := map[string]int{}
	failures := []string{}
	for _, r := range results {
		counts[r.class]++
		if r.class == xpLeak || r.class == xpServer {
			failures = append(failures, fmt.Sprintf("%s | %s %s => %d", r.label, r.method, r.path, r.status))
		}
	}
	fmt.Printf("\n================ 跨租户探针汇总 ================\n")
	fmt.Printf("探针总数: %d（列表检查另计 %d 项，2xx 泄露 %d 项）\n", len(results), len(listChecks), listLeaks)
	for _, k := range []string{xpIsolated, xpLeak, xpServer, xpAmbig, xpPublic, xpNoData, xpNoop} {
		fmt.Printf("  %-16s %d\n", k, counts[k])
	}
	if len(failures) > 0 {
		fmt.Printf("失败项（越权/5xx）:\n")
		for _, f := range failures {
			fmt.Printf("  - %s\n", f)
		}
	} else {
		fmt.Printf("失败项: 无\n")
	}
	fmt.Printf("================================================\n\n")
}

// xpDesktopCrossTenant 验证桌面 AI 的模型是否按 工作区+用户+设备 隔离：
// 访客注册自己的设备并取得完全合法的 ed25519 证明，然后对所有者模型 ID 发起
// update / delete / test。若处理器只校验签名而不校验资源归属，这些请求会成功。
func xpDesktopCrossTenant(t *testing.T, u, marker string, guest *guestClient, guestPassword string) {
	t.Helper()
	oldEnabled := env.srv.cfg.DesktopAIEnabled
	env.srv.cfg.DesktopAIEnabled = true
	t.Cleanup(func() { env.srv.cfg.DesktopAIEnabled = oldEnabled })

	register := func(deviceID uuid.UUID, pub ed25519.PublicKey, priv ed25519.PrivateKey) {
		body, _ := json.Marshal(desktopDeviceInput{
			ID: deviceID, PublicKey: base64.StdEncoding.EncodeToString(pub),
			Name: "XP 设备 " + u, Platform: "windows-x64", Version: "1.0.0",
		})
		challenge, payload := xpChallenge(t, deviceID, base64.StdEncoding.EncodeToString(pub), "device.register", "POST", "/api/v1/desktop/devices", body)
		st, resp := xpDoRaw(t, env.client, env.csrf, "POST", "/api/v1/desktop/devices", body, map[string]string{
			"X-OPS-Desktop-Device":    deviceID.String(),
			"X-OPS-Desktop-Challenge": challenge.String(),
			"X-OPS-Desktop-Signature": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload)),
		})
		if st != 200 {
			t.Fatalf("desktop device register: %d %s", st, resp)
		}
	}

	// 所有者：启用策略、注册设备、创建桌面模型。
	env.reauth(t)
	env.mustJSON(t, "PUT", "/api/v1/desktop/policy", map[string]any{"enabled": true}, nil)
	ownerPub, ownerPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerDevice := uuid.New()
	register(ownerDevice, ownerPub, ownerPriv)
	modelBody, _ := json.Marshal(desktopModelInput{
		Name: "XP 本机模型 " + marker, Models: []string{"local-chat"}, EndpointKind: "loopback", Status: "active",
	})
	mst, mresp := xpSigned(t, ownerDevice, ownerPriv, "model.create", "POST", "/api/v1/desktop/models", modelBody)
	if mst != 200 {
		t.Fatalf("desktop model create: %d %s", mst, mresp)
	}
	var model desktopModelView
	if err := json.Unmarshal(mresp, &model); err != nil || model.ID == uuid.Nil {
		t.Fatalf("desktop model decode: %v %s", err, mresp)
	}

	// 访客：在自己的工作区启用策略、注册自己的设备（合法签名材料）。
	guest.use()
	guest.mustJSON(t, "POST", "/api/v1/auth/reauth", map[string]string{"password": guestPassword}, nil)
	guest.mustJSON(t, "PUT", "/api/v1/desktop/policy", map[string]any{"enabled": true}, nil)
	guestPub, guestPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	guestDevice := uuid.New()
	register(guestDevice, guestPub, guestPriv)

	cases := []struct {
		label  string
		op     string
		method string
		path   string
		body   []byte
	}{
		{"访客更新所有者桌面模型", "model.update", "PUT", "/api/v1/desktop/models/" + model.ID.String(),
			mustJSONBytes(t, desktopModelInput{Name: "XP 篡改 " + u, Models: []string{"local-chat"}, EndpointKind: "loopback", Status: "disabled", ConfigRev: 1})},
		{"访客测试所有者桌面模型", "model.test", "POST", "/api/v1/desktop/models/" + model.ID.String() + "/test", mustJSONBytes(t, map[string]any{"model": "mock-chat"})},
		{"访客删除所有者桌面模型", "model.delete", "DELETE", "/api/v1/desktop/models/" + model.ID.String(), []byte("{}")},
	}
	for _, c := range cases {
		st, body := xpSigned(t, guestDevice, guestPriv, c.op, c.method, c.path, c.body)
		class, note := xpClassify(st, body, marker, false)
		t.Logf("桌面探针 %s：%s %s => %d（%s）%s", c.label, c.method, c.path, st, class, xpSnippet(body))
		if class == xpLeak {
			t.Errorf("桌面 AI 越权：%s | %s %s => %d | %s | %s", c.label, c.method, c.path, st, note, xpSnippet(body))
		}
		if class == xpServer {
			t.Errorf("桌面 AI 服务端错误：%s | %s %s => %d | %s", c.label, c.method, c.path, st, xpSnippet(body))
		}
	}
	guest.restore(env)

	// 所有者的模型必须仍然可用（没被访客改坏/停用）。
	var status string
	var revision int64
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status, desktop_config_revision FROM model_provider WHERE id=$1`, model.ID).Scan(&status, &revision); err != nil {
		t.Fatalf("owner desktop model vanished: %v", err)
	}
	if status != "active" || revision != 1 {
		t.Errorf("所有者桌面模型被访客改动：status=%s revision=%d（期望 active/1）", status, revision)
	}
}

func mustJSONBytes(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
