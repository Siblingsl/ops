package app

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func opt05Server(t *testing.T, dir string) (string, *http.Client) {
	t.Helper()
	cfg := *env.srv.cfg
	cfg.StaticDir = dir
	s, err := New(&cfg, env.srv.db)
	if err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewUnstartedServer(s.Router())
	proxy := os.Getenv("OPS_OPT05_NGINX") == "1"
	if proxy {
		hs.Listener.Close()
		hs.Listener, err = net.Listen("tcp4", "0.0.0.0:0")
		if err != nil {
			t.Fatal(err)
		}
	}
	hs.Start()
	t.Cleanup(hs.Close)
	base := hs.URL
	if proxy {
		raw, err := os.ReadFile("../../../deploy/nginx-ops.conf")
		if err != nil {
			t.Fatal(err)
		}
		port := hs.Listener.Addr().(*net.TCPAddr).Port
		conf := strings.Replace(string(raw), "127.0.0.1:44537", fmt.Sprintf("host.docker.internal:%d", port), 1)
		file := filepath.Join(t.TempDir(), "ops.conf")
		if err := os.WriteFile(file, []byte(conf), 0600); err != nil {
			t.Fatal(err)
		}
		name := "ops-opt05-" + uuid.NewString()[:8]
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "docker", "run", "-d", "--rm", "--name", name,
			"--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::80",
			"--mount", "type=bind,source="+file+",target=/etc/nginx/conf.d/default.conf,readonly", "nginx:1.28-alpine").CombinedOutput()
		if err != nil {
			t.Fatalf("start local nginx: %v %s", err, out)
		}
		t.Cleanup(func() {
			if out, err := exec.Command("docker", "rm", "-f", name).CombinedOutput(); err != nil {
				t.Errorf("remove local nginx: %v %s", err, out)
			}
		})
		if out, err = exec.CommandContext(ctx, "docker", "exec", name, "nginx", "-t").CombinedOutput(); err != nil {
			t.Fatalf("nginx config: %v %s", err, out)
		}
		out, err = exec.CommandContext(ctx, "docker", "port", name, "80/tcp").Output()
		if err != nil {
			t.Fatal(err)
		}
		base = "http://" + strings.TrimSpace(string(out))
		for {
			req, _ := http.NewRequestWithContext(ctx, "GET", base+"/healthz", nil)
			rsp, err := http.DefaultClient.Do(req)
			if err == nil {
				rsp.Body.Close()
				if rsp.StatusCode == 200 {
					break
				}
			}
			if ctx.Err() != nil {
				logs, _ := exec.Command("docker", "logs", name).CombinedOutput()
				t.Fatalf("nginx upstream did not become ready: %v %s", ctx.Err(), logs)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	t.Cleanup(transport.CloseIdleConnections)
	return base, &http.Client{Transport: transport, Jar: env.client.Jar, Timeout: 10 * time.Second}
}

func opt05Get(t *testing.T, client *http.Client, url, encoding string) (http.Header, []byte, int) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept-Encoding", encoding)
	rsp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer rsp.Body.Close()
	body, err := io.ReadAll(rsp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return rsp.Header, body, rsp.StatusCode
}

func opt05AssertGzip(t *testing.T, header http.Header, compressed, original []byte) {
	t.Helper()
	if header.Get("Content-Encoding") != "gzip" || !strings.Contains(header.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("gzip negotiation headers: %v", header)
	}
	r, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	body, err := io.ReadAll(r)
	if err != nil || !bytes.Equal(body, original) || len(compressed) >= len(original) {
		t.Fatalf("gzip data mismatch: original=%d gzip=%d decoded=%d err=%v", len(original), len(compressed), len(body), err)
	}
	t.Logf("payload %d -> %d bytes (%.2f%%)", len(original), len(compressed), float64(len(compressed))*100/float64(len(original)))
}

func TestOPT05StaticCompressionAndCache(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"index.html":              "<!doctype html><html><body>" + strings.Repeat("运营工作台", 100) + "</body></html>",
		"assets/index-abc123.js":  strings.Repeat("console.log('运营工作台');\n", 200),
		"assets/index-abc123.css": strings.Repeat(".editor { padding: 20px; }\n", 100),
		"assets/image-abc123.svg": "<svg>" + strings.Repeat("<text>运营工作台</text>", 100) + "</svg>",
	}
	if bundle := os.Getenv("OPS_OPT05_BUNDLE"); bundle != "" {
		body, err := os.ReadFile(bundle)
		if err != nil {
			t.Fatal(err)
		}
		files["assets/index-abc123.js"] = string(body)
	}
	for path, body := range files {
		if err := os.WriteFile(filepath.Join(dir, path), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	base, client := opt05Server(t, dir)
	for path, body := range files {
		t.Run(path, func(t *testing.T) {
			h, compressed, status := opt05Get(t, client, base+"/"+path, "gzip")
			if status != 200 {
				t.Fatalf("GET %s: %d", path, status)
			}
			opt05AssertGzip(t, h, compressed, []byte(body))
			cache := "no-cache"
			if strings.HasPrefix(path, "assets/") {
				cache = "public, max-age=31536000, immutable"
			}
			if h.Get("Cache-Control") != cache {
				t.Fatalf("cache header: %v", h)
			}
			h, plain, status := opt05Get(t, client, base+"/"+path, "identity")
			if status != 200 || h.Get("Content-Encoding") != "" || !bytes.Equal(plain, []byte(body)) {
				t.Fatalf("identity response: %d %v", status, h)
			}
		})
	}
	h, body, status := opt05Get(t, client, base+"/works/example", "identity")
	if status != 200 || string(body) != files["index.html"] || h.Get("Cache-Control") != "no-cache" {
		t.Fatalf("SPA entry: %d %v", status, h)
	}
	h, _, status = opt05Get(t, client, base+"/assets/missing.js", "gzip")
	if status != 404 || strings.Contains(h.Get("Cache-Control"), "immutable") {
		t.Fatalf("missing asset cached: %d %v", status, h)
	}
}

func TestOPT05JSONCompression(t *testing.T) {
	work := outlinedWork(t, env.accounts(t).wechat, strings.Repeat("作者确认的观点。", 150))
	base, client := opt05Server(t, "")
	url := base + "/api/v1/works/" + work.ID.String()
	h, plain, status := opt05Get(t, client, url, "identity")
	if status != 200 || len(plain) <= 1024 || !strings.HasPrefix(h.Get("Content-Type"), "application/json") {
		t.Fatalf("large JSON: status=%d bytes=%d headers=%v", status, len(plain), h)
	}
	h, compressed, status := opt05Get(t, client, url, "gzip")
	if status != 200 {
		t.Fatalf("gzip JSON: %d %s", status, compressed)
	}
	opt05AssertGzip(t, h, compressed, plain)
}

func TestOPT05SSEIsImmediate(t *testing.T) {
	guest := env.registerClient(t, "opt05-"+uuid.NewString()[:8], testPassword)
	defer guest.restore(env)
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "SSE 压缩验收", "content_format": "long_article",
	}, &account)
	work := outlinedWork(t, account, "先收到逐字输出，再收到完成消息")
	gate := make(chan struct{})
	release := sync.OnceFunc(func() { close(gate) })
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"先\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-gate:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"到\"}}]}\n\ndata: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	t.Cleanup(model.Close)
	var provider struct{ ID uuid.UUID }
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "逐字验收模拟模型", "base_url": model.URL + "/v1", "api_key": "opt05-local-mock-key", "models": []string{"mock-writer"},
	}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{
		{"task_type": "default", "provider_id": provider.ID, "model": "mock-writer"},
	}, nil)
	base, client := opt05Server(t, "")
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", base+"/api/v1/sections/"+work.Sections[0].ID.String()+"/draft", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", env.csrf)
	req.Header.Set("Accept-Encoding", "gzip")
	start := time.Now()
	rsp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer rsp.Body.Close()
	if rsp.StatusCode != 200 || !strings.HasPrefix(rsp.Header.Get("Content-Type"), "text/event-stream") || rsp.Header.Get("Content-Encoding") != "" {
		t.Fatalf("SSE headers: %d %v", rsp.StatusCode, rsp.Header)
	}
	events := make(chan sseEvent, 32)
	go func() {
		defer close(events)
		scanner := bufio.NewScanner(rsp.Body)
		var event sseEvent
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				event.Name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				event.Data = json.RawMessage(strings.TrimPrefix(line, "data: "))
			case line == "" && event.Name != "":
				events <- event
				event = sseEvent{}
			}
		}
	}()
	first := opt04Wait(t, events, "delta", "")
	if string(first.Data) != `{"text":"先"}` || time.Since(start) > time.Second {
		t.Fatalf("first delta delayed or incorrect: %s after %s", first.Data, time.Since(start))
	}
	t.Logf("first delta received before model completion in %s; SSE has no Content-Encoding", time.Since(start))
	release()
	second := opt04Wait(t, events, "delta", "")
	if string(second.Data) != `{"text":"到"}` {
		t.Fatalf("second delta: %s", second.Data)
	}
	opt04Wait(t, events, "done", "")
	var saved Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &saved)
	if saved.Sections[0].ContentMD != "先到" {
		t.Fatalf("streamed content not saved: %q", saved.Sections[0].ContentMD)
	}
}
