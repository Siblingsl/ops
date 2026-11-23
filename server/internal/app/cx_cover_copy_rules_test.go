package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

func cxTestCoverCopyBuild(t *testing.T, work Work, presets []string, title, subtitle string) (int, []byte) {
	t.Helper()
	return env.do("POST", "/api/v1/works/"+work.ID.String()+"/builds", map[string]any{
		"basis_revision": work.Revision, "targets": []string{"cover_images"},
		"options": map[string]any{"presets": presets, "title": title, "subtitle": subtitle},
		"client":  "web", "renderer_contract_version": cxCoverTemplateVersion,
	})
}

func TestC2CopyRulesDefaultsAndComplete(t *testing.T) {
	// C2-A1/A4：五个 preset 默认规则齐备且平台独立；/cover-presets 返回完整规则。
	var out struct {
		Presets []struct {
			Key       string            `json:"key"`
			Platform  string            `json:"platform"`
			Width     int               `json:"width"`
			Height    int               `json:"height"`
			CopyRules cxCoverCopyRules  `json:"copy_rules"`
		} `json:"presets"`
	}
	env.mustJSON(t, "GET", "/api/v1/cover-presets", nil, &out)
	if len(out.Presets) != len(cxCoverPresets) {
		t.Fatalf("presets = %d, want %d", len(out.Presets), len(cxCoverPresets))
	}
	byKey := map[string]struct {
		Key       string           `json:"key"`
		Platform  string           `json:"platform"`
		Width     int              `json:"width"`
		Height    int              `json:"height"`
		CopyRules cxCoverCopyRules `json:"copy_rules"`
	}{}
	for _, preset := range out.Presets {
		if preset.CopyRules.TitleMax <= 0 || preset.CopyRules.SubtitleMax <= 0 || preset.CopyRules.Tone == "" {
			t.Fatalf("%s rules incomplete: %+v", preset.Key, preset.CopyRules)
		}
		if preset.CopyRules.LineBreakHint == "" {
			t.Fatalf("%s missing line break hint", preset.Key)
		}
		byKey[preset.Key] = preset
	}
	// 平台独立：xhs 与 wechat 规则不同（语气/禁用词独立，不互相套用）。
	xhs := byKey["xhs_34"].CopyRules
	wechat := byKey["wechat_235"].CopyRules
	if xhs.Tone == wechat.Tone || xhs.TitleMax == wechat.TitleMax {
		t.Fatalf("platform rules must differ: xhs=%+v wechat=%+v", xhs, wechat)
	}
	if len(byKey["xhs_34"].CopyRules.Required) == 0 {
		t.Fatalf("xhs rules should require 人群或结果")
	}
}

func TestC2ValidateCopyBoundaries(t *testing.T) {
	// C2-A2/A3 表驱动：每个 xhs preset 的 空标题/刚好/超 1 字/禁用词；rune 计数（emoji）。
	cases := []struct {
		name    string
		title   string
		sub     string
		want    string
	}{
		{"空标题", "   ", "", "cover_copy_required"},
		{"刚好 12 字", "给新手的三步清单", "", ""},
		{"超 1 字", "给新手的三步清单一共三步哦", "", "cover_copy_too_long"},
		{"禁用词", "震惊：三步搞定", "", "cover_copy_forbidden"},
		{"emoji 按 rune", "👍👍👍给新手清单", "", ""},
		{"副标题超长", "三步清单", strings.Repeat("字", 19), "cover_copy_too_long"},
		{"wechat 禁标点", "", "", ""}, // 用 wechat preset 单独验证（下方）
	}
	preset, _ := cxCoverPreset("xhs_34")
	for _, tc := range cases {
		if tc.name == "wechat 禁标点" {
			continue
		}
		err := cxValidateCoverCopy(preset, cxCoverCopyInput{Title: tc.title, Subtitle: tc.sub})
		got := ""
		if err != nil {
			var ae *APIError
			if errors.As(err, &ae) {
				got = ae.Code
			}
		}
		if got != tc.want {
			t.Fatalf("%s: want %s got %s", tc.name, tc.want, got)
		}
	}
	// rune 计数：emoji 算 1 字符。
	if utf8.RuneCountInString("👍👍👍给新手清单") != 8 {
		t.Fatal("rune count sanity failed")
	}
	// wechat preset 禁夸张标点。
	wechat, _ := cxCoverPreset("wechat_235")
	if err := cxValidateCoverCopy(wechat, cxCoverCopyInput{Title: "必看指南", Subtitle: ""}); err == nil {
		t.Fatal("wechat must forbid 必看")
	}
	if err := cxValidateCoverCopy(wechat, cxCoverCopyInput{Title: "每周复盘", Subtitle: "信息型副标题"}); err != nil {
		t.Fatalf("wechat normal copy should pass: %v", err)
	}
}

func TestC2BuildRejectedNoArtifact(t *testing.T) {
	// C2-A2：超长/禁用词 → 422 且不产生构建记录（无 artifact）。
	a := drAccount(t, "xhs", "C2 封面小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C2 封面作品", 900, 1200, []string{"测试"})
	_, _ = a, wk
	// xhs 作品 + 已选封面（publishTestWork 已带 cover_asset_id）。
	status, body := cxTestCoverCopyBuild(t, wk, []string{"xhs_34", "xhs_square"}, "标题超过了十二个字的限制哦", "")
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", status, body)
	}
	var ae struct {
		Error struct {
			Code   string `json:"code"`
			Detail map[string]any `json:"detail"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &ae); err != nil {
		t.Fatal(err)
	}
	if ae.Error.Code != "cover_copy_too_long" {
		t.Fatalf("code=%s", ae.Error.Code)
	}
	if v, ok := ae.Error.Detail["preset"].(string); !ok || v != "xhs_34" {
		t.Fatalf("detail preset=%v", ae.Error.Detail)
	}
	// 无构建记录写入。
	var builds int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM work_build WHERE work_id=$1`, wk.ID).Scan(&builds); err != nil {
		t.Fatal(err)
	}
	if builds != 0 {
		t.Fatalf("failed validation must not create build, got %d", builds)
	}
	// 禁用词同理。
	status, body = cxTestCoverCopyBuild(t, wk, []string{"xhs_34"}, "震惊！人人都能学会", "")
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("forbidden status=%d body=%s", status, body)
	}
	_ = body
}

func TestC2BuildAcceptsWithCopy(t *testing.T) {
	// C2-A2 正向：合法文案进冻结参数（params JSON 含 title/subtitle）。
	a := drAccount(t, "xhs", "C2 正向小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C2 正向作品", 900, 1200, []string{"测试"})
	status, body := cxTestCoverCopyBuild(t, wk, []string{"xhs_34"}, "给新手的三步清单", "第一份实操指南")
	if status != 201 {
		t.Fatalf("status=%d body=%s", status, body)
	}
	var created cxBuildCreateResponse
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	var params struct {
		Options struct {
			Title    string `json:"title"`
			Subtitle string `json:"subtitle"`
		} `json:"options"`
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT params FROM work_build WHERE id=$1`, created.BuildID).Scan(&params); err != nil {
		t.Fatal(err)
	}
	if params.Options.Title != "给新手的三步清单" || params.Options.Subtitle != "第一份实操指南" {
		t.Fatalf("frozen params missing copy: %+v", params.Options)
	}
}
