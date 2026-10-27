//go:build windows

package documentparse

import (
	"context"
	"errors"
)

func parseWithLinuxService(context.Context, []byte) ([]byte, error) {
	return nil, errors.New("Linux document parser service is unavailable on Windows")
}
