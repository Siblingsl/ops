package app

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func ttReady(t *testing.T, format string) Work {
	t.Helper()
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "toutiao", "name": "头条验收 " + format, "content_format": format}, &account)
	return env.readyWork(t, account, "把亲自观察到的事情说清楚，先完成一小步。")
}

func ttMaterial(t *testing.T, work *Work) Material {
	t.Helper()
	var material Material
	env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": work.AccountID, "kind": "experience", "content": "整理桌面后更容易找到文件，这是亲身观察。", "source": "本人记录", "valid_until": env.srv.today().AddDate(0, 0, 3).Format("2006-01-02")}, &material)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"material_ids": []uuid.UUID{material.ID}, "base_revision": work.Revision}, nil)
	env.confirmChecks(t, work.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, work)
	return material
}

type ttCommitBarrier struct {
	entered chan struct{}
	release chan struct{}
	used    atomic.Bool
}

type ttCommitKey struct{}

func (b *ttCommitBarrier) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, ttCommitKey{}, strings.EqualFold(strings.TrimSpace(data.SQL), "commit"))
}

func (b *ttCommitBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if commit, _ := ctx.Value(ttCommitKey{}).(bool); commit && data.Err == nil && b.used.CompareAndSwap(false, true) {
		close(b.entered)
		select {
		case <-b.release:
		case <-ctx.Done():
		}
	}
}

// A query tracer pauses after the read transaction commits, before files are read.
// This exercises the real handlers without adding a production test hook.
func TestToutiaoPackConcurrentTextAndMaterialChange(t *testing.T) {
	for _, method := range []string{"POST", "GET", "ZIP"} {
		for _, mutation := range []string{"text", "material"} {
			t.Run(method+"_"+mutation, func(t *testing.T) {
				work := ttReady(t, "micro_post")
				material := ttMaterial(t, &work)
				path := "/api/v1/works/" + work.ID.String() + "/toutiao/pack"
				env.mustJSON(t, "POST", path, map[string]int{"basis_revision": work.Revision}, nil)
				barrier := &ttCommitBarrier{entered: make(chan struct{}), release: make(chan struct{})}
				cfg := env.srv.db.Config()
				cfg.ConnConfig.Tracer = barrier
				pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer pool.Close()
				srv, err := New(env.srv.cfg, pool)
				if err != nil {
					t.Fatal(err)
				}
				srv.now = env.srv.now
				hs := httptest.NewServer(srv.Router())
				defer hs.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				requestMethod, requestPath := method, path+"?basis_revision="+strconv.Itoa(work.Revision)
				var input io.Reader
				if method == "POST" {
					requestPath = path
					input = strings.NewReader(`{"basis_revision":` + strconv.Itoa(work.Revision) + `}`)
				} else if method == "ZIP" {
					requestMethod, requestPath = "GET", path+".zip?basis_revision="+strconv.Itoa(work.Revision)
				}
				req, _ := http.NewRequestWithContext(ctx, requestMethod, hs.URL+requestPath, input)
				req.Header.Set("X-CSRF-Token", env.csrf)
				req.Header.Set("Content-Type", "application/json")
				result := make(chan *http.Response, 1)
				requestError := make(chan error, 1)
				go func() {
					response, err := env.client.Do(req)
					if err != nil {
						requestError <- err
					} else {
						result <- response
					}
				}()
				select {
				case <-barrier.entered:
				case err := <-requestError:
					t.Fatal(err)
				case <-ctx.Done():
					t.Fatal("pack read did not reach the commit barrier")
				}
				if mutation == "text" {
					section := work.Sections[0]
					env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{"content_md": "包构建期间保存的新正文。", "base_revision": section.Revision}, nil)
				} else {
					if _, err := env.srv.db.Exec(context.Background(), `UPDATE material SET content=content || '（依据已修订）' WHERE id=$1`, material.ID); err != nil {
						t.Fatal(err)
					}
				}
				close(barrier.release)
				select {
				case response := <-result:
					defer response.Body.Close()
					body, _ := io.ReadAll(response.Body)
					if response.StatusCode != 409 || strings.HasPrefix(response.Header.Get("Content-Type"), "application/zip") {
						t.Fatalf("concurrent mutation escaped final validation: status=%d body=%s", response.StatusCode, body)
					}
				case err := <-requestError:
					t.Fatal(err)
				case <-ctx.Done():
					t.Fatal("pack request did not finish")
				}
			})
		}
	}
}

