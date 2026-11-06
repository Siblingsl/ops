//go:build windows

package documentparse

import (
	"context"
	"errors"
	"sync"
	"unsafe"

	"github.com/tetratelabs/wazero/experimental"
	"golang.org/x/sys/windows"
)

const wasmMemoryPageBytes = uint64(64 << 10)
const maxWASIMemorySliceLen = int(^uint(0) >> 1)

// parserWASIModuleContext avoids Go slice relocation while Wazero grows a guest's
// linear memory. Wazero is pinned in go.mod; revalidate this experimental hook on upgrades.
func parserWASIModuleContext(ctx context.Context) context.Context {
	return experimental.WithMemoryAllocator(ctx, windowsWASIMemoryAllocator{})
}

type windowsWASIMemoryAllocator struct{}

func (windowsWASIMemoryAllocator) Allocate(_ uint64, maximum uint64) experimental.LinearMemory {
	memory := &windowsWASILinearMemory{maximum: maximum}
	if maximum == 0 || maximum%wasmMemoryPageBytes != 0 || maximum > uint64(maxWASIMemorySliceLen) {
		memory.allocationErr = errors.New("invalid WASM memory maximum")
		return memory
	}
	base, err := windows.VirtualAlloc(0, uintptr(maximum), windows.MEM_RESERVE, windows.PAGE_READWRITE)
	if err != nil || base == 0 {
		if err == nil {
			err = errors.New("VirtualAlloc returned a nil reservation")
		}
		memory.allocationErr = err
		return memory
	}
	memory.base = base
	return memory
}

type windowsWASILinearMemory struct {
	mu            sync.Mutex
	base          uintptr
	maximum       uint64
	committed     uint64
	allocationErr error
	freeErr       error
}

func (m *windowsWASILinearMemory) Reallocate(size uint64) []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.base == 0 || size > m.maximum || size%wasmMemoryPageBytes != 0 || size > uint64(maxWASIMemorySliceLen) {
		return nil
	}
	if size > m.committed {
		address := m.base + uintptr(m.committed)
		base, err := windows.VirtualAlloc(address, uintptr(size-m.committed), windows.MEM_COMMIT, windows.PAGE_READWRITE)
		if err != nil || base != address {
			if err == nil {
				err = errors.New("VirtualAlloc committed a different address")
			}
			m.allocationErr = err
			return nil
		}
		m.committed = size
	}
	return unsafe.Slice((*byte)(unsafe.Pointer(m.base)), int(size))
}

func (m *windowsWASILinearMemory) Free() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.base == 0 {
		return
	}
	if err := windows.VirtualFree(m.base, 0, windows.MEM_RELEASE); err != nil {
		m.freeErr = err
	}
	m.base = 0
}
