package app

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"io"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ops/internal/cxbuildvalidate"
	"ops/internal/cxcanonicaljson"
)

// DEV-CX12 / FR-CX-05 / T-CX05 补齐验收：evidence.csv 完整链路（manifest 绑定 + 权限门禁）、
// 跨作品资产阻断、封面不混入正文图片计数。

// cxEvidenceSeedWork 建 3 段 5 图（含一张图重复出现）的稿件并冻结快照，返回构建与期望顺序。
func cxEvidenceSeedWork(t *testing.T, title string) (Work, []uuid.UUID) {
	t.Helper()
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": title}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"viewpoint": "图片证据表验收：三段五图，其中一张重复出现一次。", "base_revision": work.Revision,
	}, &work)
	var outlined Work
	items := []map[string]any{}
	for i := 1; i <= 3; i++ {
		items = append(items, map[string]any{"heading": fmt.Sprintf("证据段%d", i), "key_point": fmt.Sprintf("按顺序引用图片%d", i), "material_ids": []string{}})
	}
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{
		"confirm": true, "base_revision": work.Revision, "items": items,
	}, &outlined)

	// 上传 5 张本作品图片（A 用于段1与段2重复出现；其余覆盖段3）。
	assetIDs := []uuid.UUID{}
	sections := outlined.Sections
	sectionImages := [][]uuid.UUID{
		{}, {}, {},
	}
	for i := 0; i < 5; i++ {
		assetIDs = append(assetIDs, cxUploadWorkAssetForTest(t, work.ID.String(), cxEvidencePNGForTest(byte(i))))
	}
	// 顺序：段1=[A,B]，段2=[A,C]（A 重复），段3=[D,E]
	sectionImages = [][]uuid.UUID{
		{assetIDs[0], assetIDs[1]},
		{assetIDs[0], assetIDs[2]},
		{assetIDs[3], assetIDs[4]},
	}
	for i, section := range sections {
		md := fmt.Sprintf("第%d段正文。", i+1)
		for _, id := range sectionImages[i] {
			md += fmt.Sprintf("\n\n![图](/api/v1/assets/%s/file)", id)
		}
		env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{
			"content_md": md, "base_revision": section.Revision,
		}, nil)
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	order := []uuid.UUID{sectionImages[0][0], sectionImages[0][1], sectionImages[1][0], sectionImages[1][1], sectionImages[2][0], sectionImages[2][1]}
	return work, order
}

