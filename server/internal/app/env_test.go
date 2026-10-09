package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"ops/internal/config"
	"ops/internal/db"
	"ops/internal/mock"
)

// testEnv is one server backed by a fresh database and the local mock WeChat/model servers.
type testEnv struct {
	srv    *Server
	http   *httptest.Server
	mockWX *mock.Wechat
	mock   *httptest.Server
	client *http.Client
	csrf   string
}

const testPassword = "test-password-123"

var env *testEnv

func TestMain(m *testing.M) {
	code, err := runWithEnv(m)
	if err != nil {
		fmt.Fprintln(os.Stderr, "测试环境准备失败：", err)
		fmt.Fprintln(os.Stderr, "请先启动本地数据库：docker compose -f deploy/docker-compose.dev.yml up -d")
		os.Exit(1)
	}
	os.Exit(code)
}

func runWithEnv(m *testing.M) (int, error) {
	admin := os.Getenv("OPS_TEST_ADMIN_URL")
	if admin == "" {
		admin = "postgres://ops:ops_dev_password@localhost:5440/ops?sslmode=disable"
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		return 0, err
	}
	if _, err := conn.Exec(ctx, `DROP DATABASE IF EXISTS ops_test WITH (FORCE)`); err != nil {
		return 0, err
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE ops_test`); err != nil {
		return 0, err
	}
	conn.Close(ctx)
	u, _ := url.Parse(admin)
	u.Path = "/ops_test"
	dbURL := u.String()
	if err := db.Migrate(dbURL); err != nil {
		return 0, err
	}
	pool, err := db.Connect(ctx, dbURL)
	if err != nil {
		return 0, err
	}
	defer pool.Close()

	wx := mock.NewWechat()
	llm := &mock.LLM{}
	mux := http.NewServeMux()
	mux.Handle("/v1/", llm.Handler())
	mux.Handle("/", wx.Handler())
	mockSrv := httptest.NewServer(mux)
	defer mockSrv.Close()

	dataDir, err := os.MkdirTemp("", "ops-test-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(dataDir)
	key := bytes.Repeat([]byte{7}, 32)
	cfg := &config.Config{Dev: true, DatabaseURL: dbURL, DataDir: dataDir, MasterKey: key,
		WechatBase: mockSrv.URL, MockListen: strings.TrimPrefix(mockSrv.URL, "http://")}
	srv, err := New(cfg, pool)
	if err != nil {
		return 0, err
	}
	if err := srv.SeedDevModel(ctx); err != nil {
		return 0, err
	}
	hs := httptest.NewServer(srv.Router())
	defer hs.Close()
	jar, _ := cookiejar.New(nil)
	env = &testEnv{srv: srv, http: hs, mockWX: wx, mock: mockSrv, client: &http.Client{Jar: jar, Timeout: time.Minute}}
	if st, body := env.do("POST", "/api/v1/auth/setup", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		return 0, fmt.Errorf("setup: %d %s", st, body)
	}
	var me struct {
		CSRF string `json:"csrf_token"`
	}
	env.mustJSON(nil, "GET", "/api/v1/auth/me", nil, &me)
	env.csrf = me.CSRF
	return m.Run(), nil
}

func (e *testEnv) request(method, path string, body io.Reader, contentType string) *http.Response {
	req, _ := http.NewRequest(method, e.http.URL+path, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("X-CSRF-Token", e.csrf)
	resp, err := e.client.Do(req)
	if err != nil {
		panic(err)
	}
	return resp
}

func (e *testEnv) do(method, path string, in any) (int, []byte) {
	var body io.Reader
	if in != nil {
		b, _ := json.Marshal(in)
		body = bytes.NewReader(b)
	}
	resp := e.request(method, path, body, "application/json")
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// mustJSON performs a request that must succeed and decodes the response.
func (e *testEnv) mustJSON(t *testing.T, method, path string, in, out any) {
	st, b := e.do(method, path, in)
	if st != 200 {
		msg := fmt.Sprintf("%s %s => %d %s", method, path, st, b)
		if t == nil {
			panic(msg)
		}
		t.Helper()
		t.Fatal(msg)
	}
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			t.Helper()
			t.Fatalf("%s %s decode: %v (%s)", method, path, err, b)
		}
	}
}

type apiError struct {
	Error struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Detail  json.RawMessage `json:"detail"`
	} `json:"error"`
}

// expectErr asserts the request fails with the given error code and returns the error.
func (e *testEnv) expectErr(t *testing.T, method, path string, in any, code string) apiError {
	t.Helper()
	st, b := e.do(method, path, in)
	var ae apiError
	_ = json.Unmarshal(b, &ae)
	if st < 400 || ae.Error.Code != code {
		t.Fatalf("%s %s: want error %s, got %d %s", method, path, code, st, b)
	}
	return ae
}

type sseEvent struct {
	Name string
	Data json.RawMessage
}

func (e *testEnv) sse(t *testing.T, path string, in any) []sseEvent {
	t.Helper()
	b, _ := json.Marshal(in)
	resp := e.request("POST", path, bytes.NewReader(b), "application/json")
	defer resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST %s: not SSE: %d %s", path, resp.StatusCode, body)
	}
	var out []sseEvent
	var cur sseEvent
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			cur.Name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			cur.Data = json.RawMessage(strings.TrimPrefix(line, "data: "))
		case line == "":
			if cur.Name != "" {
				out = append(out, cur)
			}
			cur = sseEvent{}
		}
	}
	return out
}

func lastEvent(t *testing.T, evs []sseEvent) sseEvent {
	t.Helper()
	if len(evs) == 0 {
		t.Fatal("no SSE events")
	}
	return evs[len(evs)-1]
}

func (e *testEnv) upload(t *testing.T, workID string, data []byte) Asset {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "pic.png")
	_, _ = fw.Write(data)
	_ = mw.Close()
	resp := e.request("POST", "/api/v1/works/"+workID+"/assets", &buf, mw.FormDataContentType())
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("upload: %d %s", resp.StatusCode, b)
	}
	var a Asset
	_ = json.Unmarshal(b, &a)
	return a
}

func testPNG(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 120, 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func (e *testEnv) reauth(t *testing.T) {
	t.Helper()
	e.mustJSON(t, "POST", "/api/v1/auth/reauth", map[string]string{"password": testPassword}, nil)
}

type fixture struct {
	wechat Account
	xhs    Account
}

var fx *fixture

// accounts creates one WeChat and one Xiaohongshu account with working mock credentials, once.
func (e *testEnv) accounts(t *testing.T) *fixture {
	t.Helper()
	if fx != nil {
		return fx
	}
	f := &fixture{}
	e.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "测试公众号", "content_format": "long_article"}, &f.wechat)
	e.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "测试小红书", "content_format": "image_note"}, &f.xhs)
	e.reauth(t)
	e.mustJSON(t, "PUT", "/api/v1/accounts/"+f.wechat.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx1234567890", "app_secret": "s3cret-value-for-test"}, nil)
	var res map[string]any
	e.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/wechat-credential/test", nil, &res)
	fx = f
	return f
}

// readyWork builds a work through the human checkpoints up to "ready" (checks confirmed one by one).
func (e *testEnv) readyWork(t *testing.T, a Account, viewpoint string) Work {
	t.Helper()
	var wk Work
	e.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "测试作品"}, &wk)
	id := wk.ID.String()
	e.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": viewpoint}, nil)
	var outline struct {
		Items []OutlineItem `json:"items"`
	}
	e.mustJSON(t, "POST", "/api/v1/works/"+id+"/outline/generate", nil, &outline)
	e.mustJSON(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{"items": outline.Items[:2], "confirm": true}, &wk)
	for _, sec := range wk.Sections {
		ev := lastEvent(t, e.sse(t, "/api/v1/sections/"+sec.ID.String()+"/draft", nil))
		if ev.Name != "done" {
			t.Fatalf("draft: %s %s", ev.Name, ev.Data)
		}
	}
	asset := e.upload(t, id, testPNG(900, 500))
	patch := map[string]any{"title": "一篇用于测试的文章", "summary": "测试摘要"}
	if a.Platform == "wechat_mp" {
		patch["cover_asset_id"] = asset.ID
		patch["cover_crops"] = map[string]cropBox{"2.35_1": {0, 0.2, 1, 0.6}, "1_1": {0.2, 0, 0.75, 1}}
	}
	e.mustJSON(t, "PATCH", "/api/v1/works/"+id, patch, nil)
	e.confirmChecks(t, id)
	e.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	if wk.Status != "ready" {
		t.Fatalf("want ready, got %s", wk.Status)
	}
	return wk
}

func (e *testEnv) latestCheck(t *testing.T, workID string) *CheckRun {
	t.Helper()
	var out struct {
		Run *CheckRun `json:"run"`
	}
	for i := 0; i < 100; i++ {
		e.mustJSON(t, "GET", "/api/v1/works/"+workID+"/checks/latest", nil, &out)
		if out.Run != nil && out.Run.FactStatus != "pending" {
			return out.Run
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("fact check did not finish")
	return nil
}

func (e *testEnv) confirmChecks(t *testing.T, workID string) {
	t.Helper()
	e.mustJSON(t, "POST", "/api/v1/works/"+workID+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, nil)
	run := e.latestCheck(t, workID)
	for _, it := range run.Items {
		if it.Category == "format" && !it.Passed && strings.HasPrefix(it.Message, "残留待核实标记") {
			// Resolve placeholders like an author would: rewrite the text, then re-check.
			e.fixPlaceholders(t, workID)
			e.mustJSON(t, "POST", "/api/v1/works/"+workID+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, nil)
			run = e.latestCheck(t, workID)
			break
		}
	}
	for _, it := range run.Items {
		if it.Category == "format" {
			if !it.Passed {
				t.Fatalf("format item failed: %s %s", it.Message, it.Detail)
			}
			continue
		}
		if it.Resolution != nil {
			continue
		}
		res := allowedResolutions[it.Category][0]
		e.mustJSON(t, "PATCH", "/api/v1/check-items/"+it.ID.String(), map[string]string{"resolution": res}, nil)
	}
	e.mustJSON(t, "POST", "/api/v1/works/"+workID+"/checks/complete", nil, nil)
}

func (e *testEnv) fixPlaceholders(t *testing.T, workID string) {
	t.Helper()
	var wk Work
	e.mustJSON(t, "GET", "/api/v1/works/"+workID, nil, &wk)
	for _, sec := range wk.Sections {
		fixed := pendingMarker.ReplaceAllString(sec.ContentMD, "约三成")
		if fixed != sec.ContentMD {
			e.mustJSON(t, "PATCH", "/api/v1/sections/"+sec.ID.String(), map[string]any{"content_md": fixed, "base_revision": sec.Revision}, nil)
		}
	}
}

func testHTML(wk Work) string {
	var b strings.Builder
	for _, sec := range wk.Sections {
		fmt.Fprintf(&b, "<h2>%s</h2><p>%s</p>", sec.Heading, sec.ContentMD)
	}
	for _, a := range wk.Assets {
		fmt.Fprintf(&b, `<p><img src="%s"></p>`, a.URL)
	}
	return b.String()
}

func (e *testEnv) push(t *testing.T, wk Work, extra map[string]any) []sseEvent {
	t.Helper()
	in := map[string]any{"html": testHTML(wk), "revision": wk.Revision, "fields": wk.WechatFields}
	for k, v := range extra {
		in[k] = v
	}
	return e.sse(t, "/api/v1/works/"+wk.ID.String()+"/wechat/push", in)
}
