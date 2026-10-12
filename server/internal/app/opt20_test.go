package app

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOPT20DuplicateIndependentContentImagesAndNoPublicationData(t *testing.T) {
	guest := env.registerClient(t, "opt20-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var me struct {
		UserID uuid.UUID `json:"user_id"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	for _, format := range []string{"long_article", "card_post", "comic"} {
		t.Run(format, func(t *testing.T) {
			var a Account
			env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": format, "name": "复制验收"}, &a)
			ctx := v4Context(t, a)
			var src Work
			env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "原作品"}, &src)
			image := env.upload(t, src.ID.String(), testPNG(64, 64))
			exec := func(sql string, args ...any) {
				t.Helper()
				if _, err := env.srv.db.Exec(ctx, sql, args...); err != nil {
					t.Fatal(err)
				}
			}
			section := uuid.New()
			body := "原稿正文 ![图](" + image.URL + ")"
			exec(`INSERT INTO work_section(id,work_id,position,heading,key_point,content_md,origin) VALUES($1,$2,0,'小标题','要点',$3,'human')`, section, src.ID, body)
			outline := fmt.Sprintf(`[{"heading":"小标题","key_point":"要点","material_ids":[],"section_id":"%s"}]`, section)
			exec(`UPDATE work SET viewpoint='明确观点',outline=$2,outline_confirmed_at=now(),cover_asset_id=$3,status='published',locked=true,published_at=now(),published_url='https://example.invalid/local',wechat_draft_media_id='local-draft',revision=7 WHERE id=$1`, src.ID, outline, image.ID)
			exec(`UPDATE work SET review_required=true,reviewer_id=$2,reviewed_by=$2,reviewed_at=now() WHERE id=$1`, src.ID, me.UserID)
			exec(`INSERT INTO push_record(work_id,account_id,action,status) VALUES($1,$2,'add','ok')`, src.ID, a.ID)
			exec(`INSERT INTO metric_snapshot(work_id,captured_at,reads) VALUES($1,now(),123)`, src.ID)
			exec(`INSERT INTO check_run(work_id,revision,target_platform,completed_at) VALUES($1,7,'wechat_mp',now())`, src.ID)
			if format == "card_post" {
				exec(`INSERT INTO work_card(work_id,section_id,position,image_asset_id) VALUES($1,$2,0,$3)`, src.ID, section, image.ID)
			}
			if format == "comic" {
				exec(`INSERT INTO comic_panel(work_id,position,scene,narration,dialogue,asset_id) VALUES($1,0,'场景','原旁白','原对白',$2)`, src.ID, image.ID)
			}
			var copied Work
			env.mustJSON(t, "POST", "/api/v1/works/"+src.ID.String()+"/duplicate", nil, &copied)
			if copied.ID == src.ID || copied.AccountID != a.ID || copied.ContentFormat != format || copied.Title != "原作品（副本）" || copied.Viewpoint != "明确观点" {
				t.Fatalf("copy identity/content: %+v", copied)
			}
			if copied.Status != "drafting" || copied.Locked || copied.Revision != 1 || copied.OutlineConfirmedAt != nil || copied.Source != nil || copied.WechatDraftMediaID != nil || copied.PublishedAt != nil || copied.PublishedURL != nil {
				t.Fatalf("copy inherited workflow: %+v", copied)
			}
			if !copied.ReviewRequired || copied.ReviewerID == nil || *copied.ReviewerID != me.UserID || copied.ReviewedBy != nil || copied.ReviewedAt != nil {
				t.Fatal("review gate not preserved or old approval inherited")
			}
			if len(copied.Sections) != 1 || copied.Sections[0].ID == section || len(copied.Assets) != 1 || copied.Assets[0].ID == image.ID || copied.CoverAssetID == nil || *copied.CoverAssetID != copied.Assets[0].ID {
				t.Fatalf("copy identities: %+v", copied)
			}
			if copied.Outline[0].SectionID != copied.Sections[0].ID.String() || copied.Sections[0].ContentMD != strings.ReplaceAll(body, image.URL, copied.Assets[0].URL) {
				t.Fatal("outline/body image references not remapped")
			}
			if format == "card_post" && (len(copied.Cards) != 1 || copied.Cards[0].SectionID != copied.Sections[0].ID || *copied.Cards[0].ImageAssetID != copied.Assets[0].ID) {
				t.Fatal("card references not remapped")
			}
			if format == "comic" && (len(copied.Panels) != 1 || copied.Panels[0].Narration != "原旁白" || *copied.Panels[0].AssetID != copied.Assets[0].ID) {
				t.Fatal("panel content/images not copied")
			}
			for _, table := range []string{"push_record", "metric_snapshot", "check_run", "work_version"} {
				var count int
				if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE work_id=$1`, copied.ID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("%s=%d %v", table, count, err)
				}
			}
			env.mustJSON(t, "PATCH", "/api/v1/sections/"+copied.Sections[0].ID.String(), map[string]any{"content_md": "独立修改副本", "base_revision": 1}, nil)
			var original Work
			env.mustJSON(t, "GET", "/api/v1/works/"+src.ID.String(), nil, &original)
			if original.Sections[0].ContentMD != body || original.Revision != 7 || original.Title != "原作品" || original.Status != "published" {
				t.Fatal("original changed")
			}
			oldRow, _ := env.srv.assetRow(ctx, image.ID)
			newRow, err := env.srv.assetRow(ctx, copied.Assets[0].ID)
			if err != nil {
				t.Fatal(err)
			}
			oldBytes, _ := env.srv.assetBytes(oldRow)
			newBytes, _ := env.srv.assetBytes(newRow)
			if oldRow.StoragePath == newRow.StoragePath || !bytes.Equal(oldBytes, newBytes) {
				t.Fatal("image not independently cloned")
			}
			if err := os.WriteFile(filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(newRow.StoragePath)), []byte("changed copy"), 0o644); err != nil {
				t.Fatal(err)
			}
			unchanged, _ := env.srv.assetBytes(oldRow)
			if !bytes.Equal(unchanged, oldBytes) {
				t.Fatal("original image changed")
			}
			if format != "comic" {
				env.expectErr(t, "POST", "/api/v1/sections/"+copied.Sections[0].ID.String()+"/draft", nil, "human_step_required")
			}
		})
	}
}

