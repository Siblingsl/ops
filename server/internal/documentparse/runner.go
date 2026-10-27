package documentparse

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

const (
	maxBytes  = 20 << 20
	maxOutput = 256 << 10
	workerArg = "__agent_document_parser"
)

//go:embed parser.wasm
var wasmFS embed.FS
var parserSlots = make(chan struct{}, 2)

type Request struct {
	Name string `json:"name"`
	Data []byte `json:"data"`
}

type Result struct {
	ParserVersion  string `json:"parser_version,omitempty"`
	Text           string `json:"text"`
	Pages          *int   `json:"pages,omitempty"`
	PageBasis      string `json:"page_basis,omitempty"`
	Rows           *int   `json:"rows,omitempty"`
	ExtractedChars int    `json:"extracted_chars"`
	InjectedChars  int    `json:"injected_chars"`
	TruncatedFrom  *int   `json:"truncated_from,omitempty"`
	TruncatedTo    *int   `json:"truncated_to,omitempty"`
	ErrorCode      string `json:"error,omitempty"`
}

type limitedBuffer struct {
	bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.max {
		return 0, errors.New("parser output limit exceeded")
	}
	return b.Buffer.Write(p)
}

// Parse starts a dedicated, networkless WASI parser worker. The document is sent through
// stdin; neither the parent nor the worker exposes a host path to the parser module.
func Parse(ctx context.Context, name string, data []byte) (Result, error) {
	if len(data) == 0 || len(data) > maxBytes {
		return Result{}, errors.New("document size outside parser limit")
	}
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		return Result{}, errors.New("document parser sandbox is unsupported on this operating system")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	select {
	case parserSlots <- struct{}{}:
		defer func() { <-parserSlots }()
	case <-ctx.Done():
		return Result{}, errors.New("document parser capacity timeout")
	}
	payload, err := json.Marshal(Request{Name: name, Data: data})
	if err != nil {
		return Result{}, errors.New("document parser request could not be encoded")
	}
	exe, err := os.Executable()
	if err != nil {
		return Result{}, errors.New("document parser worker is unavailable")
	}
	cmd := exec.CommandContext(ctx, exe, workerArg)
	cmd.Env = []string{}
	configureParserCommand(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Result{}, errors.New("document parser worker is unavailable")
	}
	var stdout limitedBuffer
	var stderr limitedBuffer
	stdout.max = maxOutput
	stderr.max = 4096
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return Result{}, errors.New("document parser worker is unavailable")
	}
	limit, err := limitParserProcess(cmd.Process)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return Result{}, errors.New("document parser resource limit could not be enforced")
	}
	defer limit.Close()
	if _, err := stdin.Write(payload); err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		return Result{}, errors.New("document parser worker did not accept the file")
	}
	if err := stdin.Close(); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return Result{}, errors.New("document parser worker did not accept the file")
	}
	if err := cmd.Wait(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Result{}, errors.New("document parser exceeded its 30 second limit")
		}
		return Result{}, fmt.Errorf("document parser worker failed: %s", strings.TrimSpace(stderr.String()))
	}
	var result Result
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return Result{}, errors.New("document parser returned an invalid receipt")
	}
	if result.ErrorCode != "" {
		return result, fmt.Errorf("document rejected: %s", result.ErrorCode)
	}
	return result, nil
}

// RunWorker is the hidden ops subcommand. The WASI guest gets only stdin/stdout and
// clock/random syscalls: no preopened filesystem and no socket-importing host module.
func RunWorker() error {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, maxBytes*2))
	if err != nil || len(input) == 0 || len(input) > maxBytes*2 {
		return errors.New("invalid parser input")
	}
	if err := setParserWorkerMemoryLimit(); err != nil {
		return errors.New("parser worker memory limit unavailable")
	}
	output, err := runWASI(input)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(output)
	return err
}

func runWASI(input []byte) ([]byte, error) {
	module, err := wasmFS.ReadFile("parser.wasm")
	if err != nil {
		return nil, errors.New("parser module unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	config := wazero.NewRuntimeConfig().WithMemoryLimitPages(4096).WithCloseOnContextDone(true)
	runtime := wazero.NewRuntimeWithConfig(ctx, config)
	defer runtime.Close(ctx)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, runtime); err != nil {
		return nil, errors.New("WASI host unavailable")
	}
	compiled, err := runtime.CompileModule(ctx, module)
	if err != nil {
		return nil, errors.New("parser module could not be compiled")
	}
	for _, fn := range compiled.ImportedFunctions() {
		moduleName, name, _ := fn.Import()
		if strings.Contains(strings.ToLower(moduleName+"/"+name), "sock") || strings.Contains(strings.ToLower(moduleName+"/"+name), "network") {
			return nil, errors.New("parser module requested a forbidden network import")
		}
	}
	var output limitedBuffer
	output.max = maxOutput
	_, err = runtime.InstantiateModule(ctx, compiled, wazero.NewModuleConfig().WithStdin(bytes.NewReader(input)).WithStdout(&output).WithStderr(io.Discard))
	if err != nil {
		return nil, errors.New("parser module failed")
	}
	return output.Bytes(), nil
}
