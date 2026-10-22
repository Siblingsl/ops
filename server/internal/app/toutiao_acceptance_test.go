package app

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Exercise the API and source mappings, rather than only the allow-list helper.
func TestToutiaoAcceptanceSixDerivationAPIRoutes(t *testing.T) {
	accounts := map[string]Account{}
	works := map[string]Work{}
	for _, platform := range []string{"wechat_mp", "xhs", "toutiao"} {
		format := "long_article"
		if platform == "xhs" {
			format = "image_note"
		}
		var account Account
		env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": platform, "name": "派生 API 验收 " + platform, "content_format": format}, &account)
		accounts[platform] = account
		works[platform] = env.readyWork(t, account, "用已有事实说明一个可以执行的小步骤。")
	}
	cases := []struct{ source, target, format string }{
		{"wechat_mp", "toutiao", "long_article"},
		{"wechat_mp", "toutiao", "micro_post"},
		{"xhs", "toutiao", "long_article"},
		{"xhs", "toutiao", "micro_post"},
		{"toutiao", "wechat_mp", "long_article"},
		{"toutiao", "xhs", "image_note"},
	}
	for _, tc := range cases {
		t.Run(tc.source+"_to_"+tc.target+"_"+tc.format, func(t *testing.T) {
			source := works[tc.source]
			target := accounts[tc.target]
			input := map[string]any{"target_account_id": target.ID}
			if target.Platform == "toutiao" {
				input["target_content_format"] = tc.format
			}
			var derived Work
			env.mustJSON(t, "POST", "/api/v1/works/"+source.ID.String()+"/derive", input, &derived)
			if derived.ContentFormat != tc.format || derived.AccountID != target.ID || derived.Source == nil || derived.Source.ID != source.ID {
				t.Fatalf("wrong target or source snapshot: %+v", derived)
			}
			var sourceRevision int
			if err := env.srv.db.QueryRow(context.Background(), `SELECT source_revision FROM work WHERE id=$1`, derived.ID).Scan(&sourceRevision); err != nil || sourceRevision != source.Revision {
				t.Fatalf("source revision=%d want=%d err=%v", sourceRevision, source.Revision, err)
			}
			if derived.Status != "drafting" || derived.Locked || derived.ReviewedAt != nil || derived.PublishedAt != nil || len(derived.Assets) != 0 {
				t.Fatalf("derived work inherited release state or images: %+v", derived)
			}
			validIDs := map[uuid.UUID]bool{}
			for _, section := range source.Sections {
				validIDs[section.ID] = true
			}
			if len(derived.Sections) == 0 {
				t.Fatal("derive API returned no sections")
			}
			for _, section := range derived.Sections {
				if len(section.SourceSectionIDs) == 0 {
					t.Fatal("derived section lost its source mapping")
				}
				for _, id := range section.SourceSectionIDs {
					if !validIDs[id] {
						t.Fatalf("derived section references another work: %s", id)
					}
				}
				if event := lastEvent(t, env.sse(t, "/api/v1/sections/"+section.ID.String()+"/rewrite", nil)); event.Name != "done" {
					t.Fatalf("section rewrite failed: %s %s", event.Name, event.Data)
				}
			}
		})
	}
}

func TestToutiaoAcceptancePackStaleCorruptAndReadOnly(t *testing.T) {
	account := drAccount(t, "toutiao", "头条包错误边界验收")
	work := env.readyWork(t, account, "先完成一个明确步骤。")
	section := work.Sections[0]
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{
		"content_md": "正文图片。\n\n![说明](/api/v1/assets/" + work.Assets[0].ID.String() + "/file)", "base_revision": section.Revision,
	}, nil)
	env.confirmChecks(t, work.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	path := "/api/v1/works/" + work.ID.String() + "/toutiao/pack"
	env.mustJSON(t, "POST", path, map[string]int{"basis_revision": work.Revision}, nil)
	env.mustJSON(t, "POST", path, map[string]int{"basis_revision": work.Revision}, nil)
	for _, suffix := range []string{"", ".zip"} {
		env.expectErr(t, "GET", path+suffix, nil, "validation_failed")
		response := env.request("GET", path+suffix+"?basis_revision="+strconv.Itoa(work.Revision-1), nil, "")
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != 409 || strings.HasPrefix(response.Header.Get("Content-Type"), "application/zip") {
			t.Fatalf("stale %s request: status=%d body=%s err=%v", suffix, response.StatusCode, body, err)
		}
	}
	var storage string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT storage_path FROM asset WHERE id=$1`, work.Assets[0].ID).Scan(&storage); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storage))
	original, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.WriteFile(file, original, 0o600); err != nil {
			t.Error(err)
		}
	})
	if err := os.WriteFile(file, []byte("damaged test image"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := env.request("GET", path+".zip?basis_revision="+strconv.Itoa(work.Revision), nil, "")
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 409 || strings.HasPrefix(response.Header.Get("Content-Type"), "application/zip") {
		t.Fatalf("corrupt image must fail before ZIP headers: status=%d body=%s err=%v", response.StatusCode, body, err)
	}
	if err := os.WriteFile(file, original, 0o600); err != nil {
		t.Fatal(err)
	}
	var packed Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &packed)
	if packed.Status != "packed" || packed.Revision != work.Revision {
		t.Fatalf("pack read or failed ZIP changed work: %+v", packed)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='published',locked=true,published_at=now() WHERE id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "POST", path, map[string]int{"basis_revision": work.Revision}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &packed)
	if packed.Status != "published" || !packed.Locked {
		t.Fatalf("pack downgraded published work: %+v", packed)
	}
}

func TestToutiaoAcceptanceImpressionsOnlyRevisionRejectsStaleWrites(t *testing.T) {
	account := drAccount(t, "toutiao", "展现并发验收")
	published := env.srv.today().AddDate(0, 0, -3)
	work := drWork(t, account, "只改展现", "published", &published)
	var metric Metric
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/metrics", map[string]any{"captured_at": published.Add(time.Hour), "impressions": 1000, "reads": 100}, &metric)
	path := "/api/v1/metrics/" + metric.ID.String()
	base := metric.Revision
	env.mustJSON(t, "PATCH", path, map[string]any{"base_revision": base, "impressions": 2000, "reads": 100}, &metric)
	if metric.Revision != base+1 || metric.Impressions == nil || *metric.Impressions != 2000 || metric.Reads == nil || *metric.Reads != 100 {
		t.Fatalf("impressions-only change failed: %+v", metric)
	}
	assertMetricAudit(t, metric.ID.String(), "metric_update", "manual", map[string]any{"impressions": float64(1000)}, map[string]any{"impressions": float64(2000)})
	env.expectErr(t, "PATCH", path, map[string]any{"base_revision": base, "impressions": 3000}, "state_invalid")
	env.expectErr(t, "DELETE", path+"?base_revision="+strconv.Itoa(base), nil, "state_invalid")
	var stored int64
	if err := env.srv.db.QueryRow(context.Background(), `SELECT impressions FROM metric_snapshot WHERE id=$1`, metric.ID).Scan(&stored); err != nil || stored != 2000 {
		t.Fatalf("stale operation mutated row: impressions=%d err=%v", stored, err)
	}
}
