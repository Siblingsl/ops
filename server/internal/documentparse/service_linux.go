//go:build linux

package documentparse

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
)

var parserEndpointCursor atomic.Uint64
var errParserServiceResponse = errors.New("document parser service returned an invalid response")

func parseWithLinuxService(ctx context.Context, payload []byte) ([]byte, error) {
	var sockets []string
	for _, socket := range strings.Split(os.Getenv("OPS_DOCUMENT_PARSER_SOCKETS"), ",") {
		if socket = strings.TrimSpace(socket); socket != "" {
			sockets = append(sockets, socket)
		}
	}
	if len(sockets) == 0 {
		return nil, errors.New("document parser resource limit unavailable")
	}
	start := int(parserEndpointCursor.Add(1)-1) % len(sockets)
	for i := range sockets {
		output, err := requestParserSocket(ctx, sockets[(start+i)%len(sockets)], payload)
		if err == nil {
			return output, nil
		}
		if errors.Is(err, errParserServiceResponse) {
			return nil, errors.New("document parser failed")
		}
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, errors.New("document parser exceeded its 30 second limit")
			}
			return nil, errors.New("document parser was canceled")
		}
	}
	return nil, errors.New("document parser service unavailable")
}

func requestParserSocket(ctx context.Context, socket string, payload []byte) ([]byte, error) {
	transport := &http.Transport{
		DisableCompression: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://parser/parse", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Transport: transport}).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errParserServiceResponse
	}
	output, err := io.ReadAll(io.LimitReader(response.Body, maxOutput+1))
	if err != nil || len(output) > maxOutput {
		return nil, errParserServiceResponse
	}
	return output, nil
}
