package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func opt16Docker(t *testing.T, args ...string) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v %s", args[0], err, out)
	}
	return out
}

func TestOPT16ProductionContainerLimitsAndLogRotation(t *testing.T) {
	var config struct {
		Services map[string]struct {
			Memory  int64   `json:"mem_limit,string"`
			CPUs    float64 `json:"cpus"`
			Logging struct {
				Driver  string            `json:"driver"`
				Options map[string]string `json:"options"`
			} `json:"logging"`
		} `json:"services"`
	}
	raw := opt16Docker(t, "compose", "--env-file", "../../../deploy/.env.example", "-p", "ops-prod-e2e",
		"-f", "../../../deploy/docker-compose.prod.yml", "-f", "../../../deploy/docker-compose.e2e.yml", "config", "--format", "json")
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "log-test.yml")
	if err := os.WriteFile(file, []byte(`services:
  app:
    image: postgres:16-alpine
    volumes: !reset []
    healthcheck:
      disable: true
  postgres:
    volumes: !reset []
    healthcheck:
      disable: true
`), 0600); err != nil {
		t.Fatal(err)
	}
	compose := []string{"compose", "--env-file", "../../../deploy/.env.example", "-p", "ops-opt16-" + uuid.NewString()[:8],
		"-f", "../../../deploy/docker-compose.prod.yml", "-f", "../../../deploy/docker-compose.e2e.yml", "-f", file}
	t.Cleanup(func() {
		args := append(append([]string{}, compose...), "down")
		if out, err := exec.Command("docker", args...).CombinedOutput(); err != nil {
			t.Errorf("remove test Compose network: %v %s", err, out)
		}
	})
	for _, service := range []string{"app", "postgres"} {
		t.Run(service, func(t *testing.T) {
			cfg, ok := config.Services[service]
			if !ok || cfg.Memory != 1<<30 || cfg.CPUs != 1 || cfg.Logging.Driver != "json-file" || cfg.Logging.Options["max-size"] != "10m" || cfg.Logging.Options["max-file"] != "3" {
				t.Fatalf("resource/log limits missing for %s", service)
			}
			name := "ops-opt16-" + service + "-" + uuid.NewString()[:8]
			args := append(append([]string{}, compose...), "run", "-d", "--no-deps", "--name", name, "--entrypoint", "sh", service, "-c",
				`awk 'BEGIN { for (i=0; i<100000; i++) printf "%0479d\n", i; }'; touch /tmp/opt16-done; sleep 300`)
			opt16Docker(t, args...)
			t.Cleanup(func() {
				if out, err := exec.Command("docker", "rm", "-f", name).CombinedOutput(); err != nil {
					t.Errorf("remove test container: %v %s", err, out)
				}
			})
			id := strings.TrimSpace(string(opt16Docker(t, "inspect", "--format", "{{.Id}}", name)))
			var actual struct {
				Memory    int64
				NanoCPUs  int64
				LogConfig struct {
					Type   string
					Config map[string]string
				}
			}
			if err := json.Unmarshal(opt16Docker(t, "inspect", "--format", "{{json .HostConfig}}", name), &actual); err != nil {
				t.Fatal(err)
			}
			if actual.Memory != cfg.Memory || actual.NanoCPUs != int64(cfg.CPUs*1e9) || actual.LogConfig.Type != "json-file" || actual.LogConfig.Config["max-size"] != "10m" || actual.LogConfig.Config["max-file"] != "3" {
				t.Fatal("Docker runtime limits do not match Compose")
			}
			deadline := time.Now().Add(30 * time.Second)
			for {
				if exec.Command("docker", "exec", name, "test", "-f", "/tmp/opt16-done").Run() == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("continuous log writer did not finish")
				}
				time.Sleep(50 * time.Millisecond)
			}
			logFile := strings.TrimSpace(string(opt16Docker(t, "inspect", "--format", "{{.LogPath}}", name)))
			if len(id) != 64 || path.Base(path.Dir(logFile)) != id || path.Base(logFile) != id+"-json.log" {
				t.Fatal("log path does not belong to this test container")
			}
			out := string(opt16Docker(t, "run", "--rm", "--mount", "type=bind,source="+path.Dir(logFile)+",target=/logs,readonly",
				"postgres:16-alpine", "sh", "-c", `wc -c /logs/*-json.log*`))
			lines := strings.Split(strings.TrimSpace(out), "\n")
			last := strings.Fields(lines[len(lines)-1])
			if len(lines) != 4 || len(last) != 2 || last[1] != "total" {
				t.Fatalf("expected three rotated log files: %s", out)
			}
			bytes, err := strconv.ParseInt(last[0], 10, 64)
			if err != nil || bytes > 30_000_000 {
				t.Fatalf("log total exceeds 30MB: %d err=%v", bytes, err)
			}
			t.Logf("Compose/Docker inspect: memory=%d CPU=%.0f json-file=10m/3; 100000 lines (48MB raw), retained 3 files %d bytes", actual.Memory, cfg.CPUs, bytes)
		})
	}
}
