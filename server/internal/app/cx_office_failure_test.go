package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func c3FakeRenderer(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "render.mjs"), []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func c3AssertFailedBuildWithoutArtifact(t *testing.T, buildID uuid.UUID, wantCode string) {
	t.Helper()
	var status, code string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status,coalesce(error_code,'') FROM work_build WHERE id=$1`, buildID).
		Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != wantCode {
		t.Fatalf("build should fail with %s: status=%s code=%s", wantCode, status, code)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM work_build_artifact WHERE build_id=$1`, buildID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("failed render must leave no artifact, got %d", count)
	}
}

func c3OfficeTempDirs(t *testing.T) map[string]bool {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(os.TempDir(), "ops-office-render-*"))
	if err != nil {
		t.Fatal(err)
	}
	set := map[string]bool{}
	for _, match := range matches {
		set[match] = true
	}
	return set
}

func c3AssertNoNewOfficeTempDirs(t *testing.T, before map[string]bool) {
	t.Helper()
	after, err := filepath.Glob(filepath.Join(os.TempDir(), "ops-office-render-*"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range after {
		if !before[path] {
			t.Fatalf("office render temp dir was not cleaned: %s", path)
		}
	}
}

// TestC3OfficeRendererFailureBranches 覆盖 D-2：
// 渲染器非零退出、超时、空产物、非法 ZIP、node 缺失，以及临时目录清理。
func TestC3OfficeRendererFailureBranches(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("本机没有 node，跳过真实渲染器失败分支")
	}
	a := drAccount(t, "xhs", "C3 失败分支小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C3 失败分支作品", 900, 1200, []string{"测试"})

	originalDir := env.srv.cfg.OfficeRenderDir
	originalTimeout := cxOfficeRenderTimeout
	t.Cleanup(func() {
		env.srv.cfg.OfficeRenderDir = originalDir
		cxOfficeRenderTimeout = originalTimeout
	})

	cases := []struct {
		name        string
		script      string
		timeout     time.Duration
		wantStatus  int
		wantCode    string
		wantMessage string
	}{
		{
			name:        "exit_nonzero",
			script:      `process.stderr.write("fake renderer exit\n"); process.exit(7)`,
			wantStatus:  500,
			wantCode:    "office_render_failed",
			wantMessage: "执行失败",
		},
		{
			name:        "timeout",
			script:      `setTimeout(() => {}, 5000)`,
			timeout:     50 * time.Millisecond,
			wantStatus:  500,
			wantCode:    "office_render_failed",
			wantMessage: "执行超时",
		},
		{
			name:        "empty_output",
			script:      `import fs from "node:fs"; const out = process.argv[process.argv.indexOf("--out") + 1]; fs.writeFileSync(out, "")`,
			wantStatus:  500,
			wantCode:    "office_render_failed",
			wantMessage: "没有生成有效产物",
		},
		{
			name:        "invalid_output",
			script:      `import fs from "node:fs"; const out = process.argv[process.argv.indexOf("--out") + 1]; fs.writeFileSync(out, "not-a-zip")`,
			wantStatus:  422,
			wantCode:    "office_render_failed",
			wantMessage: "未通过 AIGC/格式校验",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env.srv.cfg.OfficeRenderDir = c3FakeRenderer(t, tc.script)
			cxOfficeRenderTimeout = tc.timeout
			if cxOfficeRenderTimeout == 0 {
				cxOfficeRenderTimeout = 30 * time.Second
			}
			created := c3CreateOfficeBuildForce(t, wk, []string{"pptx"}, true)
			beforeTemp := c3OfficeTempDirs(t)
			status, body := env.do("POST", "/api/v1/builds/"+created.BuildID.String()+"/office-render", map[string]string{"target": "pptx"})
			if status != tc.wantStatus || !bytes.Contains(body, []byte(tc.wantCode)) || !bytes.Contains(body, []byte(tc.wantMessage)) {
				t.Fatalf("%s: status=%d body=%s", tc.name, status, body)
			}
			c3AssertFailedBuildWithoutArtifact(t, created.BuildID, tc.wantCode)
			c3AssertNoNewOfficeTempDirs(t, beforeTemp)
		})
	}

	t.Run("node_missing", func(t *testing.T) {
		env.srv.cfg.OfficeRenderDir = c3FakeRenderer(t, `process.exit(0)`)
		t.Setenv("PATH", t.TempDir())
		created := c3CreateOfficeBuildForce(t, wk, []string{"pptx"}, true)
		beforeTemp := c3OfficeTempDirs(t)
		status, body := env.do("POST", "/api/v1/builds/"+created.BuildID.String()+"/office-render", map[string]string{"target": "pptx"})
		if status != 503 || !bytes.Contains(body, []byte("office_renderer_unavailable")) {
			t.Fatalf("node missing: status=%d body=%s", status, body)
		}
		c3AssertFailedBuildWithoutArtifact(t, created.BuildID, "office_renderer_unavailable")
		c3AssertNoNewOfficeTempDirs(t, beforeTemp)
	})
}

func c3CopyFile(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// c3RewriteTemplateCore 把模板 core.xml 的 dc:description 改为 dc:subject，
// 用来验证 render.mjs 自身会在输出前拒绝缺少规范 description 的模板。
func c3RewriteTemplateCore(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, file := range zr.File {
		w, err := zw.Create(file.Name)
		if err != nil {
			t.Fatal(err)
		}
		rc, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		if file.Name == "docProps/core.xml" {
			content = bytes.ReplaceAll(content,
				[]byte("<dc:description>由 OPS 生成</dc:description>"),
				[]byte("<dc:subject>由 OPS 生成</dc:subject>"))
		}
		if _, err := w.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestC3RendererRejectsMissingCoreDescription(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("本机没有 node，跳过真实渲染器模板校验")
	}
	rendererDir, nodePath, err := env.srv.cxOfficeRenderer()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for _, name := range []string{"render.mjs", "zip.mjs"} {
		c3CopyFile(t, filepath.Join(rendererDir, name), filepath.Join(root, name))
	}
	templatesDir := filepath.Join(root, "templates")
	if err := os.MkdirAll(templatesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	badTemplate := filepath.Join(templatesDir, "deck-v1.pptx")
	c3RewriteTemplateCore(t, filepath.Join(rendererDir, "templates", "deck-v1.pptx"), badTemplate)

	payload, err := json.Marshal(cxOfficeRenderRequest{
		Target: "pptx", Template: "deck-v1", Title: "C3 D6 坏模板",
		Subtitle: "由 OPS 生成", Body: "正文", Meta: map[string]any{"revision": 1, "aigc": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "bad.pptx")
	cmd := exec.Command(nodePath, filepath.Join(root, "render.mjs"), "--out", out)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(payload)
	output, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("renderer must reject core description-less template, output=%s", output)
	}
	if !strings.Contains(string(output), "核心属性") {
		t.Fatalf("renderer rejection should mention core property: %s", output)
	}
	if _, statErr := os.Stat(out); !os.IsNotExist(statErr) {
		t.Fatalf("renderer must not leave output on validation failure: %v", statErr)
	}
}
