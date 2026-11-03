package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// DEV-CX09：用户确认计划 → options.cards 采用映射 → xhs_cards 构建 → 服务端 ZIP 校验链。
// 这些用例只证明本地契约；Q-CX-03/04 已拍板（90 D-165）：纯净产物 complete 直接置 built，下载按 WARN 知悉确认门禁放行。

func cxTestCardsPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for index := range img.Pix {
		img.Pix[index] = 255
	}
	img.Set(0, 0, color.Black)
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func cxTestCardsZIP(t *testing.T, names []string, files [][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for index, name := range names {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(files[index]); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func cxTestManualCards(work Work) []map[string]any {
	section := work.Sections[0]
	ref := "section:" + section.ID.String()
	return []map[string]any{
		{"card_id": "cover-1", "type": "cover", "section_ids": []string{section.ID.String()},
			"headline": "封面标题", "body": "封面正文", "asset_ids": []string{}, "source_refs": []string{ref}},
		{"card_id": "point-1", "type": "point", "section_ids": []string{section.ID.String()},
			"headline": "占位标题", "body": "占位正文", "asset_ids": []string{}, "source_refs": []string{ref}},
		{"card_id": "end-1", "type": "end", "section_ids": []string{section.ID.String()},
			"headline": "结尾标题", "body": "结尾正文", "asset_ids": []string{}, "source_refs": []string{ref}},
	}
}

type cxTestCardsPreview struct {
	SourceHash      string           `json:"source_hash"`
	ParamsHash      string           `json:"params_hash"`
	BasisRevision   int              `json:"basis_revision"`
	Template        string           `json:"template"`
	Ratio           string           `json:"ratio"`
	DNAVersion      *int64           `json:"dna_version"`
	TemplateVersion string           `json:"template_version"`
	Cards           []map[string]any `json:"cards"`
	VisualPlan      map[string]any   `json:"visual_plan"`
	Warnings        []string         `json:"warnings"`
}

func cxTestPreviewCards(t *testing.T, work Work, cards []map[string]any, dnaVersion *int64) cxTestCardsPreview {
	t.Helper()
	input := map[string]any{"basis_revision": work.Revision, "template": "editorial", "ratio": "3:4", "cards": cards}
	if dnaVersion != nil {
		input["dna_version"] = *dnaVersion
	}
	var preview cxTestCardsPreview
	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/cards/preview", input)
	if status != 200 {
		t.Fatalf("preview cards: status=%d body=%s", status, body)
	}
	if err := json.Unmarshal(body, &preview); err != nil {
		t.Fatalf("decode preview: %v body=%s", err, body)
	}
	return preview
}

func cxTestCreateCardsBuild(t *testing.T, work Work, preview cxTestCardsPreview, cards []map[string]any) cxBuildCreateResponse {
	t.Helper()
	options := map[string]any{"template": preview.Template, "ratio": preview.Ratio, "dna_version": preview.DNAVersion,
		"cards": cards, "template_version": preview.TemplateVersion}
	if preview.VisualPlan != nil {
		options["visual_plan"] = preview.VisualPlan
	}
	var created cxBuildCreateResponse
	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"xhs_cards"},
		"options": options,
		"client":  "web", "renderer_contract_version": preview.TemplateVersion,
	})
	if status != 201 {
		t.Fatalf("create cards build: status=%d body=%s", status, body)
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("decode build: %v body=%s", err, body)
	}
	return created
}