func TestCX03EvidenceCSVEndToEndAndManifestBinding(t *testing.T) {
	work, expectedOrder := cxEvidenceSeedWork(t, "证据表端到端")
	_, build := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})

	// 客户端按 renderWechatSections 契约渲染：3 段、5 个 img（含 A 重复）。
	var frozen Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &frozen)
	var html strings.Builder
	html.WriteString("<!doctype html><html><head><meta charset=\"utf-8\"></head><body><section>")
	for _, section := range frozen.Sections {
		html.WriteString(fmt.Sprintf(`<div data-section-id="%s"><h2>%s</h2>`, section.ID, section.Heading))
		for _, id := range expectedOrder {
			_ = id
		}
		html.WriteString("</div>")
	}
	html.WriteString("</section></body></html>")
	// 上面的骨架不含图片——按冻结来源逐段重新生成，保持顺序严格一致。
	var dom strings.Builder
	dom.WriteString("<!doctype html><html><head><meta charset=\"utf-8\"></head><body><section>")
	for si, section := range frozen.Sections {
		dom.WriteString(fmt.Sprintf(`<div data-section-id="%s"><h2>%s</h2><p>第%d段正文。</p>`, section.ID, section.Heading, si+1))
		start := map[int]int{0: 0, 1: 2, 2: 4}[si]
		count := map[int]int{0: 2, 1: 2, 2: 2}[si]
		for k := 0; k < count; k++ {
			id := expectedOrder[start+k]
			dom.WriteString(fmt.Sprintf(`<p><img src="/api/v1/assets/%s/file" alt="图"></p>`, id))
		}
		dom.WriteString("</div>")
	}
	dom.WriteString("</section></body></html>")

	if status, body := cxBuildUploadForTest(t, build.BuildID.String(), "html", "article.html", []byte(dom.String()), ""); status != 200 {
		t.Fatalf("upload evidence html: status=%d body=%s", status, body)
	}
	// Q-CX-03 拍板后（90 D-165）：纯净产物 complete 直接置 built，validation 留存于 error_detail。
	status, completeBody := env.do("POST", "/api/v1/builds/"+build.BuildID.String()+"/complete", cxBuildCompletionForTest(t, build.BuildID.String()))
	if status != 200 || !bytes.Contains(completeBody, []byte(`"status":"built"`)) {
		t.Fatalf("clean build must complete: status=%d body=%s", status, completeBody)
	}
	var completePayload struct {
		ArtifactFingerprint string         `json:"artifact_fingerprint"`
		Manifest            map[string]any `json:"manifest"`
	}
	if err := json.Unmarshal(completeBody, &completePayload); err != nil {
		t.Fatalf("decode complete: %v", err)
	}
	if len(completePayload.ArtifactFingerprint) != 64 {
		t.Fatalf("complete must return hex artifact_fingerprint: %q", completePayload.ArtifactFingerprint)
	}
	if got, _ := completePayload.Manifest["artifact_fingerprint"].(string); got != completePayload.ArtifactFingerprint {
		t.Fatalf("manifest fingerprint mismatch: response=%q manifest=%v", completePayload.ArtifactFingerprint, completePayload.Manifest["artifact_fingerprint"])
	}
	var detail struct {
		Validation json.RawMessage `json:"validation"`
	}
	env.mustJSON(t, "GET", "/api/v1/builds/"+build.BuildID.String(), nil, &detail)
	var validation struct {
		ImageEvidence []cxbuildvalidate.ImageEvidence `json:"image_evidence"`
	}
	if err := json.Unmarshal(detail.Validation, &validation); err != nil {
		t.Fatalf("decode validation: %v", err)
	}
	if len(validation.ImageEvidence) != 6 {
		t.Fatalf("3 sections with 6 occurrences (asset A repeats) must produce 6 evidence rows: %d", len(validation.ImageEvidence))
	}
	// 重复出现的资产 A 占 index 1 与 3，两条独立记录；段归属按冻结顺序。
	if validation.ImageEvidence[0].AssetID != validation.ImageEvidence[2].AssetID {
		t.Fatalf("repeated asset must appear twice: %+v", validation.ImageEvidence[:3])
	}
	if validation.ImageEvidence[0].SectionID == validation.ImageEvidence[2].SectionID {
		t.Fatal("repeated asset rows must stay bound to their own sections")
	}
	for i, item := range validation.ImageEvidence {
		if item.Index != i+1 || item.Role != "body" {
			t.Fatalf("evidence index/role broken at %d: %+v", i, item)
		}
	}

	// 生成与 manifest 相同字节的 CSV，注入 built 状态后走下载端点。
	data, err := cxBuildEvidenceCSV(validation.ImageEvidence)
	if err != nil {
		t.Fatal(err)
	}
	evidenceAny, err := json.Marshal(validation.ImageEvidence)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(evidenceAny))
	dec.UseNumber()
	var evidenceValue any
	if err := dec.Decode(&evidenceValue); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{
		"schema": "ops.build-manifest/v1", "source_hash": build.SourceHash, "targets": []any{"wechat_html"},
		"image_evidence": evidenceValue, "unused_asset_ids": []any{},
		"evidence_csv": map[string]any{"name": "evidence.csv", "mime": "text/csv; charset=utf-8",
			"bytes": len(data), "sha256": cxSHA256(data)},
	}
	manifestData, err := cxcanonicaljson.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestHash, err := cxcanonicaljson.Hash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	privacy, err := json.Marshal(map[string]any{"privacy": cxPrivacyReport{
		ReportHash: "evidence-clear", ScannerOK: true, PolicyReady: true, Level: "clear", Findings: []cxPrivacyFinding{}, BlockedBy: []string{},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work_build SET status='built',manifest=$2::jsonb,manifest_sha256=$3,error_detail=jsonb_build_object('validation',$4::jsonb),finished_at=now(),expires_at=now()+interval '1 hour' WHERE id=$1`,
		build.BuildID, string(manifestData), manifestHash, string(privacy)); err != nil {
		t.Fatal(err)
	}
	response := env.request("GET", "/api/v1/builds/"+build.BuildID.String()+"/evidence.csv", nil, "")
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !bytes.HasPrefix(body, []byte{0xef, 0xbb, 0xbf}) {
		t.Fatalf("evidence.csv download: status=%d bom=%v", response.StatusCode, bytes.HasPrefix(body, []byte{0xef, 0xbb, 0xbf}))
	}
	records, err := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf}))).ReadAll()
	if err != nil || len(records) != 7 {
		t.Fatalf("csv parse: err=%v records=%d", err, len(records))
	}
	if records[1][0] != "1" || records[6][0] != "6" {
		t.Fatalf("index column: %#v", records)
	}
	// 篡改 manifest 绑定：改一个字段的 hash 后必须 409。
	tampered := map[string]any{
		"schema": "ops.build-manifest/v1", "source_hash": build.SourceHash, "targets": []any{"wechat_html"},
		"image_evidence": evidenceValue, "unused_asset_ids": []any{},
		"evidence_csv": map[string]any{"name": "evidence.csv", "mime": "text/csv; charset=utf-8",
			"bytes": len(data) + 1, "sha256": cxSHA256(data)},
	}
	tamperedData, _ := cxcanonicaljson.Marshal(tampered)
	tamperedHash, _ := cxcanonicaljson.Hash(tampered)
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work_build SET manifest=$2::jsonb,manifest_sha256=$3 WHERE id=$1`,
		build.BuildID, string(tamperedData), tamperedHash); err != nil {
		t.Fatal(err)
	}
	response2 := env.request("GET", "/api/v1/builds/"+build.BuildID.String()+"/evidence.csv", nil, "")
	defer response2.Body.Close()
	tamperBody, _ := io.ReadAll(response2.Body)
	if response2.StatusCode != 409 || !bytes.Contains(tamperBody, []byte("artifact_hash_mismatch")) {
		t.Fatalf("tampered evidence_csv binding must 409: status=%d body=%s", response2.StatusCode, tamperBody)
	}
}

// 跨作品引用：冻结来源里的 asset 属于另一作品/另一工作区时阻断（image_missing），且错误只带 ID 不带敏感 URL。
func TestCX03EvidenceRejectsCrossWorkAssetReference(t *testing.T) {
	otherAccount := env.accounts(t).wechat
	var otherWork Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+otherAccount.ID.String()+"/works", map[string]string{"title": "别家作品"}, &otherWork)
	foreign := Asset{ID: cxUploadWorkAssetForTest(t, otherWork.ID.String(), cxEvidencePNGForTest(9))}

	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "跨作品引用阻断"}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"viewpoint": "引用别家图片应阻断。", "base_revision": work.Revision}, &work)
	var outlined Work
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{
		"confirm": true, "base_revision": work.Revision,
		"items": []map[string]any{{"heading": "引用段", "key_point": "图片来自别家", "material_ids": []string{}}},
	}, &outlined)
	section := outlined.Sections[0]
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{
		"content_md": "正文\n\n![外部](/api/v1/assets/" + foreign.ID.String() + "/file)", "base_revision": section.Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	_, build := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	html := fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"></head><body><section><div data-section-id="%s"><h2>引用段</h2><p>正文</p><p><img src="/api/v1/assets/%s/file" alt="外部"></p></div></section></body></html>`, section.ID, foreign.ID.String())
	status, body := cxBuildUploadForTest(t, build.BuildID.String(), "html", "article.html", []byte(html), "")
	if status != 200 {
		t.Fatalf("upload cross-work html: status=%d body=%s", status, body)
	}
	status, body = env.do("POST", "/api/v1/builds/"+build.BuildID.String()+"/complete", cxBuildCompletionForTest(t, build.BuildID.String()))
	if status != 422 || (!bytes.Contains(body, []byte("image_missing")) && !bytes.Contains(body, []byte("unmanaged_image"))) {
		t.Fatalf("cross-work asset must be blocked: status=%d body=%s", status, body)
	}
	// 脱敏：错误只带 asset_id/section 维度，不回显外部完整 URL。
	if bytes.Contains(body, []byte("https://")) {
		t.Fatalf("error detail must not echo external URL: %s", body)
	}
}

