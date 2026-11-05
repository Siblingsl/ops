//go:build linux

package documentparse

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseUsesConfiguredUnixSocket(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "parser.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/parse" {
			http.NotFound(w, r)
			return
		}
		var request Request
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		if request.Name != "report.csv" || string(request.Data) != "a,b\n1,2\n" {
			http.Error(w, "unexpected parser request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"parsed by sidecar","extracted_chars":17,"injected_chars":17}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	t.Setenv("OPS_DOCUMENT_PARSER_SOCKETS", socket)

	result, err := Parse(context.Background(), "report.csv", []byte("a,b\n1,2\n"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "parsed by sidecar" || result.InjectedChars != 17 {
		t.Fatalf("unexpected parser receipt: %+v", result)
	}
	if _, err := os.Stat(socket); err != nil {
		t.Fatalf("parser test socket disappeared: %v", err)
	}
}

func TestParseFailsClosedWithoutConfiguredService(t *testing.T) {
	t.Setenv("OPS_DOCUMENT_PARSER_SOCKETS", "")
	if _, err := Parse(context.Background(), "report.csv", []byte("a,b\n1,2\n")); err == nil || err.Error() != "document parser resource limit unavailable" {
		t.Fatalf("Linux parser must fail closed without its constrained service, got %v", err)
	}
}

func TestParseHighCompressionDOCXThroughLinuxParserService(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "parser.sock")
	t.Setenv("OPS_DOCUMENT_PARSER_SOCKET", socket)
	t.Setenv("OPS_DOCUMENT_PARSER_SOCKETS", socket)
	ctx, cancel := context.WithCancel(context.Background())
	serveDone := make(chan error, 1)
	go func() { serveDone <- ServeParser(ctx) }()
	defer func() {
		cancel()
		select {
		case err := <-serveDone:
			if err != nil {
				t.Errorf("parser service shutdown failed: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Error("parser service did not stop after cancellation")
		}
	}()

	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	client := &http.Client{Transport: transport}
	defer transport.CloseIdleConnections()
	deadline := time.Now().Add(2 * time.Second)
	for {
		request, err := http.NewRequest(http.MethodGet, "http://parser/healthz", nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusNoContent {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("parser service did not become healthy: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	compressed, ratio := highCompressionDOCXFixture(t)
	start := time.Now()
	result, err := Parse(context.Background(), "high-compression.docx", compressed)
	elapsed := time.Since(start)
	if err == nil || !strings.Contains(err.Error(), "docx_expanded_size_limit") {
		t.Fatalf("Linux parser service must reject high-compression DOCX by its declared size: result %+v, err %v", result, err)
	}
	t.Logf("DEV-QA26_METRIC_DOCX_LINUX_SERVICE %s", fmt.Sprintf(`{"compressed_bytes":%d,"ratio":%.1f,"parse_ms":%.2f,"error":%q}`, len(compressed), ratio, float64(elapsed.Microseconds())/1000, err.Error()))
}
