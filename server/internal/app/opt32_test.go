package app

import (
	"context"
	"testing"

	"ops/internal/wechat"
)

func TestOPT32PushReuploadsDeletedCachedMaterialOnce(t *testing.T) {
	a, wk := buildCardWork(t, "wechat_mp")
	env.confirmChecks(t, wk.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	if wk.Status != "ready" || len(wk.Cards) == 0 || wk.Cards[0].ImageAssetID == nil {
		t.Fatalf("work is not ready with a card image: status=%q cards=%d", wk.Status, len(wk.Cards))
	}

	env.reauth(t)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential",
		map[string]string{"app_id": "wx-opt32", "app_secret": "mock-secret-opt32"}, nil)
	var credential map[string]any
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential/test", nil, &credential)

	ctx := v4Context(t, a)
	token, err := env.srv.accessToken(ctx, a.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	asset, err := env.srv.assetRow(ctx, *wk.Cards[0].ImageAssetID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := env.srv.assetBytes(asset)
	if err != nil {
		t.Fatal(err)
	}
	materialHashes := map[string]struct{}{asset.SHA256: {}}
	for _, card := range wk.Cards {
		if card.ImageAssetID == nil {
			continue
		}
		cardAsset, err := env.srv.assetRow(ctx, *card.ImageAssetID)
		if err != nil {
			t.Fatal(err)
		}
		materialHashes[cardAsset.SHA256] = struct{}{}
	}
	staleID, imageURL, err := env.srv.wx.AddImageMaterial(ctx, token, asset.ID.String()+".png", data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO wechat_media_cache (account_id, sha256, kind, wechat_url, media_id) VALUES ($1,$2,'image',$3,$4)`, a.ID, asset.SHA256, imageURL, staleID); err != nil {
		t.Fatal(err)
	}
	env.mockWX.DeleteMaterial(staleID)

	callStart := len(env.mockWX.Calls())
	events := env.push(t, wk, nil)
	if event := lastEvent(t, events); event.Name != "done" {
		t.Fatalf("push after material deletion: %s %s", event.Name, event.Data)
	}
	calls := env.mockWX.Calls()[callStart:]
	var draftAdds, materialAdds int
	for _, path := range calls {
		switch path {
		case "/cgi-bin/draft/add":
			draftAdds++
		case "/cgi-bin/material/add_material":
			materialAdds++
		}
	}
	if draftAdds != 2 {
		t.Fatalf("draft/add calls = %d, want one failed attempt and one retry; calls=%v", draftAdds, calls)
	}
	if want := len(materialHashes); materialAdds != want {
		t.Fatalf("material/add_material calls = %d, want %d (one upload per distinct SHA-256 cache entry)", materialAdds, want)
	}
	var currentID string
	if err := env.srv.db.QueryRow(ctx, `SELECT media_id FROM wechat_media_cache WHERE account_id=$1 AND sha256=$2 AND kind='image'`, a.ID, asset.SHA256).Scan(&currentID); err != nil {
		t.Fatal(err)
	}
	if currentID == staleID {
		t.Fatal("deleted material ID remained in cache")
	}
}

func TestOPT32DraftMissingUsesDraftGetBeyond100Drafts(t *testing.T) {
	f := env.accounts(t)
	ctx := context.Background()
	token, err := env.srv.accessToken(ctx, f.wechat.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	thumbID, _, err := env.srv.wx.AddImageMaterial(ctx, token, "opt32.png", testPNG(100, 100))
	if err != nil {
		t.Fatal(err)
	}
	var targetID string
	for i := 0; i < 105; i++ {
		id, err := env.srv.wx.DraftAdd(ctx, token, wechat.Article{Title: "OPT32 草稿", Content: "测试草稿", ThumbMediaID: thumbID})
		if err != nil {
			t.Fatalf("create draft %d: %v", i+1, err)
		}
		targetID = id
	}

	callStart := len(env.mockWX.Calls())
	missing, err := env.srv.draftMissing(ctx, f.wechat.ID, targetID)
	if err != nil || missing {
		t.Fatalf("existing draft among 105 drafts: missing=%v err=%v", missing, err)
	}
	calls := env.mockWX.Calls()[callStart:]
	if len(calls) != 1 || calls[0] != "/cgi-bin/draft/get" {
		t.Fatalf("draft lookup calls = %v, want one draft/get", calls)
	}
	missing, err = env.srv.draftMissing(ctx, f.wechat.ID, "deleted-opt32-draft")
	if err != nil || !missing {
		t.Fatalf("missing draft lookup: missing=%v err=%v", missing, err)
	}

	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "OPT32 人工回填确认"}, &wk)
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET wechat_draft_media_id=$2 WHERE id=$1`, wk.ID, "deleted-opt32-draft"); err != nil {
		t.Fatal(err)
	}
	var result struct {
		MaybePublished bool   `json:"maybe_published"`
		Message        string `json:"message"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/wechat/sync-draft", nil, &result)
	if !result.MaybePublished || result.Message != "草稿已不在草稿箱，可能已经发表或被删除。请确认后回填已发布，系统不会自动改状态。" {
		t.Fatalf("missing draft response = %+v", result)
	}
	var current Work
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &current)
	if current.Status != wk.Status || !current.DraftMaybePublished {
		t.Fatalf("sync changed work state: status=%q want=%q maybe_published=%v", current.Status, wk.Status, current.DraftMaybePublished)
	}
}