func cxUploadWorkAssetForTest(t *testing.T, workID string, data []byte) uuid.UUID {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, err := writer.CreateFormFile("file", "evidence.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	response := env.request("POST", "/api/v1/works/"+workID+"/assets", &body, writer.FormDataContentType())
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 201 && response.StatusCode != 200 {
		t.Fatalf("upload asset: status=%d body=%s", response.StatusCode, raw)
	}
	var uploaded Asset
	if err := json.Unmarshal(raw, &uploaded); err != nil {
		t.Fatalf("decode asset: %v body=%s", err, raw)
	}
	return uploaded.ID
}

// cxEvidencePNGForTest 生成一张确定性的合法 PNG（3x2，颜色随 seed 变化）。
func cxEvidencePNGForTest(seed byte) []byte {
	img := image.NewRGBA(image.Rect(0, 0, 3, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 3; x++ {
			img.Set(x, y, color.RGBA{R: seed, G: byte(x * 40), B: byte(y * 90), A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// FR-CX-05 验收矩阵补齐（与既有 3段5图 夹具同构）：封面/logo 不混入正文计数、
// 替换为另一张同数量图仍失败、外链构建阻断。
// cxEvidenceMatrixSeed 建两段稿件：段1 引用 A/B 两图、段2 引用 C，封面另设（不在正文）。
func cxEvidenceMatrixSeed(t *testing.T, title string) (Work, []uuid.UUID) {
	t.Helper()
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": title}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"viewpoint": "验收矩阵：封面不计数、同数量替换仍失败、外链阻断。", "base_revision": work.Revision,
	}, &work)
	var outlined Work
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{
		"confirm": true, "base_revision": work.Revision,
		"items": []map[string]any{
			{"heading": "矩阵段1", "key_point": "正文两图", "material_ids": []string{}},
			{"heading": "矩阵段2", "key_point": "正文一图", "material_ids": []string{}},
		},
	}, &outlined)
	cover := cxUploadWorkAssetForTest(t, work.ID.String(), cxEvidencePNGForTest(11))
	assetA := cxUploadWorkAssetForTest(t, work.ID.String(), cxEvidencePNGForTest(12))
	assetB := cxUploadWorkAssetForTest(t, work.ID.String(), cxEvidencePNGForTest(13))
	assetC := cxUploadWorkAssetForTest(t, work.ID.String(), cxEvidencePNGForTest(14))
	// 上传资产会推进 work.revision，设置封面前先取最新版本。
	var afterUpload Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &afterUpload)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"cover_asset_id": cover.String(), "base_revision": afterUpload.Revision,
	}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+outlined.Sections[0].ID.String(), map[string]any{
		"content_md": "第一段正文。\n\n![A](/api/v1/assets/" + assetA.String() + "/file)\n\n![B](/api/v1/assets/" + assetB.String() + "/file)", "base_revision": outlined.Sections[0].Revision,
	}, nil)
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+outlined.Sections[1].ID.String(), map[string]any{
		"content_md": "第二段正文。\n\n![C](/api/v1/assets/" + assetC.String() + "/file)", "base_revision": outlined.Sections[1].Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	return work, []uuid.UUID{cover, assetA, assetB, assetC}
}

func cxEvidenceMatrixHTML(sections []Section, refs [][]uuid.UUID, externalURL string) string {
	sectionText := map[int]string{0: "第一段正文。", 1: "第二段正文。"}
	var body strings.Builder
	body.WriteString("<!doctype html><html><head><meta charset=\"utf-8\"></head><body><section>")
	for i, section := range sections {
		body.WriteString(`<div data-section-id="` + section.ID.String() + `"><h2>` + section.Heading + `</h2><p>` + sectionText[i] + `</p>`)
		for j, id := range refs[i] {
			src := "/api/v1/assets/" + id.String() + "/file"
			if externalURL != "" && i == len(refs)-1 && j == len(refs[i])-1 {
				src = externalURL
			}
			body.WriteString(`<p><img src="` + src + `" alt="图"></p>`)
		}
		body.WriteString("</div>")
	}
	body.WriteString("</section></body></html>")
	return body.String()
}

// FR-CX-05 验收矩阵补齐（与既有 3段5图 夹具同构，双端共用的服务端契约）：
// 封面/logo 不混入正文计数；替换为另一张同数量图仍失败（顺序校验非仅数量）；
// 外链构建阻断；正文数量不符给出顺序定位。
func TestCX03EvidenceMatrixCoverSwapExternalAndCountMismatch(t *testing.T) {
	work, assets := cxEvidenceMatrixSeed(t, "证据矩阵封面与外链")
	var current Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &current)
	cover, assetA, assetB, assetC := assets[0], assets[1], assets[2], assets[3]

	// 场景一：封面资产不出现在正文 DOM 也不算 unused（IsCover 豁免）；正文 A/B/C 逐段出现 →
	// 序列与内容校验通过，Q-CX-03 拍板后纯净产物 complete 直接 built（90 D-165）。
	_, buildOK := cxBuildCreateForTest(t, work.ID.String(), current.Revision, []string{"wechat_html"})
	htmlOK := cxEvidenceMatrixHTML(current.Sections, [][]uuid.UUID{{assetA, assetB}, {assetC}}, "")
	if status, body := cxBuildUploadForTest(t, buildOK.BuildID.String(), "html", "article.html", []byte(htmlOK), ""); status != 200 {
		t.Fatalf("upload ok matrix: %d %s", status, body)
	}
	statusOK, bodyOK := env.do("POST", "/api/v1/builds/"+buildOK.BuildID.String()+"/complete", cxBuildCompletionForTest(t, buildOK.BuildID.String()))
	if statusOK != 200 || !strings.Contains(string(bodyOK), `"status":"built"`) {
		t.Fatalf("matching matrix must pass evidence checks and build: %d %s", statusOK, bodyOK)
	}
	// 场景二/三要在同一冻结来源上新建构建重新校验，先解除场景一构建的复用索引。
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work_build SET reusable=false WHERE id=$1`, buildOK.BuildID); err != nil {
		t.Fatal(err)
	}
	var detailOK struct {
		Manifest struct {
			ImageEvidence []map[string]any `json:"image_evidence"`
			UnusedAssets  []string         `json:"unused_asset_ids"`
		} `json:"manifest"`
	}
	if err := json.Unmarshal(bodyOK, &detailOK); err != nil {
		t.Fatalf("decode built manifest: %v", err)
	}
	if len(detailOK.Manifest.ImageEvidence) != 3 {
		t.Fatalf("cover/logo must not enter body evidence count: %d", len(detailOK.Manifest.ImageEvidence))
	}
	for _, unused := range detailOK.Manifest.UnusedAssets {
		if unused == cover.String() {
			t.Fatal("cover asset must not be listed as unused")
		}
	}

	// 场景二：替换为另一张同数量图仍失败——正文 3 张 img 数量不变，但第 1 张换成封面（冻结引用为 A）。
	_, buildSwap := cxBuildCreateForTest(t, work.ID.String(), current.Revision, []string{"wechat_html"})
	htmlSwap := cxEvidenceMatrixHTML(current.Sections, [][]uuid.UUID{{cover, assetB}, {assetC}}, "")
	if status, body := cxBuildUploadForTest(t, buildSwap.BuildID.String(), "html", "article.html", []byte(htmlSwap), ""); status != 200 {
		t.Fatalf("upload swap matrix: %d %s", status, body)
	}
	statusSwap, bodySwap := env.do("POST", "/api/v1/builds/"+buildSwap.BuildID.String()+"/complete", cxBuildCompletionForTest(t, buildSwap.BuildID.String()))
	if statusSwap != 422 || !strings.Contains(string(bodySwap), "html_invalid") {
		t.Fatalf("same-count swap must fail validation: %d %s", statusSwap, bodySwap)
	}

	// 场景三：外链构建阻断（unmanaged_image），detail 不回显外部完整 URL。
	_, buildExt := cxBuildCreateForTest(t, work.ID.String(), current.Revision, []string{"wechat_html"})
	htmlExt := cxEvidenceMatrixHTML(current.Sections, [][]uuid.UUID{{assetA, assetB}, {assetC}}, "https://cdn.example.com/pic/last.png")
	if status, body := cxBuildUploadForTest(t, buildExt.BuildID.String(), "html", "article.html", []byte(htmlExt), ""); status != 200 {
		t.Fatalf("upload external matrix: %d %s", status, body)
	}
	statusExt, bodyExt := env.do("POST", "/api/v1/builds/"+buildExt.BuildID.String()+"/complete", cxBuildCompletionForTest(t, buildExt.BuildID.String()))
	if statusExt != 422 || !strings.Contains(string(bodyExt), "unmanaged_image") {
		t.Fatalf("external link must be blocked: %d %s", statusExt, bodyExt)
	}
	if strings.Contains(string(bodyExt), "cdn.example.com") {
		t.Fatalf("error detail must not echo external URL: %s", bodyExt)
	}
}
