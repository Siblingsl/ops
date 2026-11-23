package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// REF41 C3 PPTX/DOCX 确定性导出测试：
// - A1 targets/kind 扩展（DB 约束由迁移测试与真实库 \d 复核）；
// - A2 manifest.office（template_version/office_hash/aigc）与同输入同哈希；
// - A3/A4 上传链路复核 AIGC 标记，缺失/无页脚 → 422 不留 artifact。

// c3BuildOfficeArtifact 生成最小合法 Office 产物（ZIP 容器 + AIGC 标记）。
// 固定条目顺序与内容 ⇒ 同输入同字节（测试内确定性口径与渲染器约定一致）。
func c3BuildOfficeArtifact(t *testing.T, kind, footer string) []byte {
	t.Helper()
	core := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description>由 OPS 生成</dc:description></cp:coreProperties>`
	custom := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-docprops" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property name="AIGC" fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2"><vt:bool>true</vt:bool></property></Properties>`
	entries := []struct{ name, body string }{
		{"[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`},
		{"docProps/core.xml", core},
		{"docProps/custom.xml", custom},
	}
	if kind == "docx" {
		entries = append(entries, struct{ name, body string }{"word/footer1.xml",
			`<?xml version="1.0"?><ftr xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><p><r><t>` + footer + `</t></r></p></ftr>`})
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, entry := range entries {
		w, err := zw.Create(entry.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(entry.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// c3StripAIGC 移除 custom.xml 的 AIGC 属性，生成违规产物。
func c3StripAIGC(t *testing.T, data []byte) []byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range zr.File {
		w, _ := zw.Create(f.Name)
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		if f.Name == "docProps/custom.xml" {
			b = []byte(`<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-docprops"/>`)
		}
		w.Write(b)
	}
	zw.Close()
	return buf.Bytes()
}

func c3UploadArtifact(t *testing.T, buildID, kind, name string, data []byte) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("kind", kind)
	_ = mw.WriteField("name", name)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	resp := env.request("POST", "/api/v1/builds/"+buildID+"/artifacts", &buf, mw.FormDataContentType())
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func c3CreateOfficeBuild(t *testing.T, work Work, targets []string) cxBuildCreateResponse {
	return c3CreateOfficeBuildForce(t, work, targets, false)
}

func c3CreateOfficeBuildForce(t *testing.T, work Work, targets []string, force bool) cxBuildCreateResponse {
	t.Helper()
	var created cxBuildCreateResponse
	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": targets, "force": force,
		"client": "web", "renderer_contract_version": cxOfficeTemplateVersion,
	})
	if status != 201 {
		t.Fatalf("create office build: status=%d body=%s", status, body)
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	return created
}

func TestC3AIGCRequiredOnUpload(t *testing.T) {
	// C3-A3/A4：缺 AIGC 属性 / DOCX 无页脚 → 422 office_aigc_missing，无 artifact 落库。
	a := drAccount(t, "xhs", "C3 合规小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C3 合规作品", 900, 1200, []string{"测试"})
	// 缺 AIGC 的 PPTX 被拒，构建随之标 failed（失败不留半成品）。
	rejected := c3CreateOfficeBuild(t, wk, []string{"pptx"})
	status, body := c3UploadArtifact(t, rejected.BuildID.String(), "pptx", "work.pptx", c3StripAIGC(t, c3BuildOfficeArtifact(t, "pptx", "")))
	if status != 422 || !bytes.Contains(body, []byte("office_aigc_missing")) {
		t.Fatalf("missing AIGC must reject: status=%d body=%s", status, body)
	}
	// 失败尝试不留 artifact。
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM work_build_artifact WHERE build_id=$1`, rejected.BuildID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rejected uploads must leave no artifact, got %d", count)
	}
	// 无页脚 DOCX 拒绝（独立 build）。
	rejectedDoc := c3CreateOfficeBuild(t, wk, []string{"docx"})
	status, body = c3UploadArtifact(t, rejectedDoc.BuildID.String(), "docx", "work.docx", c3BuildOfficeArtifact(t, "docx", ""))
	if status != 422 || !bytes.Contains(body, []byte("office_aigc_missing")) {
		t.Fatalf("docx without footer must reject: status=%d body=%s", status, body)
	}
	// 合法 PPTX 与含页脚 DOCX 在新 build 上传成功。
	okBuild := c3CreateOfficeBuild(t, wk, []string{"pptx", "docx"})
	status, _ = c3UploadArtifact(t, okBuild.BuildID.String(), "pptx", "work.pptx", c3BuildOfficeArtifact(t, "pptx", ""))
	if status != 200 {
		t.Fatalf("valid pptx upload: status=%d", status)
	}
	status, _ = c3UploadArtifact(t, okBuild.BuildID.String(), "docx", "work.docx", c3BuildOfficeArtifact(t, "docx", "AI 生成内容"))
	if status != 200 {
		t.Fatalf("valid docx upload: status=%d", status)
	}
}

func TestC3DeterministicSameInputSameHash(t *testing.T) {
	// C3-A2：同输入两次构建上传 → 服务端计算哈希一致（确定性口径）。
	a := drAccount(t, "xhs", "C3 确定性小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C3 确定性作品", 900, 1200, []string{"测试"})
	pptx := c3BuildOfficeArtifact(t, "pptx", "")
	var hashes []string
	for i := 0; i < 2; i++ {
		// 每轮用独立 work（同 work 同 params 会复用 running build，重复上传同名冲突）。
		w := publishTestWork(t, a, "C3 确定性作品轮次 "+itoa(i), 900, 1200, []string{"测试"})
		created := c3CreateOfficeBuild(t, w, []string{"pptx"})
		status, body := c3UploadArtifact(t, created.BuildID.String(), "pptx", "work.pptx", pptx)
		if status != 200 {
			t.Fatalf("upload %d: status=%d body=%s", i, status, body)
		}
		var up struct {
			SHA256 string `json:"sha256"`
		}
		if err := json.Unmarshal(body, &up); err != nil {
			t.Fatal(err)
		}
		hashes = append(hashes, up.SHA256)
	}
	if hashes[0] != hashes[1] {
		t.Fatalf("deterministic export broken: %s vs %s", hashes[0], hashes[1])
	}
	// 不同字节 → 不同哈希（变异内容）。
	other := c3BuildOfficeArtifact(t, "pptx", "")
	other[10] ^= 0xFF
	created := c3CreateOfficeBuild(t, wk, []string{"pptx"})
	_, body := c3UploadArtifact(t, created.BuildID.String(), "pptx", "work.pptx", other)
	var up struct {
		SHA256 string `json:"sha256"`
	}
	_ = json.Unmarshal(body, &up)
	if up.SHA256 == hashes[0] {
		t.Fatal("different content must yield different hash")
	}
}

func TestC3CompleteWritesOfficeManifest(t *testing.T) {
	// C3-A2：complete 后 manifest.office 含 template_version/office_hash/aigc=true。
	a := drAccount(t, "xhs", "C3 manifest小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C3 manifest作品", 900, 1200, []string{"测试"})
	created := c3CreateOfficeBuild(t, wk, []string{"pptx"})
	status, body := c3UploadArtifact(t, created.BuildID.String(), "pptx", "work.pptx", c3BuildOfficeArtifact(t, "pptx", ""))
	if status != 200 {
		t.Fatalf("upload: status=%d body=%s", status, body)
	}
	var up struct {
		ArtifactID string `json:"artifact_id"`
		SHA256     string `json:"sha256"`
	}
	if err := json.Unmarshal(body, &up); err != nil {
		t.Fatal(err)
	}
	var frozen struct {
		SourceHash string `json:"-"`
		ParamsHash string
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT source_hash,params_hash FROM work_build WHERE id=$1`, created.BuildID).
		Scan(&frozen.SourceHash, &frozen.ParamsHash); err != nil {
		t.Fatal(err)
	}
	compStatus, compBody := env.do("POST", "/api/v1/builds/"+created.BuildID.String()+"/complete", map[string]any{
		"source_hash": frozen.SourceHash, "params_hash": frozen.ParamsHash,
		"artifacts": []map[string]any{{"artifact_id": up.ArtifactID, "kind": "pptx", "name": "work.pptx"}},
		"renderer_receipt": map[string]any{"client": "web", "application_version": "test",
			"renderer_contract_version": cxOfficeTemplateVersion, "chromium_version": "test",
			"font_family": "test-font", "device_scale_factor": 1, "viewport_width": 1280, "viewport_height": 800},
	})
	if compStatus != 200 {
		t.Fatalf("complete: status=%d body=%s", compStatus, compBody)
	}
	var manifest struct {
		Manifest struct {
			Office struct {
				TemplateVersion string `json:"template_version"`
				OfficeHash      string `json:"office_hash"`
				AIGC            bool   `json:"aigc"`
			} `json:"office"`
		} `json:"manifest"`
	}
	if err := json.Unmarshal(compBody, &manifest); err != nil {
		t.Fatal(err)
	}
	office := manifest.Manifest.Office
	if office.TemplateVersion != cxOfficeTemplateVersion || !office.AIGC || office.OfficeHash != up.SHA256 {
		t.Fatalf("manifest.office wrong: %+v (want hash %s)", office, up.SHA256)
	}
}

func c3RenderOffice(t *testing.T, buildID, target string) (cxOfficeRenderResponse, []byte) {
	t.Helper()
	var response cxOfficeRenderResponse
	status, body := env.do("POST", "/api/v1/builds/"+buildID+"/office-render", map[string]string{"target": target})
	if status != 200 {
		t.Fatalf("office-render %s: status=%d body=%s", target, status, body)
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	var storagePath string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT storage_path FROM work_build_artifact WHERE id=$1`, response.ArtifactID).Scan(&storagePath); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storagePath)))
	if err != nil {
		t.Fatal(err)
	}
	return response, data
}

func c3OfficeEntries(t *testing.T, data []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		entries[f.Name] = string(content)
	}
	return entries
}

func c3AssertOfficeCoreDescription(t *testing.T, kind string, entries map[string]string) {
	t.Helper()
	core := entries["docProps/core.xml"]
	if !strings.Contains(core, "<dc:description>由 OPS 生成</dc:description>") {
		t.Fatalf("%s core.xml must carry dc:description“由 OPS 生成”: %s", kind, core)
	}
	if strings.Contains(core, "<dc:subject>由 OPS 生成</dc:subject>") {
		t.Fatalf("%s core.xml must not use dc:subject for the OPS declaration: %s", kind, core)
	}
}

func c3AssertOfficeContent(t *testing.T, kind string, data []byte) {
	t.Helper()
	entries := c3OfficeEntries(t, data)
	if !strings.Contains(entries["docProps/custom.xml"], `name="AIGC"`) {
		t.Fatalf("%s missing AIGC custom property", kind)
	}
	c3AssertOfficeCoreDescription(t, kind, entries)
	if strings.Contains(entries["docProps/core.xml"], "{{REVISION}}") {
		t.Fatalf("%s revision placeholder not replaced", kind)
	}
	if kind == "docx" && !strings.Contains(entries["word/footer1.xml"], "AI 生成内容") {
		t.Fatalf("docx missing AIGC footer")
	}
	var xml strings.Builder
	for name, content := range entries {
		if strings.HasSuffix(name, ".xml") || strings.HasSuffix(name, ".rels") {
			xml.WriteString(content)
		}
	}
	if strings.Contains(xml.String(), "{{TITLE}}") || strings.Contains(xml.String(), "{{BODY}}") {
		t.Fatalf("%s contains unresolved placeholders", kind)
	}
	if !strings.Contains(xml.String(), "C3 Node 渲染作品") || !strings.Contains(xml.String(), "正文：这是发布正文") {
		t.Fatalf("%s missing rendered title/body", kind)
	}
}

func c3AssertOfficeCover(t *testing.T, kind string, data []byte) {
	t.Helper()
	entries := c3OfficeEntries(t, data)
	switch kind {
	case "pptx":
		if !c3HasEntryPrefix(entries, "ppt/media/cover-") {
			t.Fatalf("pptx missing embedded cover media: %v", c3EntryNames(entries))
		}
		if !strings.Contains(entries["ppt/slides/slide1.xml"], `<p:pic>`) ||
			!strings.Contains(entries["ppt/slides/slide1.xml"], `r:embed="rId3"`) {
			t.Fatalf("pptx cover slide missing picture relationship")
		}
		if !strings.Contains(entries["ppt/slides/_rels/slide1.xml.rels"], `Id="rId3"`) ||
			!strings.Contains(entries["ppt/slides/_rels/slide1.xml.rels"], `../media/cover-`) {
			t.Fatalf("pptx cover relationship missing")
		}
		if !strings.Contains(entries["ppt/slides/slide1.xml"], `cx="6200000"`) {
			t.Fatalf("pptx cover slide title box was not narrowed")
		}
	case "docx":
		if !c3HasEntryPrefix(entries, "word/media/cover-") {
			t.Fatalf("docx missing embedded cover media: %v", c3EntryNames(entries))
		}
		if !strings.Contains(entries["word/document.xml"], `<w:drawing>`) ||
			!strings.Contains(entries["word/document.xml"], `r:embed="rId9"`) {
			t.Fatalf("docx missing drawing relationship")
		}
		if !strings.Contains(entries["word/_rels/document.xml.rels"], `Id="rId9"`) ||
			!strings.Contains(entries["word/_rels/document.xml.rels"], `media/cover-`) {
			t.Fatalf("docx cover relationship missing")
		}
		if !strings.Contains(entries["word/document.xml"], `<w:br w:type="page"/>`) {
			t.Fatalf("docx cover page break missing")
		}
	}
}

func c3HasEntryPrefix(entries map[string]string, prefix string) bool {
	for name := range entries {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func c3EntryNames(entries map[string]string) []string {
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	return names
}

func TestC3NodeRendererDeterministicAndAIGC(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("本机没有 node，跳过真实渲染器用例")
	}
	a := drAccount(t, "xhs", "C3 Node 渲染小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C3 Node 渲染作品", 900, 1200, []string{"测试"})
	first := c3CreateOfficeBuild(t, wk, []string{"pptx", "docx"})
	pptx1, pptxBytes1 := c3RenderOffice(t, first.BuildID.String(), "pptx")
	// 同一 build 重复请求必须幂等，不产生第二个产物/不换哈希。
	pptxAgain, _ := c3RenderOffice(t, first.BuildID.String(), "pptx")
	if pptxAgain.ArtifactID != pptx1.ArtifactID || pptxAgain.SHA256 != pptx1.SHA256 {
		t.Fatalf("same build render not idempotent: %+v vs %+v", pptx1, pptxAgain)
	}
	if !strings.HasPrefix(pptx1.Name, "c3-node-渲染作品-") || !strings.HasSuffix(pptx1.Name, ".pptx") {
		t.Fatalf("pptx name: %s", pptx1.Name)
	}
	c3AssertOfficeContent(t, "pptx", pptxBytes1)
	c3AssertOfficeCover(t, "pptx", pptxBytes1)
	docx1, docxBytes1 := c3RenderOffice(t, first.BuildID.String(), "docx")
	if !strings.HasPrefix(docx1.Name, "c3-node-渲染作品-") || !strings.HasSuffix(docx1.Name, ".docx") {
		t.Fatalf("docx name: %s", docx1.Name)
	}
	c3AssertOfficeContent(t, "docx", docxBytes1)
	c3AssertOfficeCover(t, "docx", docxBytes1)

	// 同作品、同 revision、同参数的新 build：强制建新行后输出哈希一致。
	second := c3CreateOfficeBuildForce(t, wk, []string{"pptx"}, true)
	pptx2, _ := c3RenderOffice(t, second.BuildID.String(), "pptx")
	if pptx2.SHA256 != pptx1.SHA256 {
		t.Fatalf("same revision/params must share hash: %s vs %s", pptx1.SHA256, pptx2.SHA256)
	}
}

func TestC3NodeRendererRevisionChangesHash(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("本机没有 node，跳过真实渲染器用例")
	}
	rendererDir, nodePath, err := env.srv.cxOfficeRenderer()
	if err != nil {
		t.Fatal(err)
	}
	render := func(revision int) (string, []byte) {
		payload, err := json.Marshal(cxOfficeRenderRequest{
			Target: "pptx", Template: "deck-v1", Title: "C3 版本哈希作品", Subtitle: "由 OPS 生成",
			Body: "同正文", Meta: map[string]any{"revision": revision, "aigc": true},
		})
		if err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(t.TempDir(), fmt.Sprintf("revision-%d.pptx", revision))
		cmd := exec.Command(nodePath, filepath.Join(rendererDir, "render.mjs"), "--out", out)
		cmd.Dir = rendererDir
		cmd.Stdin = bytes.NewReader(payload)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("render revision %d: %v %s", revision, err, output)
		}
		bytesOut, err := os.ReadFile(out)
		if err != nil {
			t.Fatal(err)
		}
		return cxSHA256(bytesOut), bytesOut
	}
	hash7, data7 := render(7)
	hash8, data8 := render(8)
	if hash7 == hash8 {
		t.Fatalf("different revisions must differ, both %s", hash7)
	}
	c3AssertOfficeContentWithoutTitle(t, "pptx", data7)
	c3AssertOfficeContentWithoutTitle(t, "pptx", data8)
	if c3HasEntryPrefix(c3OfficeEntries(t, data7), "ppt/media/cover-") {
		t.Fatal("handcrafted request without cover must not embed media")
	}
}

// TestC3OfficeRenderFailsWhenCoverAssetMissing 验证封面资产在构建后被移除时，
// 导出明确失败且不留 artifact；不静默退回无封面产物。
func TestC3OfficeRenderFailsWhenCoverAssetMissing(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("本机没有 node，跳过真实渲染器用例")
	}
	a := drAccount(t, "xhs", "C3 封面缺失小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C3 封面缺失作品", 900, 1200, []string{"测试"})
	if wk.CoverAssetID == nil {
		t.Fatal("测试作品缺少封面资产")
	}
	build := c3CreateOfficeBuild(t, wk, []string{"pptx"})
	var storagePath string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT storage_path FROM asset WHERE id=$1`, *wk.CoverAssetID).Scan(&storagePath); err != nil {
		t.Fatal(err)
	}
	fullPath := filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storagePath))
	backupPath := fullPath + ".c3-missing-test"
	if err := os.Rename(fullPath, backupPath); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Rename(backupPath, fullPath) }()
	status, body := env.do("POST", "/api/v1/builds/"+build.BuildID.String()+"/office-render", map[string]string{"target": "pptx"})
	if status != 409 || !bytes.Contains(body, []byte("asset_unavailable")) {
		t.Fatalf("missing cover asset: status=%d body=%s", status, body)
	}
	var buildStatus, errorCode string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status,coalesce(error_code,'') FROM work_build WHERE id=$1`, build.BuildID).Scan(&buildStatus, &errorCode); err != nil {
		t.Fatal(err)
	}
	if buildStatus != "failed" || errorCode != "asset_unavailable" {
		t.Fatalf("build after missing cover: status=%s error_code=%s", buildStatus, errorCode)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM work_build_artifact WHERE build_id=$1`, build.BuildID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("missing cover must leave no artifact, got %d", count)
	}
}

