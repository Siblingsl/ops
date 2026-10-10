package mock

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// LLM is an OpenAI-compatible fake used for local development and tests. It never calls a
// real model. Replies are deterministic and derived from the prompt so the UI flow is testable.
type LLM struct {
	Delay time.Duration
}

type chatReq struct {
	Model    string `json:"model"`
	Stream   bool   `json:"stream"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}

func (l *LLM) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/images/generations", func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") == "bad-key" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"message":"Incorrect API key"}}`))
			return
		}
		// 1x1 PNG
		const png1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
		writeJSON(w, map[string]any{
			"created": time.Now().Unix(),
			"data":    []any{map[string]string{"b64_json": png1}},
		})
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") == "bad-key" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}`))
			return
		}
		var req chatReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(400)
			return
		}
		var sys, user string
		for _, m := range req.Messages {
			if m.Role == "system" {
				sys += m.Content
			} else if m.Role == "user" {
				user = m.Content
			}
		}
		reply := respond(user)
		promptTokens := utf8.RuneCountInString(sys+user) * 2 / 3
		completionTokens := utf8.RuneCountInString(reply) * 2 / 3
		usage := map[string]int{"prompt_tokens": promptTokens, "completion_tokens": completionTokens, "total_tokens": promptTokens + completionTokens}
		if !req.Stream {
			writeJSON(w, map[string]any{
				"id": "mock", "object": "chat.completion", "model": req.Model,
				"choices": []any{map[string]any{"index": 0, "message": map[string]string{"role": "assistant", "content": reply}, "finish_reason": "stop"}},
				"usage":   usage,
			})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fl, _ := w.(http.Flusher)
		runes := []rune(reply)
		delay := l.Delay
		for i := 0; i < len(runes); i += 6 {
			end := min(i+6, len(runes))
			chunk := map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": string(runes[i:end])}}}}
			b, _ := json.Marshal(chunk)
			fmt.Fprintf(w, "data: %s\n\n", b)
			if fl != nil {
				fl.Flush()
			}
			if delay > 0 {
				select {
				case <-r.Context().Done():
					return
				case <-time.After(delay):
				}
			}
		}
		b, _ := json.Marshal(map[string]any{"choices": []any{}, "usage": usage})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b)
		if fl != nil {
			fl.Flush()
		}
	})
	return mux
}

var taskRe = regexp.MustCompile(`任务：([a-z_]+)`)

func field(prompt, label string) string {
	for _, line := range strings.Split(prompt, "\n") {
		if strings.HasPrefix(line, label) {
			return strings.TrimSpace(strings.TrimPrefix(line, label))
		}
	}
	return ""
}

type block struct {
	ID, Head, Body string
}

var blockRe = regexp.MustCompile(`^【(?:源)?段落 id=([0-9a-f-]+)】(.*)$`)

func blocks(prompt string) []block {
	var out []block
	var cur *block
	for _, line := range strings.Split(prompt, "\n") {
		if m := blockRe.FindStringSubmatch(line); m != nil {
			out = append(out, block{ID: m[1], Head: strings.TrimPrefix(strings.TrimSpace(m[2]), "小标题：")})
			cur = &out[len(out)-1]
			continue
		}
		if strings.HasPrefix(line, "## ") {
			cur = nil
			continue
		}
		if cur != nil {
			cur.Body += line + "\n"
		}
	}
	return out
}

func short(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n])
}

