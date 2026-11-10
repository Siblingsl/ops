package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ops/internal/cxcanonicaljson"
)

func testManifest(t *testing.T, artifacts map[string][]byte) ([]byte, string) {
	t.Helper()
	items := make([]map[string]any, 0, len(artifacts))
	names := make([]string, 0, len(artifacts))
	for name := range artifacts {
		names = append(names, name)
	}
	// 产物顺序固定，避免 map 遍历导致清单字节不稳定。
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			if names[j] < names[i] {
				names[i], names[j] = names[j], names[i]
			}
		}
	}
	for _, name := range names {
		data := artifacts[name]
		sum := sha256.Sum256(data)
		items = append(items, map[string]any{
			"id": fmt.Sprintf("00000000-0000-0000-0000-%012d", len(items)+1), "kind": "html", "name": name,
			"mime": "text/html; charset=utf-8", "bytes": len(data), "sha256": hex.EncodeToString(sum[:]),
		})
	}
	privacy := map[string]any{
		"report_hash": "privacy-hash", "scanner_ok": true, "policy_ready": true,
		"errors": 0, "blocked_by": []string{},
	}
	manifest := map[string]any{
		"schema": "ops.build-manifest/v1", "build_id": "11111111-1111-1111-1111-111111111111",
		"work_id": "22222222-2222-2222-2222-222222222222", "source_hash": "source",
		"basis_revision": 3, "targets": []string{"wechat_html"}, "validator_version": "cx-html-1",
		"privacy_report_hash": "privacy-hash", "image_evidence": []map[string]any{
			{"index": 1, "role": "body", "asset_id": "asset-a", "sha256": "a", "output_sha256": "oa"},
			{"index": 2, "role": "body", "asset_id": "asset-b", "sha256": "b", "output_sha256": "ob"},
		}, "unused_asset_ids": []string{}, "artifacts": items,
		"privacy_report": privacy,
		"evidence_csv":   map[string]any{"name": "evidence.csv", "mime": "text/csv", "bytes": 2, "sha256": sha256Text("x\n")},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	value, err := cxcanonicaljson.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := cxcanonicaljson.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw, sha256Text(string(canonical))
}

func sha256Text(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func writeArchive(t *testing.T, artifacts map[string][]byte) string {
	t.Helper()
	dir := t.TempDir()
	manifest, canonicalHash := testManifest(t, artifacts)
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.sha256"), []byte(canonicalHash+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, data := range artifacts {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "evidence.csv"), []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestVerifyLocalDirAcceptsIntactArchive(t *testing.T) {
	dir := writeArchive(t, map[string][]byte{"article.html": []byte("<html>ok</html>")})
	report, err := verifyLocalDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK {
		t.Fatalf("完整归档应通过：%+v", report.Warnings)
	}
	if report.Scope != "local_integrity" {
		t.Fatalf("离线校验 scope 必须是 local_integrity，实际 %s", report.Scope)
	}
	if len(report.Artifacts) != 1 || !report.Artifacts[0].OK {
		t.Fatalf("产物校验结果不符：%+v", report.Artifacts)
	}
	if report.Privacy.Rescan != "not_performed" {
		t.Fatalf("CLI 不重放隐私扫描，rescan 必须如实标注，实际 %q", report.Privacy.Rescan)
	}
}

func TestVerifyLocalDirDetectsTampering(t *testing.T) {
	dir := writeArchive(t, map[string][]byte{"article.html": []byte("<html>ok</html>")})
	if err := os.WriteFile(filepath.Join(dir, "article.html"), []byte("<html>tampered</html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := verifyLocalDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if report.OK {
		t.Fatal("被篡改的归档不应通过")
	}
	if len(report.Artifacts) != 1 || report.Artifacts[0].OK {
		t.Fatalf("篡改产物应标失败：%+v", report.Artifacts)
	}
}

func TestVerifyLocalDirRejectsDuplicateAssetEvidence(t *testing.T) {
	dir := writeArchive(t, map[string][]byte{"article.html": []byte("<html>ok</html>")})
	raw, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	evidence := manifest["image_evidence"].([]any)
	second := evidence[1].(map[string]any)
	second["asset_id"] = "asset-a"
	updated, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	// 同时更新 manifest.sha256，隔离"清单摘要"与"证据序列"两类问题。
	value, err := cxcanonicaljson.Parse(updated)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := cxcanonicaljson.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), updated, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.sha256"), []byte(sha256Text(string(canonical))+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := verifyLocalDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if report.ImageEvidence.SequenceOK {
		t.Fatal("重复 asset_id 应判证据序列失败")
	}
	if report.OK {
		t.Fatal("证据序列失败时整份报告不应通过")
	}
}

func TestVerifyRemoteChecksArtifactsAndEvidence(t *testing.T) {
	artifacts := map[string][]byte{"article.html": []byte("<html>remote</html>")}
	manifest, _ := testManifest(t, artifacts)
	value, err := cxcanonicaljson.Parse(manifest)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := cxcanonicaljson.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var base string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/builds/b1/manifest.json", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "ops_session=test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("X-Content-SHA256", sha256Text(string(canonical)))
		_, _ = w.Write(manifest)
	})
	mux.HandleFunc("/api/v1/builds/b1/artifacts/00000000-0000-0000-0000-000000000001", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(artifacts["article.html"])
	})
	mux.HandleFunc("/api/v1/builds/b1/evidence.csv", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("x\n"))
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	base = server.URL

	report, err := verifyRemote(base, "ops_session=test", "b1")
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK {
		t.Fatalf("远程校验应通过：%+v", report.Warnings)
	}
	if report.Scope != "server_build" || len(report.Artifacts) != 1 || report.EvidenceCSV == nil || !report.EvidenceCSV.OK {
		t.Fatalf("远程校验结果不完整：%+v", report)
	}

	if _, err := verifyRemote(base, "ops_session=wrong", "b1"); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("会话无效应报 401，实际 %v", err)
	}
}
