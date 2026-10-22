package app

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"testing"
)

// D-048 复现：账号历史上被切成图文（直改库模拟遗留数据）后，旧漫画作品必须仍按
// 自身快照执行分镜、逐格文案与打包；新作品按锁定后的账号类型创建。
func TestD048HistoricalWorkSnapshot(t *testing.T) {
	_ = env.accounts(t)
	var comic Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]any{"platform": "xhs", "name": "遗留漫画号", "content_format": "comic"}, &comic)
	ap := "/api/v1/accounts/" + comic.ID.String()
	var char CharacterCard
	env.mustJSON(t, "POST", ap+"/characters", map[string]string{"name": "小周", "appearance": "短发圆眼镜", "personality": "谨慎"}, &char)
	var wk Work
	env.mustJSON(t, "POST", ap+"/works", map[string]string{"title": "历史漫画"}, &wk)
	wid := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wid, map[string]string{"viewpoint": "把复杂的事情拆成几格说清楚"}, nil)
	var gen struct {
		Panels []ComicPanel `json:"panels"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wid+"/storyboard/generate", map[string]any{"panel_count": 2, "character_ids": []string{char.ID.String()}}, &gen)
	env.mustJSON(t, "PUT", "/api/v1/works/"+wid+"/storyboard", map[string]any{"panels": gen.Panels, "confirm": true}, &wk)
	for _, panel := range wk.Panels {
		env.mustJSON(t, "POST", "/api/v1/panels/"+panel.ID.String()+"/generate-image", nil, nil)
	}
	env.upload(t, wid, testPNG(300, 300))
	var panelAssets int
	if e := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM comic_panel WHERE work_id=$1 AND asset_id IS NOT NULL`, wk.ID).Scan(&panelAssets); e != nil || panelAssets != 2 {
		t.Fatalf("panel image: %d %v", panelAssets, e)
	}

	// 模拟升级前的“确认切换类型”遗留状态。
	if _, e := env.srv.db.Exec(context.Background(), `UPDATE platform_account SET content_format='image_note' WHERE id=$1`, comic.ID); e != nil {
		t.Fatal(e)
	}

	// 历史漫画作品的漫画接口按作品快照继续可用。
	env.mustJSON(t, "POST", "/api/v1/works/"+wid+"/storyboard/generate", map[string]any{"panel_count": 2, "character_ids": []string{char.ID.String()}}, &gen)
	env.mustJSON(t, "POST", "/api/v1/panels/"+wk.Panels[0].ID.String()+"/text", nil, nil)

	// 打包只取分格图，不混入普通图片资产。
	env.confirmChecks(t, wid)
	if _, e := env.srv.db.Exec(context.Background(), `UPDATE work SET status='packed' WHERE id=$1`, wk.ID); e != nil {
		t.Fatal(e)
	}
	resp := env.request("GET", "/api/v1/works/"+wid+"/xhs/pack.zip", nil, "")
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("pack.zip: %d %s", resp.StatusCode, b)
	}
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 2 {
		t.Fatalf("pack should contain only the two panel images, got %d files", len(zr.File))
	}

	// 切换后的账号只按锁定类型新建作品。
	var wk2 Work
	env.mustJSON(t, "POST", ap+"/works", map[string]string{"title": "切换后新作"}, &wk2)
	if wk2.ContentFormat != "image_note" {
		t.Fatalf("new work format: %s", wk2.ContentFormat)
	}
}
