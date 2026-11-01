package app

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"
	"time"

	"github.com/google/uuid"

	"ops/internal/cxcanonicaljson"
)

func TestCXBuildDownloadGateBindsCurrentUserReportAndEveryWarning(t *testing.T) {
	manifest := map[string]any{"schema": "ops.build-manifest/v1"}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestValue, err := cxcanonicaljson.Parse(manifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	manifestHash, err := cxcanonicaljson.Hash(manifestValue)
	if err != nil {
		t.Fatal(err)
	}
	report := cxPrivacyReport{
		ReportHash: "report-current", ScannerOK: true, PolicyReady: true, Level: "warn", Warnings: 2,
		Findings: []cxPrivacyFinding{{ID: "warning-a", Severity: "warn"}, {ID: "warning-b", Severity: "warn"}},
	}
	validation, err := json.Marshal(map[string]any{"privacy": report})
	if err != nil {
		t.Fatal(err)
	}
	sha := manifestHash
	user := uuid.New()
	expires := time.Now().Add(time.Hour)
	gate := cxBuildDownloadGate("built", &expires, manifestBytes, &sha, validation, []byte("[]"), user, "editor", time.Now())
	if gateAllowed(gate) || gate["reason"] != "privacy_ack_required" {
		t.Fatalf("unconfirmed warnings should block download: %#v", gate)
	}
	viewerGate := cxBuildDownloadGate("built", &expires, manifestBytes, &sha, validation, []byte("[]"), user, "viewer", time.Now())
	if gateAllowed(viewerGate) || viewerGate["reason"] != "viewer_ack_unavailable" {
		t.Fatalf("viewer warning download must explain unresolved write permission: %#v", viewerGate)
	}
	ack, err := json.Marshal([]cxPrivacyAckRecord{{UserID: user.String(), ReportHash: report.ReportHash, FindingIDs: []string{"warning-b", "warning-a"}}})
	if err != nil {
		t.Fatal(err)
	}
	allowed := cxBuildDownloadGate("built", &expires, manifestBytes, &sha, validation, ack, user, "editor", time.Now())
	if !gateAllowed(allowed) || allowed["reason"] != "acknowledged" {
		t.Fatalf("complete current-user warning acknowledgement should allow download: %#v", allowed)
	}
	otherUser := cxBuildDownloadGate("built", &expires, manifestBytes, &sha, validation, ack, uuid.New(), "editor", time.Now())
	if gateAllowed(otherUser) {
		t.Fatalf("another user's acknowledgement was reused: %#v", otherUser)
	}
	truncatedReport := cxPrivacyReport{ReportHash: "truncated", ScannerOK: true, PolicyReady: true, Level: "warn", Warnings: 201, Truncated: true, Findings: make([]cxPrivacyFinding, 200)}
	truncatedValidation, err := json.Marshal(map[string]any{"privacy": truncatedReport})
	if err != nil {
		t.Fatal(err)
	}
	truncatedGate := cxBuildDownloadGate("built", &expires, manifestBytes, &sha, truncatedValidation, []byte("[]"), user, "editor", time.Now())
	if gateAllowed(truncatedGate) || truncatedGate["reason"] != "privacy_findings_truncated" {
		t.Fatalf("truncated warning list must remain blocked: %#v", truncatedGate)
	}
}

func TestCXBuildOutputSelectionExcludesIntermediateHTML(t *testing.T) {
	base := cxBuildArtifact{ID: uuid.New(), Kind: "html", Name: "source.html"}
	stable := cxBuildArtifact{ID: uuid.New(), Kind: "stable_html", Name: "frozen-r2-stable.html"}
	selected, apiError := cxSelectBuildOutputs([]string{"stable_html"}, []cxBuildArtifact{base, stable}, []cxBuildArtifactSubmission{{ArtifactID: stable.ID.String(), Kind: stable.Kind, Name: stable.Name}})
	if apiError != nil || len(selected) != 1 || selected[0].ID != stable.ID {
		t.Fatalf("stable build should expose only its selected archive: selected=%+v error=%v", selected, apiError)
	}
	_, apiError = cxSelectBuildOutputs([]string{"stable_html"}, []cxBuildArtifact{base, stable}, []cxBuildArtifactSubmission{
		{ArtifactID: base.ID.String(), Kind: base.Kind, Name: base.Name},
	})
	if apiError == nil || apiError.Code != "artifact_set_mismatch" {
		t.Fatalf("base HTML prerequisite must not be accepted as the selected output: error=%v", apiError)
	}
}

func TestCXBuildManifestDownloadUsesCanonicalBytesAndSharedGate(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "清单下载"}, &work)
	_, build := cxBuildCreateForTest(t, work.ID.String(), work.Revision, []string{"wechat_html"})
	manifest := map[string]any{"schema": "ops.build-manifest/v1", "source_hash": build.SourceHash, "targets": []any{"wechat_html"}}
	manifestData, err := cxcanonicaljson.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestHash, err := cxcanonicaljson.Hash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	validation, err := json.Marshal(map[string]any{"privacy": cxPrivacyReport{
		ReportHash: "clear-report", ScannerOK: true, PolicyReady: true, Level: "clear", Findings: []cxPrivacyFinding{}, BlockedBy: []string{},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE work_build SET status='built',manifest=$2::jsonb,manifest_sha256=$3,error_detail=jsonb_build_object('validation',$4::jsonb),finished_at=now(),expires_at=now()+interval '1 hour' WHERE id=$1`, build.BuildID, string(manifestData), manifestHash, string(validation)); err != nil {
		t.Fatal(err)
	}
	response := env.request("GET", "/api/v1/builds/"+build.BuildID.String()+"/manifest.json", nil, "")
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !bytes.Equal(body, manifestData) || response.Header.Get("X-Content-SHA256") != manifestHash || response.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("manifest response did not preserve canonical bytes and download headers: status=%d headers=%v body=%s", response.StatusCode, response.Header, body)
	}
	if !cxBuildManifestHashValid(body, manifestHash) {
		t.Fatal("downloaded manifest does not match its immutable digest")
	}
}
