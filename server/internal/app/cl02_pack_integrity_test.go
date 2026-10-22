package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestCL02PackRejectsStaleBasisBeforeZipHeaders(t *testing.T) {
	_, wk := buildCardWork(t, "xhs")
	wid := wk.ID.String()
	env.confirmChecks(t, wid)
	env.mustJSON(t, "GET", "/api/v1/works/"+wid, nil, &wk)

	if wk.Revision < 2 {
		t.Fatalf("work revision unexpectedly low: %d", wk.Revision)
	}
	status, body := env.do("POST", "/api/v1/works/"+wid+"/xhs/pack", map[string]int{"basis_revision": wk.Revision - 1})
	if status != 409 || !strings.Contains(string(body), `"code":"version_conflict"`) {
		t.Fatalf("stale pack creation basis should conflict: %d %s", status, body)
	}

	packRequest, err := json.Marshal(map[string]int{"basis_revision": wk.Revision})
	if err != nil {
		t.Fatal(err)
	}
	packResponse := env.request("POST", "/api/v1/works/"+wid+"/xhs/pack", strings.NewReader(string(packRequest)), "application/json")
	if body, err := io.ReadAll(packResponse.Body); err != nil {
		t.Fatal(err)
	} else if packResponse.StatusCode != 200 {
		packResponse.Body.Close()
		t.Fatalf("pack creation failed: %d %s", packResponse.StatusCode, body)
	}
	if got := packResponse.Header.Get("X-OPS-Basis-Revision"); got != stringInt(wk.Revision) {
		packResponse.Body.Close()
		t.Fatalf("pack creation basis header = %q, want %d", got, wk.Revision)
	}
	packResponse.Body.Close()

	legacyResponse := env.request("GET", "/api/v1/works/"+wid+"/xhs/pack.zip", nil, "")
	if _, err := io.Copy(io.Discard, legacyResponse.Body); err != nil {
		t.Fatal(err)
	}
	legacyResponse.Body.Close()
	if legacyResponse.StatusCode != 200 || legacyResponse.Header.Get("X-OPS-Basis-Revision") != stringInt(wk.Revision) {
		t.Fatalf("legacy download must return its snapshot basis: status=%d basis=%q", legacyResponse.StatusCode, legacyResponse.Header.Get("X-OPS-Basis-Revision"))
	}
	path := "/api/v1/works/" + wid + "/xhs/pack.zip?" + url.Values{"basis_revision": []string{stringInt(wk.Revision - 1)}}.Encode()
	resp := env.request("GET", path, nil, "")
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 409 || strings.HasPrefix(resp.Header.Get("Content-Type"), "application/zip") {
		t.Fatalf("stale download basis must fail before ZIP headers: status=%d content-type=%q body=%s", resp.StatusCode, resp.Header.Get("Content-Type"), responseBody)
	}
	if !strings.Contains(string(responseBody), `"code":"version_conflict"`) {
		t.Fatalf("stale download basis error missing version_conflict: %s", responseBody)
	}
}

func TestCL02CardPackRejectsMissingRequiredImage(t *testing.T) {
	_, wk := buildCardWork(t, "xhs")
	wid := wk.ID.String()
	env.confirmChecks(t, wid)
	env.mustJSON(t, "GET", "/api/v1/works/"+wid, nil, &wk)
	env.mustJSON(t, "POST", "/api/v1/works/"+wid+"/xhs/pack", map[string]int{"basis_revision": wk.Revision}, nil)

	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work_card SET image_asset_id=NULL WHERE id=$1`, wk.Cards[0].ID); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/works/" + wid + "/xhs/pack.zip?basis_revision=" + stringInt(wk.Revision)
	resp := env.request("GET", path, nil, "")
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 409 || strings.HasPrefix(resp.Header.Get("Content-Type"), "application/zip") {
		t.Fatalf("missing required card image must fail before ZIP headers: status=%d content-type=%q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &failure); err != nil {
		t.Fatalf("missing-image response is not an API error: %v (%s)", err, body)
	}
	if failure.Error.Code != "state_invalid" {
		t.Fatalf("missing-image error code = %q, want state_invalid; body=%s", failure.Error.Code, body)
	}
}

func TestCL02PackRejectsCorruptAssetBeforeZipHeaders(t *testing.T) {
	_, wk := buildCardWork(t, "xhs")
	wid := wk.ID.String()
	env.confirmChecks(t, wid)
	env.mustJSON(t, "GET", "/api/v1/works/"+wid, nil, &wk)
	env.mustJSON(t, "POST", "/api/v1/works/"+wid+"/xhs/pack", map[string]int{"basis_revision": wk.Revision}, nil)

	var storagePath string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT a.storage_path FROM work_card c JOIN asset a ON a.id=c.image_asset_id WHERE c.id=$1`, wk.Cards[0].ID).Scan(&storagePath); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storagePath))
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer os.WriteFile(path, original, 0o600)
	corrupt := append([]byte(nil), original...)
	corrupt[0] ^= 0xff
	if err := os.WriteFile(path, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}

	resp := env.request("GET", "/api/v1/works/"+wid+"/xhs/pack.zip?basis_revision="+stringInt(wk.Revision), nil, "")
	defer resp.Body.Close()
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 409 || strings.HasPrefix(resp.Header.Get("Content-Type"), "application/zip") {
		t.Fatalf("corrupt asset must fail before ZIP headers: status=%d content-type=%q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
}

func TestWriteXhsPackZipPropagatesCloseError(t *testing.T) {
	want := errors.New("disk full")
	err := writeXhsPackZip(failingPackWriter{err: want}, nil, "", false, nil)
	if !errors.Is(err, want) {
		t.Fatalf("ZIP close error = %v, want %v", err, want)
	}
}

type failingPackWriter struct{ err error }

func (w failingPackWriter) Write([]byte) (int, error) { return 0, w.err }

func stringInt(v int) string {
	return strconv.Itoa(v)
}