func js(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func respond(prompt string) string {
	task := ""
	if m := taskRe.FindStringSubmatch(prompt); m != nil {
		task = m[1]
	}
	viewpoint := field(prompt, "核心观点：")
	if viewpoint == "" {
		viewpoint = "把复杂的事情讲清楚"
	}
	key := field(prompt, "本段要点：")
	heading := field(prompt, "本段小标题：")
	switch task {
	case "connectivity_test":
		return "连接正常"
	case "topic_suggest":
		dir := field(prompt, "方向关键词：")
		if dir == "" {
			dir = "日常经验"
		}
		var items []map[string]string
		angles := []string{"从一次真实经历切入", "拆解一个常见误区", "给出可直接照做的清单", "对比两种做法的得失", "回答读者最常问的问题", "复盘一次失败"}
		for i, a := range angles {
			items = append(items, map[string]string{
				"title":  fmt.Sprintf("%s：%s（%d）", dir, []string{"我踩过的坑", "大多数人想错了", "一张清单讲完", "两种选择怎么选", "被问了 100 遍的问题", "一次失败教会我的事"}[i], i+1),
				"angle":  a,
				"reason": "贴合账号定位，且与最近的选题不重复",
			})
		}
		return js(map[string]any{"topics": items})
	case "topic_hot_suggest":
		dir := field(prompt, "方向关键词：")
		if dir == "" {
			dir = "当下讨论"
		}
		var items []map[string]any
		titles := []string{"这周大家都在问的一件事", "换个角度谈季节性话题", "把公开资讯落到你的读者身上", "常青问题的新切口", "别追热榜，追读者真实困扰", "用亲身经历回应时事讨论"}
		for i, title := range titles {
			items = append(items, map[string]any{
				"title":      fmt.Sprintf("%s · %s", dir, title),
				"angle":      "结合账号定位，用可核实的个人经验回应时效话题",
				"reason":     "合规来源：不依赖平台热榜；待用户核实时效",
				"timeliness": []string{"本周讨论", "季节性", "常青+当下", "待核实", "读者痛点", "时事旁观"}[i],
			})
		}
		return js(map[string]any{"topics": items})
	case "outline":
		heads := []string{"先说结论", "为什么会这样", "我的亲身经历", "具体怎么做", "需要注意的地方"}
		var items []map[string]any
		for i, h := range heads {
			items = append(items, map[string]any{"heading": h, "key_point": fmt.Sprintf("围绕「%s」展开第 %d 层论述", short(viewpoint, 24), i+1), "material_ids": []string{}})
		}
		return js(map[string]any{"items": items})
	case "section_draft":
		para := fmt.Sprintf("关于「%s」，我想先把话说清楚：%s。\n\n这不是空谈。回头看自己走过的路，真正起作用的往往是那些不起眼的小习惯。把它们一条条写下来，你会发现事情没有想象中复杂。",
			short(heading, 20), short(key, 60))
		if strings.Contains(heading, "为什么") {
			para += "\n\n有调查显示，【待核实：相关比例数据及来源】的人都遇到过类似的问题。"
		}
		return para
	case "section_edit":
		sel := field(prompt, "选中内容：")
		switch field(prompt, "模式：") {
		case "expand":
			return sel + "换句话说，这件事的关键不在于做得多，而在于每一步都想清楚为什么要做。"
		case "shorten":
			r := []rune(sel)
			return string(r[:max(1, len(r)/2)]) + "。"
		default:
			return "换个说法：" + sel
		}
	case "title":
		var ts []map[string]string
		for i, t := range []string{"%s", "我花了三年才想明白：%s", "关于%s，说点实在的", "%s，其实没那么难", "写给新手：%s", "一个被低估的道理：%s"} {
			ts = append(ts, map[string]string{"text": short(fmt.Sprintf(t, short(viewpoint, 14)), 30), "style": []string{"直述", "经历", "口语", "反常识", "对象", "观点"}[i]})
		}
		return js(map[string]any{"titles": ts})
	case "summary":
		return js(map[string]string{"summary": short("这篇文章想说的是："+viewpoint+"。从亲身经历出发，讲清楚为什么、怎么做和需要注意的地方。", 110)})
	case "fact_flag":
		var items []map[string]string
		for _, b := range blocks(prompt) {
			for _, sent := range regexp.MustCompile(`[^。！？\n]+[。！？]?`).FindAllString(b.Body, -1) {
				sent = strings.TrimSpace(sent)
				switch {
				case regexp.MustCompile(`\d`).MatchString(sent) || strings.Contains(sent, "%"):
					items = append(items, map[string]string{"section_id": b.ID, "quote": sent, "claim_type": "data", "reason": "包含具体数字，需要确认来源"})
				case strings.Contains(sent, "调查") || strings.Contains(sent, "研究"):
					items = append(items, map[string]string{"section_id": b.ID, "quote": sent, "claim_type": "quote", "reason": "引用了调查或研究，需要给出出处"})
				case strings.Contains(sent, "最") || strings.Contains(sent, "第一") || strings.Contains(sent, "绝对"):
					items = append(items, map[string]string{"section_id": b.ID, "quote": sent, "claim_type": "absolute", "reason": "绝对化表达，确认是否有依据"})
				}
			}
		}
		if items == nil {
			items = []map[string]string{}
		}
		return js(map[string]any{"items": items})
	case "rewrite_plan":
		var secs []map[string]any
		bs := blocks(prompt)
		target := field(prompt, "目标平台：")
		for i := 0; i < len(bs); i++ {
			ids := []string{bs[i].ID}
			if target == "小红书" && i+1 < len(bs) {
				ids = append(ids, bs[i+1].ID)
				i++
			}
			secs = append(secs, map[string]any{"source_section_ids": ids, "key_point": "压缩表达：" + short(bs[i].Head, 20)})
		}
		title := short(field(prompt, "源标题："), 18)
		return js(map[string]any{"title": title + "｜我的真实经验", "sections": secs, "topics": []string{"经验分享", "成长", "干货", "自我提升"}})
	case "section_rewrite":
		src := blocks(prompt)
		var b strings.Builder
		for _, s := range src {
			b.WriteString(short(s.Body, 60))
			b.WriteString("\n")
		}
		if field(prompt, "目标平台：") == "小红书" {
			return "✨ " + short(key, 30) + "\n" + strings.TrimSpace(b.String()) + "\n这一点真的很重要，建议收藏。"
		}
		return "## " + short(key, 20) + "\n\n" + strings.TrimSpace(b.String()) + "\n\n这里展开说说背后的原因和具体做法。"
	case "review_analysis":
		return js(map[string]any{
			"conclusions": []string{"带有亲身经历的文章阅读完成度更高", "标题中给出明确对象（如「写给新手」）的作品分享更多", "发布时间集中在晚上 8 点后的作品互动更好"},
			"topic_suggestions": []map[string]string{
				{"title": "写给新手的第一份避坑清单", "angle": "延续表现最好的清单体", "reason": "清单体分享率高"},
				{"title": "我做错过的三个决定", "angle": "真实经历复盘", "reason": "经历类完成度高"},
				{"title": "被问最多的五个问题", "angle": "问答体", "reason": "评论区高频问题"},
			},
		})
	case "style_summary":
		return "语气：亲切、克制，常用第一人称讲经历。\n句式：短句为主，段落短，常用设问引出观点。\n结构：先结论后展开，结尾给出可执行建议。"
	case "comic_storyboard":
		n := 6
		if v := field(prompt, "格数："); v != "" {
			fmt.Sscanf(v, "%d", &n)
		}
		if n < 2 {
			n = 2
		}
		ids := regexp.MustCompile(`id=([0-9a-f-]{36})`).FindAllStringSubmatch(prompt, -1)
		var charID string
		if len(ids) > 0 {
			charID = ids[0][1]
		}
		var panels []map[string]any
		for i := 0; i < n; i++ {
			cids := []string{}
			if charID != "" {
				cids = []string{charID}
			}
			panels = append(panels, map[string]any{
				"scene":          fmt.Sprintf("场景 %d：围绕「%s」的一幕", i+1, short(viewpoint, 16)),
				"character_ids":  cids,
				"action":         fmt.Sprintf("角色做出第 %d 步反应", i+1),
				"shot":           []string{"远景", "中景", "近景", "特写", "过肩", "俯视"}[i%6],
				"narration":      fmt.Sprintf("旁白：关于「%s」的第 %d 层说明。", short(viewpoint, 12), i+1),
				"dialogue":       short(fmt.Sprintf("对白 %d", i+1), 20),
			})
		}
		return js(map[string]any{"panels": panels})
	case "comic_panel_text":
		return js(map[string]string{
			"narration":    "旁白：" + short(viewpoint, 40),
			"dialogue":     short("这件事得想清楚。", 30),
			"image_prompt": "暖色漫画风，角色表情生动，画面干净，留出气泡位置。",
		})
	case "comic_rewrite":
		ids := regexp.MustCompile(`【源分格 id=([0-9a-f-]{36})】`).FindAllStringSubmatch(prompt, -1)
		var panels []map[string]string
		for i, m := range ids {
			panels = append(panels, map[string]string{
				"source_panel_id": m[1],
				"narration":       fmt.Sprintf("改写旁白 %d：%s", i+1, short(viewpoint, 24)),
				"dialogue":        short(fmt.Sprintf("改写对白 %d", i+1), 20),
			})
		}
		if len(panels) == 0 {
			panels = []map[string]string{{"source_panel_id": "00000000-0000-0000-0000-000000000001", "narration": "旁白", "dialogue": "对白"}}
		}
		return js(map[string]any{"title": short(field(prompt, "源标题："), 18) + "｜跨平台", "panels": panels})
	case "image_suggest":
		if strings.Contains(prompt, "图片页") || strings.Contains(prompt, "封面页") {
			return js(map[string]any{"pages": []map[string]string{
				{"title": short(viewpoint, 12), "body": "封面：一句话抓住读者"},
				{"title": "要点一", "body": "把核心观点拆成可执行的一小步"},
				{"title": "要点二", "body": "用亲身经历说明为什么有效"},
				{"title": "收尾", "body": "留下一句可收藏的结论"},
			}})
		}
		return js(map[string]any{"suggestions": []map[string]string{
			{"description": "人物特写，略带思考表情", "prompt": "中景，自然光，真实感插画，人物侧脸思考，背景简洁"},
			{"description": "场景示意图", "prompt": "扁平插画，桌面与笔记本，暖色调，留白充足"},
		}})
	case "organize_notes":
		return "## 先说结论\n\n" + short(viewpoint, 80) + "\n\n## 具体怎么做\n\n把要点按顺序整理成可执行的步骤，不添加新的事实。"
	default:
		return "好的。"
	}
}
