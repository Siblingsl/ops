//go:build windows

package documentparse

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type processLimit struct{ job windows.Handle }

func configureParserCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func limitParserProcess(process *os.Process) (processLimit, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return processLimit{}, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = 0x100 | 0x2000 // PROCESS_MEMORY | KILL_ON_JOB_CLOSE
	info.ProcessMemoryLimit = 256 << 20
	if _, err := windows.SetInformationJobObject(job, 9, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return processLimit{}, err
	}
	processHandle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return processLimit{}, err
	}
	defer windows.CloseHandle(processHandle)
	if err := windows.AssignProcessToJobObject(job, processHandle); err != nil {
		_ = windows.CloseHandle(job)
		return processLimit{}, err
	}
	return processLimit{job: job}, nil
}

func (p processLimit) Close() error { return windows.CloseHandle(p.job) }

func setParserWorkerMemoryLimit() error { return nil }