func c3AssertOfficeContentWithoutTitle(t *testing.T, kind string, data []byte) {
	t.Helper()
	entries := c3OfficeEntries(t, data)
	if !strings.Contains(entries["docProps/custom.xml"], `name="AIGC"`) {
		t.Fatalf("%s missing AIGC custom property", kind)
	}
	c3AssertOfficeCoreDescription(t, kind, entries)
}
func TestC3CompleteWritesDualOfficeManifestHash(t *testing.T) {
	// C3-D5：pptx+docx 双选时 office_hash 必须覆盖两个产物，而不是只记首个 pptx。
	a := drAccount(t, "xhs", "C3 双产物小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C3 双产物作品", 900, 1200, []string{"测试"})
	created := c3CreateOfficeBuild(t, wk, []string{"pptx", "docx"})

	upload := func(kind, name string, data []byte) (string, string) {
		t.Helper()
		status, body := c3UploadArtifact(t, created.BuildID.String(), kind, name, data)
		if status != 200 {
			t.Fatalf("upload %s: status=%d body=%s", kind, status, body)
		}
		var up struct {
			ArtifactID string `json:"artifact_id"`
			SHA256     string `json:"sha256"`
		}
		if err := json.Unmarshal(body, &up); err != nil {
			t.Fatal(err)
		}
		return up.ArtifactID, up.SHA256
	}
	pptxID, pptxHash := upload("pptx", "work.pptx", c3BuildOfficeArtifact(t, "pptx", ""))
	docxID, docxHash := upload("docx", "work.docx", c3BuildOfficeArtifact(t, "docx", "AI 生成内容"))

	var sourceHash, paramsHash string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT source_hash,params_hash FROM work_build WHERE id=$1`, created.BuildID).
		Scan(&sourceHash, &paramsHash); err != nil {
		t.Fatal(err)
	}
	compStatus, compBody := env.do("POST", "/api/v1/builds/"+created.BuildID.String()+"/complete", map[string]any{
		"source_hash": sourceHash, "params_hash": paramsHash,
		"artifacts": []map[string]any{
			{"artifact_id": pptxID, "kind": "pptx", "name": "work.pptx"},
			{"artifact_id": docxID, "kind": "docx", "name": "work.docx"},
		},
		"renderer_receipt": map[string]any{"client": "web", "application_version": "test",
			"renderer_contract_version": cxOfficeTemplateVersion, "chromium_version": "test",
			"font_family": "test-font", "device_scale_factor": 1, "viewport_width": 1280, "viewport_height": 800},
	})
	if compStatus != 200 {
		t.Fatalf("complete dual office: status=%d body=%s", compStatus, compBody)
	}
	var manifest struct {
		Manifest struct {
			Office struct {
				OfficeHash string `json:"office_hash"`
			} `json:"office"`
		} `json:"manifest"`
	}
	if err := json.Unmarshal(compBody, &manifest); err != nil {
		t.Fatal(err)
	}
	want := cxOfficeManifestHash([]cxBuildArtifact{
		{Kind: "pptx", SHA256: pptxHash},
		{Kind: "docx", SHA256: docxHash},
	}, []string{"pptx", "docx"})
	if manifest.Manifest.Office.OfficeHash != want {
		t.Fatalf("dual office_hash must cover both artifacts: got %s want %s", manifest.Manifest.Office.OfficeHash, want)
	}
	if want == pptxHash {
		t.Fatal("dual office_hash must not be the first pptx hash only")
	}
}

func TestC3CompleteRejectsTamperedOfficeArtifact(t *testing.T) {
	// C3-D4：complete 阶段实际错误码为 artifact_hash_mismatch；被篡改产物必须失败。
	a := drAccount(t, "xhs", "C3 篡改产物小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C3 篡改产物作品", 900, 1200, []string{"测试"})
	created := c3CreateOfficeBuild(t, wk, []string{"pptx"})
	status, body := c3UploadArtifact(t, created.BuildID.String(), "pptx", "work.pptx", c3BuildOfficeArtifact(t, "pptx", ""))
	if status != 200 {
		t.Fatalf("upload: status=%d body=%s", status, body)
	}
	var up struct {
		ArtifactID string `json:"artifact_id"`
	}
	if err := json.Unmarshal(body, &up); err != nil {
		t.Fatal(err)
	}
	var storagePath, sourceHash, paramsHash string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT storage_path FROM work_build_artifact WHERE id=$1`, up.ArtifactID).Scan(&storagePath); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT source_hash,params_hash FROM work_build WHERE id=$1`, created.BuildID).
		Scan(&sourceHash, &paramsHash); err != nil {
		t.Fatal(err)
	}
	fullPath := filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storagePath))
	data, err := os.ReadFile(fullPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 {
		t.Fatal("artifact file must not be empty")
	}
	data[len(data)-1] ^= 0xFF
	if err := os.WriteFile(fullPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	compStatus, compBody := env.do("POST", "/api/v1/builds/"+created.BuildID.String()+"/complete", map[string]any{
		"source_hash": sourceHash, "params_hash": paramsHash,
		"artifacts": []map[string]any{{"artifact_id": up.ArtifactID, "kind": "pptx", "name": "work.pptx"}},
		"renderer_receipt": map[string]any{"client": "web", "application_version": "test",
			"renderer_contract_version": cxOfficeTemplateVersion, "chromium_version": "test",
			"font_family": "test-font", "device_scale_factor": 1, "viewport_width": 1280, "viewport_height": 800},
	})
	if compStatus != 422 || !bytes.Contains(compBody, []byte("artifact_hash_mismatch")) {
		t.Fatalf("tampered artifact must fail with artifact_hash_mismatch: status=%d body=%s", compStatus, compBody)
	}
	var buildStatus, errorCode string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status,coalesce(error_code,'') FROM work_build WHERE id=$1`, created.BuildID).
		Scan(&buildStatus, &errorCode); err != nil {
		t.Fatal(err)
	}
	if buildStatus != "failed" || errorCode != "artifact_hash_mismatch" {
		t.Fatalf("build should record artifact_hash_mismatch: status=%s code=%s", buildStatus, errorCode)
	}
}