func TestToutiaoPackRejectsInvalidMaterialBasis(t *testing.T) {
	for _, change := range []string{"edit", "delete", "invisible", "expired"} {
		t.Run(change, func(t *testing.T) {
			work := ttReady(t, "long_article")
			material := ttMaterial(t, &work)
			path := "/api/v1/works/" + work.ID.String() + "/toutiao/pack"
			env.mustJSON(t, "POST", path, map[string]int{"basis_revision": work.Revision}, nil)
			switch change {
			case "edit":
				_, err := env.srv.db.Exec(context.Background(), `UPDATE material SET content=content || '更新' WHERE id=$1`, material.ID)
				if err != nil {
					t.Fatal(err)
				}
			case "delete":
				env.mustJSON(t, "DELETE", "/api/v1/materials/"+material.ID.String(), nil, nil)
			case "invisible":
				other := drAccount(t, "toutiao", "不同账号的私有素材")
				_, err := env.srv.db.Exec(context.Background(), `UPDATE material SET account_id=$2 WHERE id=$1`, material.ID, other.ID)
				if err != nil {
					t.Fatal(err)
				}
			case "expired":
				oldNow := env.srv.now
				t.Cleanup(func() { env.srv.now = oldNow })
				expires := oldNow().In(env.srv.loc).AddDate(0, 0, 4)
				env.srv.now = func() time.Time { return expires }
			}
			env.expectErr(t, "POST", path, map[string]int{"basis_revision": work.Revision}, "material_basis_stale")
			for _, suffix := range []string{"", ".zip"} {
				env.expectErr(t, "GET", path+suffix+"?basis_revision="+strconv.Itoa(work.Revision), nil, "material_basis_stale")
			}
			run := env.latestCheck(t, work.ID.String())
			if !run.MaterialBasisStale {
				t.Fatal("latest check still claims its old material basis is current")
			}
		})
	}
}

