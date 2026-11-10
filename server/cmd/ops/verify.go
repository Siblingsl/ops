package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"ops/internal/cxcanonicaljson"
)

// DEV-A17（CX14 / Q-CX-07）：ops verify/export 只读 CLI。
//
// 口径（docs/24 §4.6、docs/31 A17）：
//   - verify --dir：离线归档完整性（scope=local_integrity），不声称能验证服务端身份/权限/当前性；
//   - verify --build：复用现有会话 Cookie 读取构建清单与全部产物，重算字节哈希/尺寸、复核证据 CSV、
//     图片证据序列与隐私报告自洽；只发 GET，不改服务端 built 状态；
//   - export --build：同样的 GET，把清单与产物落到本地目录后再跑一遍离线校验。
//
// 明确不做：不重放隐私扫描（需要冻结正文与扫描器输入，CLI 没有），报告中
// privacy.rescan="not_performed"；不把"哈希相等"当"视觉真实"。

type verifyArtifactResult struct {
	ID             string `json:"id,omitempty"`
	Kind           string `json:"kind,omitempty"`
	Name           string `json:"name"`
	ExpectedBytes  int64  `json:"expected_bytes"`
	ActualBytes    int64  `json:"actual_bytes"`
	ExpectedSHA256 string `json:"expected_sha256"`
	ActualSHA256   string `json:"actual_sha256"`
	OK             bool   `json:"ok"`
	Error          string `json:"error,omitempty"`
}

type verifyReport struct {
	Schema                  string                 `json:"schema"`
	Scope                   string                 `json:"scope"`
	BuildID                 string                 `json:"build_id,omitempty"`
	ManifestSHA256          string                 `json:"manifest_sha256,omitempty"`
	CanonicalManifestSHA256 string                 `json:"canonical_manifest_sha256,omitempty"`
	CheckedAt               string                 `json:"checked_at"`
	OK                      bool                   `json:"ok"`
	Artifacts               []verifyArtifactResult `json:"artifacts"`
	EvidenceCSV             *verifyArtifactResult  `json:"evidence_csv,omitempty"`
	ImageEvidence           struct {
		Count      int      `json:"count"`
		SequenceOK bool     `json:"sequence_ok"`
		Issues     []string `json:"issues,omitempty"`
	} `json:"image_evidence"`
	Privacy struct {
		ReportHash       string   `json:"report_hash,omitempty"`
		ManifestHash     string   `json:"manifest_hash,omitempty"`
		ScannerOK        bool     `json:"scanner_ok"`
		PolicyReady      bool     `json:"policy_ready"`
		Errors           int      `json:"errors"`
		BlockedBy        []string `json:"blocked_by,omitempty"`
		Consistent       bool     `json:"consistent"`
		Rescan           string   `json:"rescan"`
		ManifestSchema   string   `json:"manifest_schema,omitempty"`
		ValidatorVersion string   `json:"validator_version,omitempty"`
	} `json:"privacy"`
	Warnings []string `json:"warnings,omitempty"`
}

