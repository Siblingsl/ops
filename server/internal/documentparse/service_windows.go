//go:build windows

package documentparse

import (
	"context"
	"errors"
)

func parseWithLinuxService(context.Context, []byte) ([]byte, error) {
	return nil, errors.New("linux document parser service is unavailable on Windows")
}