func TestToutiaoPackFilesOrderUnusedAssetsAndFailureBeforeHeaders(t *testing.T) {
	for _, format := range []string{"long_article", "micro_post"} {
		t.Run(format, func(t *testing.T) {
			work := ttReady(t, format)
			second := env.upload(t, work.ID.String(), testPNG(320, 240))
			first := work.Assets[0]
			section := work.Sections[0]
			text := "第一段：先观察。\n\n第二段：再行动。"
			if format == "long_article" {
				text += "\n\n![图](/api/v1/assets/" + first.ID.String() + "/file)"
			}
			env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{"content_md": text, "base_revision": section.Revision}, nil)
			if _, err := env.srv.db.Exec(context.Background(), `UPDATE asset SET position=CASE id WHEN $2 THEN 0 ELSE 1 END WHERE work_id=$1`, work.ID, second.ID); err != nil {
				t.Fatal(err)
			}
			env.confirmChecks(t, work.ID.String())
			env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
			path := "/api/v1/works/" + work.ID.String() + "/toutiao/pack"
			var view toutiaoPackView
			env.mustJSON(t, "POST", path, map[string]int{"basis_revision": work.Revision}, &view)
			if strings.Index(view.BodyText, "第一段") >= strings.Index(view.BodyText, "第二段") {
				t.Fatal("paragraph order changed")
			}
			if format == "long_article" && (len(view.Images) != 1 || view.Images[0].AssetID != first.ID) {
				t.Fatal("article included an unreferenced image")
			}
			if format == "micro_post" && (len(view.Images) != 2 || view.Images[0].AssetID != second.ID || view.Images[1].AssetID != first.ID) {
				t.Fatalf("micro image order=%+v", view.Images)
			}
			var storage string
			if err := env.srv.db.QueryRow(context.Background(), `SELECT storage_path FROM asset WHERE id=$1`, first.ID).Scan(&storage); err != nil {
				t.Fatal(err)
			}
			fullPath := filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(storage))
			original, err := os.ReadFile(fullPath)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(fullPath); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.WriteFile(fullPath, original, 0o600) })
			response := env.request("GET", path+".zip?basis_revision="+strconv.Itoa(work.Revision), nil, "")
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != 409 || strings.HasPrefix(response.Header.Get("Content-Type"), "application/zip") {
				t.Fatalf("missing image: %d %s", response.StatusCode, body)
			}
			if err := os.Mkdir(fullPath, 0o700); err != nil {
				t.Fatal(err)
			}
			response = env.request("GET", path+".zip?basis_revision="+strconv.Itoa(work.Revision), nil, "")
			body, _ = io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != 500 || strings.HasPrefix(response.Header.Get("Content-Type"), "application/zip") {
				t.Fatalf("image read error: %d %s", response.StatusCode, body)
			}
			if err := os.Remove(fullPath); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestToutiaoZipRejectsTraversalAndPropagatesStorageFailure(t *testing.T) {
	for _, name := range []string{"../secret", "images/../../secret", `images\secret`, filepath.Join(os.TempDir(), "secret")} {
		var output bytes.Buffer
		writer := zip.NewWriter(&output)
		if err := writeToutiaoZipEntry(writer, name, []byte("private")); err == nil {
			t.Fatalf("accepted unsafe filename %q", name)
		}
		_ = writer.Close()
	}
	want := errors.New("simulated disk full")
	writer := zip.NewWriter(failingPackWriter{err: want})
	writeErr := writeToutiaoZipEntry(writer, "body.txt", bytes.Repeat([]byte("a"), 1024))
	closeErr := writer.Close()
	if !errors.Is(writeErr, want) && !errors.Is(closeErr, want) {
		t.Fatalf("lost ZIP write/close error: write=%v close=%v", writeErr, closeErr)
	}
	if err := writeToutiaoPackZip(failingPackWriter{err: want}, map[string][]byte{"body.txt": []byte("正文")}); !errors.Is(err, want) {
		t.Fatalf("handler's ZIP writer discarded close failure: %v", err)
	}
}

func TestToutiaoPackReadOnlyNoWechatRecordsAndTemporaryCleanup(t *testing.T) {
	work := ttReady(t, "micro_post")
	path := "/api/v1/works/" + work.ID.String() + "/toutiao/pack"
	env.mustJSON(t, "POST", path, map[string]int{"basis_revision": work.Revision}, nil)
	ctx := context.Background()
	var before, after string
	if err := env.srv.db.QueryRow(ctx, `SELECT to_jsonb(w)::text FROM work w WHERE id=$1`, work.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	temp := t.TempDir()
	t.Setenv("TMP", temp)
	t.Setenv("TEMP", temp)
	env.mustJSON(t, "GET", path+"?basis_revision="+strconv.Itoa(work.Revision), nil, nil)
	response := env.request("GET", path+".zip?basis_revision="+strconv.Itoa(work.Revision), nil, "")
	files := readToutiaoZip(t, response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || len(files) == 0 {
		t.Fatal("valid ZIP failed")
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT to_jsonb(w)::text FROM work w WHERE id=$1`, work.ID).Scan(&after); err != nil || before != after {
		t.Fatal("GET/ZIP changed persisted work state")
	}
	var pushes int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM push_record WHERE work_id=$1`, work.ID).Scan(&pushes); err != nil || pushes != 0 {
		t.Fatalf("Toutiao package created WeChat history: %d %v", pushes, err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		entries, err := os.ReadDir(temp)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("temporary ZIP was not removed")
		}
		time.Sleep(time.Millisecond)
	}
	blocked := filepath.Join(temp, "not-a-directory")
	if err := os.WriteFile(blocked, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMP", blocked)
	t.Setenv("TEMP", blocked)
	response = env.request("GET", path+".zip?basis_revision="+strconv.Itoa(work.Revision), nil, "")
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 500 || strings.HasPrefix(response.Header.Get("Content-Type"), "application/zip") {
		t.Fatalf("temporary storage failure emitted ZIP header: %d %s", response.StatusCode, body)
	}
}
