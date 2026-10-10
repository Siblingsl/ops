package app

import (
	"bytes"
	"io"
	"net/http"
)

// Each operation handles one object; even bodyless actions reject arrays before any side effect.
func (s *Server) v4Object(fn handlerFunc) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		if r.Body != nil {
			b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
			if e != nil {
				return apiErr(400, "invalid_request", "请求过大或格式不正确")
			}
			trim := bytes.TrimSpace(b)
			if len(trim) > 0 && trim[0] != '{' {
				return apiErr(400, "invalid_request", "每次操作只接受一个对象")
			}
			r.Body = io.NopCloser(bytes.NewReader(b))
		}
		return fn(w, r)
	}
}
