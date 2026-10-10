package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// 大纲模板与大纲评审（EX-E-07）。自定义模板存于 prompt_template 的任务类型 outline_template（内容为 JSON 列表）。

type OutlineTemplate struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Structure string `json:"structure"`
	Builtin   bool   `json:"builtin"`
}

var builtinOutlineTemplates = []OutlineTemplate{
	{ID: "argument", Name: "观点论证", Structure: "提出观点 → 论据一 → 论据二 → 回应可能的反对意见 → 回到观点并给出行动建议", Builtin: true},
	{ID: "problem", Name: "问题-原因-方案", Structure: "描述问题现象 → 分析原因（2–3 个）→ 给出方案 → 总结", Builtin: true},
	{ID: "story", Name: "故事-转折-启示", Structure: "一个具体场景或经历 → 转折或冲突 → 背后的道理 → 给读者的启示", Builtin: true},
	{ID: "list", Name: "清单体", Structure: "开头说明为什么需要这份清单 → 第 1 条 → 第 2 条 → …（每条一段，3–7 条）→ 结尾总结", Builtin: true},
	{ID: "compare", Name: "对比体", Structure: "引出两种做法或观点 → A 的特点 → B 的特点 → 关键差异 → 结论与选择建议", Builtin: true},
	{ID: "tutorial", Name: "教程步骤", Structure: "要解决什么问题、需要准备什么 → 步骤一 → 步骤二 → 步骤三 → 常见问题 → 小结", Builtin: true},
}

func (s *Server) customOutlineTemplates(ctx context.Context) []OutlineTemplate {
	var content string
	_ = s.db.QueryRow(ctx, `SELECT content FROM prompt_template WHERE workspace_id=$1 AND task_type='outline_template' ORDER BY version DESC LIMIT 1`,
		ident(ctx).WorkspaceID).Scan(&content)
	var list []OutlineTemplate
	_ = json.Unmarshal([]byte(content), &list)
	out := []OutlineTemplate{}
	for _, t := range list {
		if strings.TrimSpace(t.Name) != "" && strings.TrimSpace(t.Structure) != "" {
			t.Builtin = false
			out = append(out, t)
		}
	}
	return out
}

func (s *Server) findOutlineTemplate(ctx context.Context, id string) (*OutlineTemplate, error) {
	for _, t := range append(append([]OutlineTemplate{}, builtinOutlineTemplates...), s.customOutlineTemplates(ctx)...) {
		if t.ID == id {
			return &t, nil
		}
	}
	return nil, validation("大纲模板不存在")
}

func (s *Server) listOutlineTemplates(w http.ResponseWriter, r *http.Request) error {
	return ok(w, append(append([]OutlineTemplate{}, builtinOutlineTemplates...), s.customOutlineTemplates(r.Context())...))
}

// putOutlineTemplates replaces the workspace's custom templates (new prompt_template version).
func (s *Server) putOutlineTemplates(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Items []OutlineTemplate `json:"items"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in.Items) > 30 {
		return validation("自定义模板最多 30 个")
	}
	list := []OutlineTemplate{}
	for _, t := range in.Items {
		t.Name, t.Structure = strings.TrimSpace(t.Name), strings.TrimSpace(t.Structure)
		if t.Name == "" || t.Structure == "" {
			return validation("模板名称和结构都不能为空")
		}
		if runeLen(t.Name) > 20 || runeLen(t.Structure) > 500 {
			return validation("模板名称不超过 20 字，结构不超过 500 字")
		}
		if t.ID == "" || strings.HasPrefix(t.ID, "builtin") {
			t.ID = "c-" + uuid.NewString()[:8]
		}
		t.Builtin = false
		list = append(list, t)
	}
	b, _ := json.Marshal(list)
	ctx := r.Context()
	ws := ident(ctx).WorkspaceID
	var ver int
	_ = s.db.QueryRow(ctx, `SELECT coalesce(max(version),0)+1 FROM prompt_template WHERE workspace_id=$1 AND task_type='outline_template'`, ws).Scan(&ver)
	if _, err := s.db.Exec(ctx, `INSERT INTO prompt_template (workspace_id, task_type, version, content, active, label, updated_at)
		VALUES ($1,'outline_template',$2,$3,true,'大纲模板',now())`, ws, max(ver, 1), string(b)); err != nil {
		return err
	}
	s.audit(ctx, "outline_template_update", "prompt_template", "outline_template", "ok", map[string]any{"count": len(list)})
	return s.listOutlineTemplates(w, r)
}

// reviewOutline lists structural problems; it never changes the outline (EX-E-07).
func (s *Server) reviewOutline(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Items []OutlineItem `json:"items"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	items := in.Items
	if len(items) == 0 {
		if items, err = s.workOutline(ctx, m.ID); err != nil {
			return err
		}
	}
	if len(items) == 0 {
		return validation("还没有大纲，先生成或填写大纲")
	}
	user := fmt.Sprintf(`## 作品
核心观点：%s

## 待评审的大纲
%s
## 任务说明
只指出这份大纲的结构性问题（论点重复、缺少反方、逻辑跳跃、结尾没有回到核心观点、顺序不合理等），每条给出建议。不要输出新的大纲。items 填问题涉及的大纲序号（从 1 开始）。

## 输出格式
只输出 JSON：{"issues":[{"items":[1,3],"problem":"问题","suggestion":"建议"}],"overall":"总体评价"}`, m.Viewpoint, outlineText(items))
	var out struct {
		Issues []struct {
			Items      []int  `json:"items"`
			Problem    string `json:"problem"`
			Suggestion string `json:"suggestion"`
		} `json:"issues"`
		Overall string `json:"overall"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "outline_review", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true}, &out, func() error {
		if strings.TrimSpace(out.Overall) == "" && len(out.Issues) == 0 {
			return fmt.Errorf("评审为空")
		}
		return nil
	})
	if err != nil {
		return err
	}
	for i := range out.Issues {
		keep := []int{}
		for _, n := range out.Issues[i].Items {
			if n >= 1 && n <= len(items) {
				keep = append(keep, n)
			}
		}
		out.Issues[i].Items = keep
	}
	return ok(w, map[string]any{"issues": out.Issues, "overall": out.Overall, "ai_call_id": res.CallID, "refs": res.Refs})
}
