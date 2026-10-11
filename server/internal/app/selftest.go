package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"ops/internal/ai"
)

// DEV-U101（12 文档）：模型供应商能力自检。一次探测 对话连通 / JSON 模式 / 流式输出 /
// 文生图 / 原生联网搜索 五项能力，给出每项成败、耗时与可读诊断；接口地址没有已核验的
// 搜索契约时跳过搜索项。自检直接调用 ai 适配层、不写 ai_call，避免污染用量统计与质量看板。
func (s *Server) selftestProvider(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	ws := ident(ctx).WorkspaceID
	var in struct {
		Model string `json:"model"`
	}
	_ = decode(r, &in)
	var base string
	var enc []byte
	var models []string
	if err := s.db.QueryRow(ctx, `SELECT base_url, api_key_enc, models FROM model_provider WHERE id=$1 AND workspace_id=$2`, id, ws).Scan(&base, &enc, &models); err != nil {
		return err
	}
	key, err := s.box.Decrypt(enc)
	if err != nil {
		return err
	}
	model := strings.TrimSpace(in.Model)
	if model == "" && len(models) > 0 {
		model = models[0]
	}
	if model == "" {
		return validation("该供应商没有配置可用模型")
	}

	type probe struct {
		Key       string `json:"key"`
		Label     string `json:"label"`
		OK        bool   `json:"ok"`
		Skipped   bool   `json:"skipped"`
		LatencyMS int64  `json:"latency_ms"`
		Detail    string `json:"detail"`
	}
	results := []probe{}
	mask := func(err error) string {
		return truncate(strings.ReplaceAll(err.Error(), key, "****"), 300)
	}
	run := func(key, label string, fn func(ctx context.Context) (string, error)) {
		pctx, cancel := context.WithTimeout(ctx, 25*time.Second)
		defer cancel()
		start := time.Now()
		detail, perr := fn(pctx)
		p := probe{Key: key, Label: label, LatencyMS: time.Since(start).Milliseconds()}
		if perr != nil {
			p.Detail = mask(perr)
		} else {
			p.OK = true
			p.Detail = truncate(detail, 200)
		}
		results = append(results, p)
	}

	run("chat", "对话连通", func(ctx context.Context) (string, error) {
		text, _, err := ai.Stream(ctx, s.aiHTTP, ai.Request{BaseURL: base, APIKey: key, Model: model,
			Messages: []ai.Message{{Role: "user", Content: "请只回复：连接正常\n\n任务：connectivity_test"}}}, nil)
		if err != nil {
			return "", err
		}
		return "回复：" + truncate(text, 40), nil
	})
	run("json", "JSON 模式", func(ctx context.Context) (string, error) {
		text, _, err := ai.Stream(ctx, s.aiHTTP, ai.Request{BaseURL: base, APIKey: key, Model: model, JSON: true,
			Messages: []ai.Message{{Role: "user", Content: "只输出一个 JSON 对象：{\"ok\":true}，不要输出任何其他内容。\n\n任务：material_tag"}}}, nil)
		if err != nil {
			return "", err
		}
		var v map[string]any
		if e := json.Unmarshal([]byte(ai.ExtractJSON(text)), &v); e != nil {
			return "", fmt.Errorf("输出不是可解析的 JSON（任务需要 JSON 输出，请检查模型是否支持 JSON 模式）：%s", truncate(text, 80))
		}
		return "JSON 输出可解析", nil
	})
	run("stream", "流式输出", func(ctx context.Context) (string, error) {
		chunks := 0
		_, _, err := ai.Stream(ctx, s.aiHTTP, ai.Request{BaseURL: base, APIKey: key, Model: model,
			Messages: []ai.Message{{Role: "user", Content: "请用大约 60 字概括一位内容作者的写作风格。\n\n任务：style_summary"}}}, func(string) { chunks++ })
		if err != nil {
			return "", err
		}
		if chunks < 2 {
			return "", fmt.Errorf("没有收到分块的流式输出（收到 %d 块），逐段起草的实时显示会退化", chunks)
		}
		return fmt.Sprintf("收到 %d 个流式分块", chunks), nil
	})
	run("image", "文生图", func(ctx context.Context) (string, error) {
		res, err := ai.GenerateImage(ctx, s.aiHTTP, ai.ImageRequest{BaseURL: base, APIKey: key, Model: model,
			Prompt: "自检测试图：浅蓝底色上的一个圆形，画面干净", Size: "256x256"})
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("返回图片 %d 字节（%s）", len(res.Bytes), res.MIME), nil
	})
	if endpoint, okE := s.searchEndpoint(base); okE {
		run("search", "原生联网搜索", func(ctx context.Context) (string, error) {
			res, _, err := ai.Search(ctx, s.aiHTTP, endpoint, key, model, "内容运营 自检")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("返回 %d 条带来源的结果", len(res)), nil
		})
	} else {
		results = append(results, probe{Key: "search", Label: "原生联网搜索", Skipped: true,
			Detail: "该接口地址没有已核验的原生联网搜索契约（目前支持百炼 DashScope 与火山方舟），已跳过"})
	}

	passed := 0
	usable := 0
	for _, p := range results {
		if p.Skipped {
			continue
		}
		usable++
		if p.OK {
			passed++
		}
	}
	allOK := usable > 0 && passed == usable
	summary := fmt.Sprintf("自检完成：%d/%d 项通过（模型 %s）", passed, usable, model)
	if _, err := s.db.Exec(ctx, `UPDATE model_provider SET last_test_at=now(), last_test_ok=$2, last_test_result=$3 WHERE id=$1 AND workspace_id=$4`,
		id, allOK, summary, ws); err != nil {
		return err
	}
	return ok(w, map[string]any{"model": model, "summary": summary, "ok": allOK, "results": results})
}