func cxTestBuildArtifact(t *testing.T, buildID string) (string, string) {
	t.Helper()
	var id, name string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT id,name FROM work_build_artifact WHERE build_id=$1 AND kind='zip'`, buildID).Scan(&id, &name); err != nil {
		t.Fatal(err)
	}
	return id, name
}

func cxTestCompleteCardsBuild(t *testing.T, buildID, artifactID, artifactName string, sourceHash, paramsHash string) (int, []byte) {
	t.Helper()
	return env.do("POST", "/api/v1/builds/"+buildID+"/complete", map[string]any{
		"source_hash": sourceHash, "params_hash": paramsHash,
		"artifacts": []map[string]any{{"artifact_id": artifactID, "kind": "zip", "name": artifactName}},
		"renderer_receipt": map[string]any{"client": "web", "application_version": "test", "renderer_contract_version": cxCardsTemplateVersion,
			"chromium_version": "test", "font_family": "test-font", "device_scale_factor": 1, "viewport_width": 1280, "viewport_height": 800},
	})
}

func TestCX09CardsBuildUsesPreviewHashesAndValidatesZIP(t *testing.T) {
	account := env.accounts(t).xhs
	work := env.draftedWork(t, account, "组图构建输入验收")
	preview := cxTestPreviewCards(t, work, cxTestManualCards(work), nil)
	if preview.SourceHash == "" || preview.ParamsHash == "" || len(preview.Cards) != 3 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	created := cxTestCreateCardsBuild(t, work, preview, preview.Cards)
	if created.SourceHash != preview.SourceHash || created.ParamsHash != preview.ParamsHash {
		t.Fatalf("build must reuse preview hashes: preview=%s/%s build=%s/%s", preview.SourceHash, preview.ParamsHash, created.SourceHash, created.ParamsHash)
	}

	// 条目名与卡片计划不一致：上传阶段放行（只做安全检查），complete 按冻结计划拒绝。
	badNames := []string{"01-cover.png", "02-end.png", "03-point-1.png"}
	badZIP := cxTestCardsZIP(t, badNames, [][]byte{cxTestCardsPNG(t, 1080, 1440), cxTestCardsPNG(t, 1080, 1440), cxTestCardsPNG(t, 1080, 1440)})
	if status, body := cxBuildUploadForTest(t, created.BuildID.String(), "zip", "cards.zip", badZIP, ""); status != 200 {
		t.Fatalf("upload mismatched zip: status=%d body=%s", status, body)
	}
	artifactID, artifactName := cxTestBuildArtifact(t, created.BuildID.String())
	if status, body := cxTestCompleteCardsBuild(t, created.BuildID.String(), artifactID, artifactName, created.SourceHash, created.ParamsHash); status != 422 || !bytes.Contains(body, []byte("cards_zip_entry_mismatch")) {
		t.Fatalf("mismatched entry order: status=%d body=%s", status, body)
	}
	var failedCode string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT error_code FROM work_build WHERE id=$1`, created.BuildID).Scan(&failedCode); err != nil || failedCode != "cards_zip_entry_mismatch" {
		t.Fatalf("mismatched zip must fail the build: code=%s err=%v", failedCode, err)
	}

	// 正确的三张卡片：结构/像素校验通过后，Q-CX-03 拍板（90 D-165）纯净产物直接置 built。
	second := cxTestCreateCardsBuild(t, work, preview, preview.Cards)
	names := []string{"01-cover.png", "02-point-1.png", "03-end.png"}
	goodZIP := cxTestCardsZIP(t, names, [][]byte{cxTestCardsPNG(t, 1080, 1440), cxTestCardsPNG(t, 1080, 1440), cxTestCardsPNG(t, 1080, 1440)})
	if status, body := cxBuildUploadForTest(t, second.BuildID.String(), "zip", "cards.zip", goodZIP, ""); status != 200 {
		t.Fatalf("upload valid zip: status=%d body=%s", status, body)
	}
	validID, validName := cxTestBuildArtifact(t, second.BuildID.String())
	status, body := cxTestCompleteCardsBuild(t, second.BuildID.String(), validID, validName, second.SourceHash, second.ParamsHash)
	if status != 200 || !bytes.Contains(body, []byte(`"status":"built"`)) {
		t.Fatalf("valid cards build must complete: status=%d body=%s", status, body)
	}
	var buildStatus, errorCode string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,COALESCE(error_code,'') FROM work_build WHERE id=$1`, second.BuildID).Scan(&buildStatus, &errorCode); err != nil || buildStatus != "built" || errorCode != "" {
		t.Fatalf("cards build must be built without error: status=%s code=%s err=%v", buildStatus, errorCode, err)
	}
	var detail map[string]any
	env.mustJSON(t, "GET", "/api/v1/builds/"+second.BuildID.String(), nil, &detail)
	gate, _ := detail["download_gate"].(map[string]any)
	allowed, _ := gate["allowed"].(bool)
	reason, _ := gate["reason"].(string)
	if !allowed || reason != "clear" {
		t.Fatalf("clean built cards build must allow download without acknowledgement: %+v", gate)
	}
}

func TestCX09CardsBuildRejectsNonCanonicalPlanAndMixedTargets(t *testing.T) {
	account := env.accounts(t).xhs
	work := env.draftedWork(t, account, "组图构建拒绝验收")
	preview := cxTestPreviewCards(t, work, cxTestManualCards(work), nil)

	// 未经过预览规范化的要点卡文案：拒绝，避免 params_hash 与用户看到的计划不一致。
	tampered := make([]map[string]any, len(preview.Cards))
	for index, card := range preview.Cards {
		tampered[index] = map[string]any{}
		for key, value := range card {
			tampered[index][key] = value
		}
	}
	tampered[1]["headline"] = "未规范化的要点标题"
	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"xhs_cards"},
		"options": map[string]any{"template": preview.Template, "ratio": preview.Ratio, "dna_version": nil,
			"cards": tampered, "template_version": preview.TemplateVersion},
		"client": "web", "renderer_contract_version": preview.TemplateVersion,
	})
	if status != 422 || !bytes.Contains(body, []byte("cards_not_canonicalized")) {
		t.Fatalf("non-canonical point card: status=%d body=%s", status, body)
	}

	// 组图与公众号产物不能混在一次构建里。
	status, body = env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"wechat_html", "xhs_cards"}, "options": map[string]any{},
		"client": "web", "renderer_contract_version": preview.TemplateVersion,
	})
	if status != 422 || !bytes.Contains(body, []byte("组图构建不能与其他产物目标混合")) {
		t.Fatalf("mixed targets: status=%d body=%s", status, body)
	}

	// 模板版本必须与服务端登记一致。
	status, body = env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"xhs_cards"},
		"options": map[string]any{"template": preview.Template, "ratio": preview.Ratio, "dna_version": nil,
			"cards": preview.Cards, "template_version": preview.TemplateVersion},
		"client": "web", "renderer_contract_version": "ops.xhs-cards/v0",
	})
	if status != 409 || !bytes.Contains(body, []byte("renderer_version_mismatch")) {
		t.Fatalf("unregistered cards template version: status=%d body=%s", status, body)
	}
}

func TestCX09CardsBuildZIPRejectsWrongPixelsUnsafePathsAndNonPNG(t *testing.T) {
	account := env.accounts(t).xhs
	work := env.draftedWork(t, account, "组图 ZIP 校验验收")
	preview := cxTestPreviewCards(t, work, cxTestManualCards(work), nil)
	names := []string{"01-cover.png", "02-point-1.png", "03-end.png"}

	cases := []struct {
		name       string
		names      []string
		files      [][]byte
		wantStatus int
		wantCode   string
		stage      string
	}{
		{name: "尺寸与比例不一致", names: names,
			files:      [][]byte{cxTestCardsPNG(t, 1080, 1440), cxTestCardsPNG(t, 1080, 1080), cxTestCardsPNG(t, 1080, 1440)},
			wantStatus: 422, wantCode: "cards_image_invalid", stage: "complete"},
		{name: "条目不是 PNG", names: names,
			files:      [][]byte{cxTestCardsPNG(t, 1080, 1440), []byte("not-a-png"), cxTestCardsPNG(t, 1080, 1440)},
			wantStatus: 422, wantCode: "cards_image_invalid", stage: "complete"},
		{name: "穿越路径条目", names: []string{"01-cover.png", "../02-point-1.png", "03-end.png"},
			files:      [][]byte{cxTestCardsPNG(t, 1080, 1440), cxTestCardsPNG(t, 1080, 1440), cxTestCardsPNG(t, 1080, 1440)},
			wantStatus: 422, wantCode: "artifact_invalid", stage: "upload"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			build := cxTestCreateCardsBuild(t, work, preview, preview.Cards)
			payload := cxTestCardsZIP(t, testCase.names, testCase.files)
			status, body := cxBuildUploadForTest(t, build.BuildID.String(), "zip", "cards.zip", payload, "")
			if testCase.stage == "upload" {
				if status != testCase.wantStatus || !bytes.Contains(body, []byte(testCase.wantCode)) {
					t.Fatalf("upload: status=%d body=%s", status, body)
				}
				return
			}
			if status != 200 {
				t.Fatalf("upload should pass safety check: status=%d body=%s", status, body)
			}
			artifactID, artifactName := cxTestBuildArtifact(t, build.BuildID.String())
			status, body = cxTestCompleteCardsBuild(t, build.BuildID.String(), artifactID, artifactName, build.SourceHash, build.ParamsHash)
			if status != testCase.wantStatus || !bytes.Contains(body, []byte(testCase.wantCode)) {
				t.Fatalf("complete: status=%d body=%s", status, body)
			}
		})
	}
}

// cxTestCardsDNAAccount 建一个只属于本用例的小红书账号。视觉 DNA 是账号级状态，
// 往共享夹具账号写 DNA 会让其它用例的「未设置 DNA」断言看到残留版本。
func cxTestCardsDNAAccount(t *testing.T, name string) Account {
	t.Helper()
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": name, "content_format": "image_note"}, &account)
	return account
}

func TestCX09CardsBuildFreezesDNAVersionIntoSourceHash(t *testing.T) {
	account := cxTestCardsDNAAccount(t, "组图 DNA 冻结账号")
	work := env.draftedWork(t, account, "组图 DNA 冻结验收")
	plain := cxTestPreviewCards(t, work, cxTestManualCards(work), nil)

	path := "/api/v1/accounts/" + account.ID.String() + "/visual-dna"
	tokens := map[string]any{
		"schema":     "ops.visual-dna/v1",
		"palette":    map[string]string{"primary": "#1B5E20", "secondary": "#1565C0", "background": "#FFFFFF", "text": "#212121", "muted": "#555555"},
		"font_stack": "system-sans", "radius": 12, "spacing_scale": "1.00", "logo_asset_id": nil,
		"watermark":             map[string]string{"text": "", "position": "bottom-right", "opacity": "0.00"},
		"card_template_default": "editorial", "card_ratio_default": "3:4", "end_copy": "关注我",
	}
	if status, body := env.do("PUT", path, map[string]any{"base_version": 0, "tokens": tokens}); status != 201 {
		t.Fatalf("save visual DNA: status=%d body=%s", status, body)
	}
	dnaVersion := int64(1)
	withDNA := cxTestPreviewCards(t, work, cxTestManualCards(work), &dnaVersion)
	if withDNA.SourceHash == plain.SourceHash {
		t.Fatal("DNA version must change the frozen source hash")
	}
	created := cxTestCreateCardsBuild(t, work, withDNA, withDNA.Cards)
	if created.SourceHash != withDNA.SourceHash {
		t.Fatalf("build source hash must match DNA preview: build=%s preview=%s", created.SourceHash, withDNA.SourceHash)
	}
	var snapshot struct {
		VisualDNA *struct {
			Version int64 `json:"version"`
		} `json:"visual_dna"`
	}
	if err := json.Unmarshal(created.SourceSnapshot, &snapshot); err != nil || snapshot.VisualDNA == nil || snapshot.VisualDNA.Version != 1 {
		t.Fatalf("source snapshot must freeze the DNA version: %+v err=%v", snapshot, err)
	}
	var detail map[string]any
	env.mustJSON(t, "GET", "/api/v1/builds/"+created.BuildID.String(), nil, &detail)
	if current, _ := detail["is_current"].(bool); !current {
		t.Fatal("a build frozen with the current DNA version must still be current")
	}

	// 不存在的 DNA 版本必须拒绝，不能用近似版本代替。
	missing := int64(99)
	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"xhs_cards"},
		"options": map[string]any{"template": withDNA.Template, "ratio": withDNA.Ratio, "dna_version": missing,
			"cards": withDNA.Cards, "template_version": withDNA.TemplateVersion},
		"client": "web", "renderer_contract_version": withDNA.TemplateVersion,
	})
	if status != 409 || !bytes.Contains(body, []byte("visual_dna_unavailable")) {
		t.Fatalf("missing DNA version: status=%d body=%s", status, body)
	}
}

// AI 报告路径 + 视觉 DNA：preview 与 build 必须冻结同一份来源快照。
func TestCX09CardsBuildAIPathWithDNAMatchesPreviewHash(t *testing.T) {
	account := cxTestCardsDNAAccount(t, "AI 路径组图构建账号")
	work := env.draftedWork(t, account, "AI 路径组图构建哈希验收")
	path := "/api/v1/accounts/" + account.ID.String() + "/visual-dna"
	tokens := map[string]any{
		"schema":     "ops.visual-dna/v1",
		"palette":    map[string]string{"primary": "#1B5E20", "secondary": "#1565C0", "background": "#FFFFFF", "text": "#212121", "muted": "#555555"},
		"font_stack": "system-sans", "radius": 12, "spacing_scale": "1.00", "logo_asset_id": nil,
		"watermark":             map[string]string{"text": "", "position": "bottom-right", "opacity": "0.00"},
		"card_template_default": "editorial", "card_ratio_default": "3:4", "end_copy": "关注我",
	}
	// 同一账号在测试进程内可能已有 DNA 版本，按当前版本递增而不是假设从 0 开始。
	var current struct {
		Version int `json:"version"`
	}
	env.mustJSON(t, "GET", path, nil, &current)
	dnaVersion := current.Version + 1
	if status, body := env.do("PUT", path, map[string]any{"base_version": current.Version, "tokens": tokens}); status != 201 {
		t.Fatalf("save visual DNA: status=%d body=%s", status, body)
	}
	sectionIDs := make([]string, 0, 2)
	for _, section := range work.Sections[:2] {
		sectionIDs = append(sectionIDs, section.ID.String())
	}
	var report cxVisualPlanResponse
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/cards/suggest", map[string]any{
		"basis_revision": work.Revision, "section_ids": sectionIDs, "asset_ids": []string{},
		"template": "editorial", "ratio": "3:4", "dna_version": dnaVersion,
	}, &report)
	for index := range report.Cards {
		cards := make([]cxVisualPlanEditCard, 0, len(report.Cards))
		for cardIndex, card := range report.Cards {
			cards = append(cards, cxVisualPlanEditCard{CardID: card.CardID, Type: card.Type, SectionIDs: card.SectionIDs,
				Headline: card.Headline, Body: card.Body, AssetIDs: card.AssetIDs, SourceRefs: card.SourceRefs,
				Confirmed: card.Confirmed || cardIndex == index})
		}
		var updated cxVisualPlanResponse
		env.mustJSON(t, "PATCH", "/api/v1/diagnoses/"+report.DiagnosisID.String()+"/visual-plan", map[string]any{
			"expected_revision": report.Revision, "cards": cards,
		}, &updated)
		report = updated
	}
	var preview cxTestCardsPreview
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/cards/preview", map[string]any{
		"basis_revision": work.Revision, "template": report.Template, "ratio": report.Ratio, "dna_version": dnaVersion,
		"visual_plan_id": report.DiagnosisID, "expected_result_revision": report.Revision,
	}, &preview)
	if preview.VisualPlan == nil {
		t.Fatal("AI 计划预览必须回传 visual_plan 引用，否则构建无法与预览对齐 params_hash")
	}
	created := cxTestCreateCardsBuild(t, work, preview, preview.Cards)
	if created.SourceHash != preview.SourceHash {
		var snapshot map[string]any
		_ = json.Unmarshal(created.SourceSnapshot, &snapshot)
		t.Fatalf("AI path preview/build source hash mismatch: preview=%s build=%s visual_dna=%v", preview.SourceHash, created.SourceHash, snapshot["visual_dna"])
	}
	// params_hash 必须一致：预览回传的报告引用被原样采用，构建参数可追溯到同一份确认计划。
	if created.ParamsHash != preview.ParamsHash {
		t.Fatalf("AI path preview/build params hash mismatch: preview=%s build=%s", preview.ParamsHash, created.ParamsHash)
	}

	// 引用被篡改（摘要或版本）必须被服务端拒绝，不能把不一致的计划记进冻结参数。
	stale := map[string]any{"diagnosis_id": preview.VisualPlan["diagnosis_id"], "input_hash": strings.Repeat("0", 64), "result_revision": 1}
	status, body := env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"xhs_cards"},
		"options": map[string]any{"template": preview.Template, "ratio": preview.Ratio, "dna_version": dnaVersion,
			"cards": preview.Cards, "template_version": preview.TemplateVersion, "visual_plan": stale},
		"client": "web", "renderer_contract_version": preview.TemplateVersion,
	})
	if status != 409 || !strings.Contains(string(body), "visual_plan_stale") {
		t.Fatalf("tampered plan ref must be rejected: status=%d body=%s", status, body)
	}
	unknown := map[string]any{"diagnosis_id": uuid.New().String(), "input_hash": preview.VisualPlan["input_hash"], "result_revision": 1}
	status, body = env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"xhs_cards"},
		"options": map[string]any{"template": preview.Template, "ratio": preview.Ratio, "dna_version": dnaVersion,
			"cards": preview.Cards, "template_version": preview.TemplateVersion, "visual_plan": unknown},
		"client": "web", "renderer_contract_version": preview.TemplateVersion,
	})
	if status != 409 || !strings.Contains(string(body), "visual_plan_unavailable") {
		t.Fatalf("foreign plan ref must be rejected: status=%d body=%s", status, body)
	}
}
