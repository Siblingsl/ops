package documentparse

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const parserServiceSlotCount = 1

// ServeParser exposes the WASI parser on a private Unix socket. The caller must
// place this process in the memory-limited container that owns the socket.
func ServeParser(ctx context.Context) error {
	socket := os.Getenv("OPS_DOCUMENT_PARSER_SOCKET")
	if socket == "" {
		return errors.New("OPS_DOCUMENT_PARSER_SOCKET is required")
	}
	if err := os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
		return errors.New("document parser socket directory is unavailable")
	}
	if info, err := os.Lstat(socket); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("document parser socket path is not a socket")
		}
		if err := os.Remove(socket); err != nil {
			return errors.New("stale document parser socket could not be removed")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("document parser socket is unavailable")
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return errors.New("document parser socket could not be created")
	}
	defer func() {
		_ = listener.Close()
		_ = os.Remove(socket)
	}()
	if err := os.Chmod(socket, 0660); err != nil {
		return errors.New("document parser socket permissions could not be set")
	}

	server := &http.Server{
		Handler:           parserServiceHandler(),
		ReadHeaderTimeout: 5 * time.Second,
		MaxHeaderBytes:    4 << 10,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return errors.New("document parser service stopped unexpectedly")
	}
	return nil
}

func parserServiceHandler() http.Handler {
	var slot = make(chan struct{}, parserServiceSlotCount)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /parse", func(w http.ResponseWriter, r *http.Request) {
		select {
		case slot <- struct{}{}:
			defer func() { <-slot }()
		case <-r.Context().Done():
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes*2))
		if err != nil || len(body) == 0 {
			http.Error(w, "invalid parser request", http.StatusBadRequest)
			return
		}
		var request Request
		if err := json.Unmarshal(body, &request); err != nil || len(request.Data) == 0 || len(request.Data) > maxBytes {
			http.Error(w, "invalid parser request", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		output, err := runWASIContext(ctx, body)
		if err != nil {
			http.Error(w, "document parser failed", http.StatusUnprocessableEntity)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(output)
	})
	return mux
}
