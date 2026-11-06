//go:build !windows && !linux

package documentparse

import "context"

func parserWASIModuleContext(ctx context.Context) context.Context { return ctx }
