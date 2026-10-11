package app

import (
	"fmt"
	"net/http"
	"strings"
)

// DEV-A107（13 文档）：整篇通读建议。AI 通读全文与核心观点，按段落输出结构化建议
//（改写/补充），前端逐条"应用"——复用 DEV-A104 的对比确认通道，绝不批量改写。

func (s *Server) readThrough(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if strings.TrimSpace(m.Viewpoint) == "" {
		return humanStep("H-02", "请先写下你自己的核心观点，再让 AI 通读整篇")
	}
	ctx := r.Context()
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return err
	}
	if len(secs) == 0 {
		return validation("还没有段落内容：先确认大纲并起草，才有可通读的内容")
	}
	var b strings.Builder
	for _, x := range secs {
		if strings.TrimSpace(x.ContentMD) == "" {
			continue
		}
		fmt.Fprintf(&b, "【段落 id=%s】小标题：%s\n%s\n\n", x.ID, x.Heading, truncate(x.ContentMD, 800))
	}
	mids, err := s.workMaterialIDs(ctx, m.ID)
	if err != nil {
		return err
	}
	work, err := s.workBrief(ctx, m)
	if err != nil {
		return err
	}
	var angle string
	_ = s.db.QueryRow(ctx, `SELECT coalesce(t.angle,'') FROM work w LEFT JOIN topic t ON t.id=w.topic_id WHERE w.id=$1`, m.ID).Scan(&angle)
	user := fmt.Sprintf(`## 作品
标题：%s
选题切入角度：%s
核心观点：%s

%s
## 任务说明
通读整篇，找出最多 5 处值得改进的地方，按段落输出建议：action 为 rewrite（改写该段）或 append（在该段末尾补充内容）。text 是可直接使用的成稿内容（不是泛泛的方向），reason 用一句话说明为什么。没有值得改的地方就输出空数组，不要硬凑。不输出整篇正文。

## 输出格式
只输出 JSON：{"suggestions":[{"section_id":"段落 id","action":"rewrite|append","text":"成稿内容","reason":"为什么"}]}`, m.Title, angle, m.Viewpoint, b.String())
	var out struct {
		Suggestions []struct {
			SectionID string `json:"section_id"`
			Action    string `json:"action"`
			Text      string `json:"text"`
			Reason    string `json:"reason"`
		} `json:"suggestions"`
	}
	valid := map[string]bool{}
	for _, x := range secs {
		valid[x.ID.String()] = true
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "read_through", Account: m.Account, WorkID: &m.ID, User: user, Materials: mids, Work: work, SkipStyle: true, Refs: map[string]any{"sections": len(secs)}}, &out, func() error {
		if len(out.Suggestions) > 5 {
			return fmt.Errorf("建议最多 5 条")
		}
		for i := range out.Suggestions {
			su := &out.Suggestions[i]
			su.Text = strings.TrimSpace(su.Text)
			if !valid[su.SectionID] {
				return fmt.Errorf("建议指向了不存在的段落")
			}
			if su.Action != "rewrite" && su.Action != "append" {
				return fmt.Errorf("未知的建议动作：%s", su.Action)
			}
			if su.Text == "" || runeLen(su.Text) > 800 {
				return fmt.Errorf("建议内容为空或超过 800 字")
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"suggestions": out.Suggestions, "refs": res.Refs, "ai_call_id": res.CallID})
}