type manifestArtifact struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	MIME   string `json:"mime"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	Width  *int   `json:"width"`
	Height *int   `json:"height"`
}

type buildManifest struct {
	Schema           string   `json:"schema"`
	BuildID          string   `json:"build_id"`
	WorkID           string   `json:"work_id"`
	SourceHash       string   `json:"source_hash"`
	BasisRevision    int      `json:"basis_revision"`
	Targets          []string `json:"targets"`
	ValidatorVersion string   `json:"validator_version"`
	PrivacyHash      string   `json:"privacy_report_hash"`
	ImageEvidence    []struct {
		Index         int    `json:"index"`
		Role          string `json:"role"`
		AssetID       string `json:"asset_id"`
		SHA256        string `json:"sha256"`
		OutputSHA256  string `json:"output_sha256"`
		MappingStatus string `json:"mapping_status"`
	} `json:"image_evidence"`
	Artifacts []manifestArtifact `json:"artifacts"`
	Evidence  manifestArtifact   `json:"evidence_csv"`
	Privacy   struct {
		ReportHash     string   `json:"report_hash"`
		InputHash      string   `json:"input_hash"`
		ScannerVersion string   `json:"scanner_version"`
		ScannerOK      bool     `json:"scanner_ok"`
		PolicyReady    bool     `json:"policy_ready"`
		Errors         int      `json:"errors"`
		Warnings       int      `json:"warnings"`
		BlockedBy      []string `json:"blocked_by"`
	} `json:"privacy_report"`
	Coverage        map[string]string `json:"coverage"`
	RendererReceipt map[string]any    `json:"renderer_receipt"`
}

func verifyCommand() error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	dir := fs.String("dir", "", "离线归档目录（含 manifest.json 与产物文件）")
	build := fs.String("build", "", "构建 ID（uuid）")
	baseURL := fs.String("base-url", "", "服务地址，例如 https://ops.example.com")
	cookie := fs.String("cookie", "", "现有会话 Cookie 头（也可用 OPS_SESSION_COOKIE）")
	out := fs.String("out", "", "报告输出路径（默认 stdout）")
	exportDir := fs.String("export", "", "同时导出清单与产物到该目录（仅 --build）")
	if err := fs.Parse(os.Args[2:]); err != nil {
		return err
	}
	if (*dir == "") == (*build == "") {
		return errors.New("--dir 与 --build 必须二选一")
	}
	var report verifyReport
	var err error
	if *dir != "" {
		report, err = verifyLocalDir(*dir)
	} else {
		c := *cookie
		if c == "" {
			c = os.Getenv("OPS_SESSION_COOKIE")
		}
		if c == "" {
			return errors.New("--build 需要 --cookie 或 OPS_SESSION_COOKIE（复用现有会话，不发明长效令牌）")
		}
		report, err = verifyRemote(*baseURL, c, *build)
		if err == nil && *exportDir != "" {
			if exportErr := exportBuild(*baseURL, c, *build, *exportDir, report); exportErr != nil {
				return exportErr
			}
		}
	}
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if *out != "" {
		if err := os.WriteFile(*out, data, 0o600); err != nil {
			return err
		}
	} else {
		_, _ = os.Stdout.Write(data)
	}
	if !report.OK {
		return errors.New("校验未通过：存在哈希/尺寸/证据序列/隐私自洽问题（详见报告）")
	}
	return nil
}

// verifyLocalDir 校验离线归档：manifest 自身摘要（若存在 manifest.sha256）、每个产物字节与
// SHA256、证据 CSV、图片证据序列与隐私报告自洽。scope 明确标 local_integrity。
func verifyLocalDir(dir string) (verifyReport, error) {
	report := newVerifyReport("local_integrity")
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return report, fmt.Errorf("读取 manifest.json 失败：%w", err)
	}
	rawHash := sha256Hex(raw)
	report.ManifestSHA256 = rawHash
	manifest, canonicalHash, warn := parseManifest(raw)
	if warn != "" {
		report.Warnings = append(report.Warnings, warn)
	}
	report.CanonicalManifestSHA256 = canonicalHash
	report.BuildID = manifest.BuildID
	if stored, err := os.ReadFile(filepath.Join(dir, "manifest.sha256")); err == nil {
		want := strings.TrimSpace(string(stored))
		if want != "" && want != canonicalHash {
			report.OK = false
			report.Warnings = append(report.Warnings,
				fmt.Sprintf("manifest.sha256 与重算的规范 JSON 摘要不一致：期望 %s，实际 %s", want, canonicalHash))
		}
	}
	verifyManifest(&report, manifest, func(name string) ([]byte, error) {
		return os.ReadFile(filepath.Join(dir, filepath.FromSlash(path.Base(name))))
	})
	return report, nil
}

func verifyRemote(baseURL, cookie, buildID string) (verifyReport, error) {
	report := newVerifyReport("server_build")
	if strings.TrimSpace(baseURL) == "" {
		return report, errors.New("--build 需要 --base-url")
	}
	base := strings.TrimRight(baseURL, "/")
	client := &http.Client{Timeout: 60 * time.Second}
	endpoint := base + "/api/v1/builds/" + buildID

	body, headerHash, err := httpGet(client, endpoint+"/manifest.json", cookie)
	if err != nil {
		return report, fmt.Errorf("读取构建清单失败（确认会话有效且构建已 built）：%w", err)
	}
	report.ManifestSHA256 = sha256Hex(body)
	manifest, canonicalHash, warn := parseManifest(body)
	if warn != "" {
		report.Warnings = append(report.Warnings, warn)
	}
	report.CanonicalManifestSHA256 = canonicalHash
	report.BuildID = buildID
	// 服务端下载头的 X-Content-SHA256 是"规范 JSON 字节"的摘要（与库内 manifest_sha256 同源）；
	// 清单允许经 jsonb 存取后有空白差异，因此以规范摘要对齐，而不是拿原始字节摘要硬比。
	if headerHash != "" && canonicalHash != "" && headerHash != canonicalHash {
		report.OK = false
		report.Warnings = append(report.Warnings,
			fmt.Sprintf("响应头 X-Content-SHA256 与重算的规范摘要不一致：头 %s，实际 %s", headerHash, canonicalHash))
	}
	if canonicalHash == "" {
		report.OK = false
		report.Warnings = append(report.Warnings, "清单无法规范化，不能确认摘要")
	}
	verifyManifest(&report, manifest, func(name string) ([]byte, error) {
		artifactID, ok := artifactIDForName(manifest, name)
		if !ok {
			return nil, fmt.Errorf("清单中找不到产物 %s", name)
		}
		data, _, err := httpGet(client, endpoint+"/artifacts/"+artifactID, cookie)
		return data, err
	}, func(name string) ([]byte, error) {
		data, _, err := httpGet(client, endpoint+"/evidence.csv", cookie)
		return data, err
	})
	return report, nil
}

func verifyManifest(report *verifyReport, manifest buildManifest,
	readArtifact func(string) ([]byte, error), readEvidence ...func(string) ([]byte, error)) {
	report.BuildID = firstNonEmpty(report.BuildID, manifest.BuildID)
	report.Privacy.ReportHash = manifest.Privacy.ReportHash
	report.Privacy.ManifestHash = manifest.PrivacyHash
	report.Privacy.ScannerOK = manifest.Privacy.ScannerOK
	report.Privacy.PolicyReady = manifest.Privacy.PolicyReady
	report.Privacy.Errors = manifest.Privacy.Errors
	report.Privacy.BlockedBy = manifest.Privacy.BlockedBy
	report.Privacy.ManifestSchema = manifest.Schema
	report.Privacy.ValidatorVersion = manifest.ValidatorVersion
	report.Privacy.Rescan = "not_performed"
	report.Privacy.Consistent = manifest.Privacy.ReportHash != "" &&
		manifest.Privacy.ReportHash == manifest.PrivacyHash &&
		manifest.Privacy.ScannerOK && manifest.Privacy.PolicyReady &&
		manifest.Privacy.Errors == 0 && len(manifest.Privacy.BlockedBy) == 0
	if !report.Privacy.Consistent {
		report.OK = false
		report.Warnings = append(report.Warnings, "隐私报告自洽检查未通过（scanner_ok/policy_ready/errors/blocked_by/report_hash 任一项不符）")
	}
	if manifest.Schema != "ops.build-manifest/v1" {
		report.OK = false
		report.Warnings = append(report.Warnings, "未知清单 schema："+manifest.Schema)
	}
	if len(manifest.Artifacts) == 0 {
		report.OK = false
		report.Warnings = append(report.Warnings, "清单没有任何产物")
	}
	for _, artifact := range manifest.Artifacts {
		result := verifyArtifactResult{ID: artifact.ID, Kind: artifact.Kind, Name: artifact.Name,
			ExpectedBytes: artifact.Bytes, ExpectedSHA256: artifact.SHA256}
		data, err := readArtifact(artifact.Name)
		if err != nil {
			result.Error = err.Error()
		} else {
			result.ActualBytes = int64(len(data))
			result.ActualSHA256 = sha256Hex(data)
			result.OK = result.ActualBytes == result.ExpectedBytes &&
				strings.EqualFold(result.ActualSHA256, result.ExpectedSHA256)
			if !result.OK {
				result.Error = "字节数或 SHA256 与清单不一致"
			}
		}
		if !result.OK {
			report.OK = false
		}
		report.Artifacts = append(report.Artifacts, result)
	}
	if manifest.Evidence.Name != "" {
		result := verifyArtifactResult{Name: manifest.Evidence.Name, Kind: "evidence_csv",
			ExpectedBytes: manifest.Evidence.Bytes, ExpectedSHA256: manifest.Evidence.SHA256}
		var data []byte
		var err error
		if len(readEvidence) > 0 {
			data, err = readEvidence[0](manifest.Evidence.Name)
		} else {
			data, err = readArtifact(manifest.Evidence.Name)
		}
		if err != nil {
			result.Error = err.Error()
		} else {
			result.ActualBytes = int64(len(data))
			result.ActualSHA256 = sha256Hex(data)
			result.OK = result.ActualBytes == result.ExpectedBytes &&
				strings.EqualFold(result.ActualSHA256, result.ExpectedSHA256)
			if !result.OK {
				result.Error = "字节数或 SHA256 与清单不一致"
			}
		}
		if !result.OK {
			report.OK = false
		}
		report.EvidenceCSV = &result
	} else {
		report.OK = false
		report.Warnings = append(report.Warnings, "清单缺少 evidence.csv 条目")
	}
	verifyImageEvidence(report, manifest)
}

func verifyImageEvidence(report *verifyReport, manifest buildManifest) {
	report.ImageEvidence.Count = len(manifest.ImageEvidence)
	report.ImageEvidence.SequenceOK = true
	seenAsset := map[string]bool{}
	last := 0
	for i, item := range manifest.ImageEvidence {
		if item.Index <= last {
			report.ImageEvidence.SequenceOK = false
			report.ImageEvidence.Issues = append(report.ImageEvidence.Issues,
				fmt.Sprintf("第 %d 项 index=%d 不是递增序列", i+1, item.Index))
		}
		last = item.Index
		if item.AssetID == "" {
			report.ImageEvidence.SequenceOK = false
			report.ImageEvidence.Issues = append(report.ImageEvidence.Issues,
				fmt.Sprintf("第 %d 项缺少 asset_id", i+1))
		} else if seenAsset[item.AssetID] {
			report.ImageEvidence.SequenceOK = false
			report.ImageEvidence.Issues = append(report.ImageEvidence.Issues,
				fmt.Sprintf("asset_id %s 在正文中重复出现（同一图被复用需显式确认）", item.AssetID))
		}
		seenAsset[item.AssetID] = true
		if item.SHA256 == "" || item.OutputSHA256 == "" {
			report.ImageEvidence.SequenceOK = false
			report.ImageEvidence.Issues = append(report.ImageEvidence.Issues,
				fmt.Sprintf("第 %d 项缺少 sha256/output_sha256", i+1))
		}
	}
	if !report.ImageEvidence.SequenceOK {
		report.OK = false
	}
}

func parseManifest(raw []byte) (buildManifest, string, string) {
	var manifest buildManifest
	warn := ""
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return manifest, "", "清单不是合法 JSON：" + err.Error()
	}
	value, err := cxcanonicaljson.Parse(raw)
	if err != nil {
		return manifest, "", "清单无法规范化：" + err.Error()
	}
	canonical, err := cxcanonicaljson.Marshal(value)
	if err != nil {
		return manifest, "", "清单规范化失败：" + err.Error()
	}
	return manifest, sha256Hex(canonical), warn
}

func httpGet(client *http.Client, url, cookie string) ([]byte, string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 256<<20))
	if err != nil {
		return nil, "", err
	}
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("%s 返回 %d：%s", url, res.StatusCode, truncate(string(body), 200))
	}
	return body, strings.TrimSpace(res.Header.Get("X-Content-SHA256")), nil
}

func artifactIDForName(manifest buildManifest, name string) (string, bool) {
	for _, artifact := range manifest.Artifacts {
		if artifact.Name == name {
			return artifact.ID, true
		}
	}
	if manifest.Evidence.Name == name {
		return "", false
	}
	return "", false
}

func exportBuild(baseURL, cookie, buildID, dir string, report verifyReport) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	base := strings.TrimRight(baseURL, "/")
	endpoint := base + "/api/v1/builds/" + buildID
	client := &http.Client{Timeout: 120 * time.Second}
	manifestRaw, _, err := httpGet(client, endpoint+"/manifest.json", cookie)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), manifestRaw, 0o600); err != nil {
		return err
	}
	if report.CanonicalManifestSHA256 != "" {
		if err := os.WriteFile(filepath.Join(dir, "manifest.sha256"),
			[]byte(report.CanonicalManifestSHA256+"\n"), 0o600); err != nil {
			return err
		}
	}
	manifest, _, _ := parseManifest(manifestRaw)
	for _, artifact := range manifest.Artifacts {
		data, _, err := httpGet(client, endpoint+"/artifacts/"+artifact.ID, cookie)
		if err != nil {
			return fmt.Errorf("导出产物 %s 失败：%w", artifact.Name, err)
		}
		target := filepath.Join(dir, filepath.FromSlash(path.Base(artifact.Name)))
		if err := os.WriteFile(target, data, 0o600); err != nil {
			return err
		}
	}
	if manifest.Evidence.Name != "" {
		data, _, err := httpGet(client, endpoint+"/evidence.csv", cookie)
		if err != nil {
			return fmt.Errorf("导出 evidence.csv 失败：%w", err)
		}
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(path.Base(manifest.Evidence.Name))), data, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func newVerifyReport(scope string) verifyReport {
	return verifyReport{Schema: "ops.verify-report/v1", Scope: scope, OK: true,
		CheckedAt: time.Now().UTC().Format(time.RFC3339), Artifacts: []verifyArtifactResult{}}
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func truncate(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

// exportCommand：ops export --build <uuid> --base-url <url> --cookie <会话> --out <dir>。
// 与 verify --build --export 等价，但明确以"落盘归档"为目的：先校验，再把清单/产物/报告写入目录。
func exportCommand() error {
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	build := fs.String("build", "", "构建 ID（uuid）")
	baseURL := fs.String("base-url", "", "服务地址，例如 https://ops.example.com")
	cookie := fs.String("cookie", "", "现有会话 Cookie 头（也可用 OPS_SESSION_COOKIE）")
	dir := fs.String("out", "", "导出目录")
	if err := fs.Parse(os.Args[2:]); err != nil {
		return err
	}
	if *build == "" || *dir == "" {
		return errors.New("export 需要 --build 与 --out")
	}
	c := *cookie
	if c == "" {
		c = os.Getenv("OPS_SESSION_COOKIE")
	}
	if c == "" {
		return errors.New("export 需要 --cookie 或 OPS_SESSION_COOKIE（复用现有会话，不发明长效令牌）")
	}
	report, err := verifyRemote(*baseURL, c, *build)
	if err != nil {
		return err
	}
	if err := exportBuild(*baseURL, c, *build, *dir, report); err != nil {
		return err
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(*dir, "verify-report.json"), append(data, '\n'), 0o600); err != nil {
		return err
	}
	if !report.OK {
		return errors.New("已导出，但校验未通过：详见 verify-report.json")
	}
	return nil
}