func TestOPT20DuplicateScopeAndDisabledAccount(t *testing.T) {
	guest := env.registerClient(t, "opt20-scope-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	a, _ := v4Account(t, "复制权限")
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "源稿"}, &work)
	path := "/api/v1/works/" + work.ID.String() + "/duplicate"
	other := env.registerClient(t, "opt20-other-"+uuid.NewString()[:8], testPassword)
	other.expectErr(t, "POST", path, nil, "not_found")
	other.restore(env)
	var invite struct {
		Code string `json:"code"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &invite)
	viewer := env.registerClient(t, "opt20-viewer-"+uuid.NewString()[:8], testPassword)
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": invite.Code, "switch": true}, nil)
	var me struct {
		CSRF string `json:"csrf_token"`
	}
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	viewer.csrf = me.CSRF
	viewer.expectErr(t, "POST", path, nil, "forbidden")
	viewer.restore(env)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/disable", nil, nil)
	env.expectErr(t, "POST", path, nil, "state_invalid")
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/enable", nil, nil)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET deleted_at=now() WHERE id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", path, nil, "not_found")
}

func TestOPT20MissingImageLeavesNoDraftOrFiles(t *testing.T) {
	guest := env.registerClient(t, "opt20-files-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	a, _ := v4Account(t, "复制文件失败")
	ctx := v4Context(t, a)
	var src Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "源稿"}, &src)
	env.upload(t, src.ID.String(), testPNG(32, 32))
	missing := env.upload(t, src.ID.String(), testPNG(48, 48))
	row, err := env.srv.assetRow(ctx, missing.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(env.srv.cfg.DataDir, filepath.FromSlash(row.StoragePath))); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadDir(filepath.Join(env.srv.cfg.DataDir, "assets"))
	if err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", "/api/v1/works/"+src.ID.String()+"/duplicate", nil, "validation_failed")
	after, err := os.ReadDir(filepath.Join(env.srv.cfg.DataDir, "assets"))
	if err != nil || len(after) != len(before) {
		t.Fatalf("copy left files: before=%d after=%d %v", len(before), len(after), err)
	}
	var count int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1`, a.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("copy left draft: %d %v", count, err)
	}
}
