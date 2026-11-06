//go:build windows

package documentparse

import (
	"testing"
	"unsafe"
)

func TestWindowsWASIMemoryAllocatorGrowthAndLimits(t *testing.T) {
	const page = uint64(64 << 10)
	allocator := windowsWASIMemoryAllocator{}
	linear := allocator.Allocate(page, 2*page).(*windowsWASILinearMemory)
	defer linear.Free()

	first := linear.Reallocate(page)
	if len(first) != int(page) {
		t.Fatalf("initial page length = %d, want %d", len(first), page)
	}
	base := unsafe.SliceData(first)
	for i, value := range first {
		if value != 0 {
			t.Fatalf("initial page byte %d was not zeroed", i)
		}
	}
	first[len(first)-1] = 0x7b

	grown := linear.Reallocate(2 * page)
	if len(grown) != int(2*page) || unsafe.SliceData(grown) != base {
		t.Fatalf("grown memory moved or has wrong length: len=%d", len(grown))
	}
	if grown[len(first)-1] != 0x7b {
		t.Fatal("growth did not preserve existing linear memory")
	}
	for i, value := range grown[len(first):] {
		if value != 0 {
			t.Fatalf("new page byte %d was not zeroed", i)
		}
	}
	if overLimit := linear.Reallocate(3 * page); overLimit != nil {
		t.Fatalf("growth past maximum returned %d bytes", len(overLimit))
	}
	if linear.committed != 2*page {
		t.Fatalf("over-limit request changed committed size to %d", linear.committed)
	}
	linear.Free()
	linear.Free()
	if linear.base != 0 || linear.freeErr != nil {
		t.Fatalf("memory was not released cleanly: base=%x err=%v", linear.base, linear.freeErr)
	}
}
