package app

import (
	"testing"
)

// BE-02（docs/33 §11.5；agent_recorder.go 批次）：
// bytes.Buffer.Write 为 C 类（契约永不为 err）；截断语义不变。

func TestBE02AgentJSONRecorderTruncatesAtCap(t *testing.T) {
	r := newAgentJSONRecorder()
	big := make([]byte, agentResponseBytes+64)
	for i := range big {
		big[i] = 'a'
	}
	n, err := r.Write(big)
	if err != nil || n != len(big) {
		t.Fatalf("Write 应吞下全量字节并返回 nil，n=%d err=%v", n, err)
	}
	if !r.truncated || r.buf.Len() != agentResponseBytes {
		t.Fatalf("应截断到 %d 且 truncated=true，实际 len=%d truncated=%v", agentResponseBytes, r.buf.Len(), r.truncated)
	}
}