func TestC3NodeRendererMissingFailsCleanly(t *testing.T) {
	// C3-A5：渲染器目录不存在 → 构建明确失败，不写 artifact。
	a := drAccount(t, "xhs", "C3 缺渲染器小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C3 缺渲染器作品", 900, 1200, []string{"测试"})
	created := c3CreateOfficeBuild(t, wk, []string{"pptx"})
	original := env.srv.cfg.OfficeRenderDir
	env.srv.cfg.OfficeRenderDir = filepath.Join(t.TempDir(), "missing-office-render")
	t.Cleanup(func() { env.srv.cfg.OfficeRenderDir = original })
	status, body := env.do("POST", "/api/v1/builds/"+created.BuildID.String()+"/office-render", map[string]string{"target": "pptx"})
	if status != http.StatusServiceUnavailable || !bytes.Contains(body, []byte("office_renderer_unavailable")) {
		t.Fatalf("missing renderer: status=%d body=%s", status, body)
	}
	var buildStatus, errorCode string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status,coalesce(error_code,'') FROM work_build WHERE id=$1`, created.BuildID).
		Scan(&buildStatus, &errorCode); err != nil {
		t.Fatal(err)
	}
	if buildStatus != "failed" || errorCode != "office_renderer_unavailable" {
		t.Fatalf("build should fail cleanly: status=%s code=%s", buildStatus, errorCode)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM work_build_artifact WHERE build_id=$1`, created.BuildID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("missing renderer must not leave artifact, got %d", count)
	}
}
