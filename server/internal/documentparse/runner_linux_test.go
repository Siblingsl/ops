//go:build linux

package documentparse

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
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
