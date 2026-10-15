package app

import (
	"bytes"
	"net/http"
	"strings"
)

// 16 文档第 2.3 节「响应处理」：普通接口读取完整响应（最多 1 MB），
// SSE 接口由增量解析器逐个解析事件。两种记录器都实现 http.Flusher。

const agentResponseBytes = 1 << 20

// agentRecorder 是分发器使用的响应记录器。
type agentRecorder interface {
	http.ResponseWriter
	http.Flusher
	Status() int
	Body() []byte
	Events() []agentSSEEvent
}

// ---- 普通 JSON 接口 ----

type agentJSONRecorder struct {
	header      http.Header
	status      int
	wroteHeader bool
	buf         bytes.Buffer
	truncated   bool
}

func newAgentJSONRecorder() *agentJSONRecorder {
	return &agentJSONRecorder{header: http.Header{}, status: http.StatusOK}
}

func (r *agentJSONRecorder) Header() http.Header { return r.header }

func (r *agentJSONRecorder) WriteHeader(code int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = code
}

func (r *agentJSONRecorder) Write(b []byte) (int, error) {
	r.WriteHeader(http.StatusOK)
	if room := agentResponseBytes - r.buf.Len(); room <= 0 {
		r.truncated = true
		return len(b), nil
	} else if len(b) > room {
		_, _ = r.buf.Write(b[:room])
		r.truncated = true
		return len(b), nil
	}
	_, _ = r.buf.Write(b)
	return len(b), nil
}

func (r *agentJSONRecorder) Flush()                  {}
func (r *agentJSONRecorder) Status() int             { return r.status }
func (r *agentJSONRecorder) Body() []byte            { return r.buf.Bytes() }
func (r *agentJSONRecorder) Events() []agentSSEEvent { return nil }

// ---- SSE 接口 ----

type agentSSERecorder struct {
	header      http.Header
	status      int
	wroteHeader bool
	pending     []byte
	events      []agentSSEEvent
	onEvent     func(event string, data []byte) error
	truncated   bool
}

func newAgentSSERecorder(onEvent func(event string, data []byte) error) *agentSSERecorder {
	return &agentSSERecorder{header: http.Header{}, status: http.StatusOK, onEvent: onEvent}
}

func (r *agentSSERecorder) Header() http.Header { return r.header }

func (r *agentSSERecorder) WriteHeader(code int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = code
}

func (r *agentSSERecorder) Write(b []byte) (int, error) {
	r.WriteHeader(http.StatusOK)
	if len(r.pending) < agentResponseBytes {
		r.pending = append(r.pending, b...)
	} else {
		r.truncated = true
	}
	r.parseFrames()
	return len(b), nil
}

// Flush 是空操作：事件在 Write 时即被解析并转发，保证执行卡片能实时看到 step 与 delta。
func (r *agentSSERecorder) Flush() {}

func (r *agentSSERecorder) Status() int { return r.status }

// Body 返回尚未被解析成事件的原始字节；SSE 成功时为空，
// 未进入 SSE 的错误响应（JSON 错误体）则完整保留在这里。
func (r *agentSSERecorder) Body() []byte { return r.pending }

func (r *agentSSERecorder) Events() []agentSSEEvent { return r.events }

func (r *agentSSERecorder) parseFrames() {
	for {
		idx := bytes.Index(r.pending, []byte("\n\n"))
		if idx < 0 {
			return
		}
		frame := r.pending[:idx]
		r.pending = append([]byte(nil), r.pending[idx+2:]...)
		r.handleFrame(frame)
	}
}

func (r *agentSSERecorder) handleFrame(frame []byte) {
	var (
		event string
		data  []byte
	)
	for _, line := range bytes.Split(frame, []byte("\n")) {
		line = bytes.TrimRight(line, "\r")
		switch {
		case bytes.HasPrefix(line, []byte("event:")):
			event = strings.TrimSpace(string(line[len("event:"):]))
		case bytes.HasPrefix(line, []byte("data:")):
			chunk := bytes.TrimSpace(line[len("data:"):])
			if len(data) > 0 {
				data = append(data, '\n')
			}
			data = append(data, chunk...)
		}
	}
	if event == "" {
		return
	}
	cp := append([]byte(nil), data...)
	r.events = append(r.events, agentSSEEvent{Event: event, Data: cp})
	if r.onEvent != nil {
		_ = r.onEvent(event, cp)
	}
}
