package app

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// CF-TPL-05（18 §3.6）：内置模板清单每类 ≤2，列表内置在前且 builtin=true。
func TestBuiltinCreationTemplatesPerFormat(t *testing.T) {
	byFormat := map[string][]CreationTemplate{}
	for _, tpl := range builtinCreationTemplates() {
		byFormat[tpl.ContentFormat] = append(byFormat[tpl.ContentFormat], tpl)
	}
	for format, list := range byFormat {
		if len(list) > 2 {
			t.Fatalf("%s 内置模板超过 2 个：%d", format, len(list))
		}
		var got []CreationTemplate
		env.mustJSON(t, "GET", "/api/v1/creation-templates?content_format="+format, nil, &got)
		if len(got) < len(list) {
			t.Fatalf("%s 列表少于内置模板：%d < %d", format, len(got), len(list))
		}
		for i, tpl := range list {
			if !got[i].Builtin || got[i].Name != tpl.Name || got[i].ContentFormat != format {
				t.Fatalf("%s 第 %d 个内置模板不在前或 builtin 标记丢失：%+v", format, i, got[i])
			}
		}
		for _, tpl := range got[len(list):] {
			if tpl.Builtin {
				t.Fatalf("%s 工作区模板不应排在内置之前：%+v", format, tpl)
			}
		}
	}
	if len(builtinCreationTemplates()) != 5 {
		t.Fatalf("内置模板清单应为 5 个（18 §3.6 首版）：%d", len(builtinCreationTemplates()))
	}
}
func TestCreationTemplateCRUDAndWorkspaceIsolation(t *testing.T) {
	_, ws, _ := env.agentSession(t)
	// 同一测试进程内的其他模板用例会复用 workspace，先清掉工作区模板，保证“内置 2 个在前”可判定。
	if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM creation_template WHERE workspace_id=$1`, ws); err != nil {
		t.Fatal(err)
	}

	var list []CreationTemplate
	env.mustJSON(t, "GET", "/api/v1/creation-templates?content_format=long_article", nil, &list)
	if len(list) != 2 {
		t.Fatalf("long_article 内置模板应为 2 个：%d", len(list))
	}
	for _, tpl := range list {
		if !tpl.Builtin {
			t.Fatalf("内置模板必须 builtin=true：%+v", tpl)
		}
		if tpl.ContentFormat != "long_article" {
			t.Fatalf("类型过滤失效：%s", tpl.ContentFormat)
		}
	}

	var created CreationTemplate
	env.mustJSON(t, "POST", "/api/v1/creation-templates", map[string]any{
		"content_format": "long_article",
		"name":           "工作区观点文",
		"structure":      []map[string]any{{"heading": "开头"}, {"heading": "论证"}, {"heading": "收尾"}},
		"prompt_addon":   "多用本地例子。",
		"section_min":    3,
		"section_max":    5,
		"tone":           "平实",
	}, &created)
	if created.Builtin || created.Name != "工作区观点文" || len(created.Structure) != 3 {
		t.Fatalf("创建工作区模板异常：%+v", created)
	}

	env.mustJSON(t, "GET", "/api/v1/creation-templates?content_format=long_article", nil, &list)
	if len(list) != 3 || list[len(list)-1].ID != created.ID {
		t.Fatalf("工作区模板应排在内置之后：%+v", list)
	}

	builtinID := templateStableID(builtinCreationTemplates()[0])
	env.expectErr(t, "PUT", "/api/v1/creation-templates/"+builtinID.String(), map[string]any{
		"content_format": "long_article", "name": "改名", "structure": []map[string]any{{"heading": "x"}},
	}, "validation_failed")
	env.expectErr(t, "DELETE", "/api/v1/creation-templates/"+builtinID.String(), nil, "validation_failed")

	// T-101-2 另存为：内置模板不可改，但可按其内容 POST 出工作区副本。
	builtin := builtinCreationTemplates()[0]
	structure := make([]map[string]any, 0, len(builtin.Structure))
	for _, step := range builtin.Structure {
		structure = append(structure, map[string]any{"heading": step.Heading, "key_point": step.KeyPoint, "role": step.Role})
	}
	var saved CreationTemplate
	env.mustJSON(t, "POST", "/api/v1/creation-templates", map[string]any{
		"content_format": builtin.ContentFormat,
		"name":           builtin.Name + "副本",
		"structure":      structure,
		"prompt_addon":   builtin.PromptAddon,
		"section_min":    builtin.SectionMin,
		"section_max":    builtin.SectionMax,
		"tone":           builtin.Tone,
	}, &saved)
	if saved.Builtin || saved.ID == builtinID || saved.Name != builtin.Name+"副本" {
		t.Fatalf("另存为应生成新的工作区模板：%+v", saved)
	}

	// T-101-3 DELETE 仅工作区模板；跨工作区不可见、不可改、不可删。
	var otherWS uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO workspace(name) VALUES('模板隔离') RETURNING id`).Scan(&otherWS); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal([]TemplateStep{{Heading: "外部结构"}})
	var foreignID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO creation_template
		(workspace_id, content_format, name, structure) VALUES ($1,'long_article','外部模板',$2) RETURNING id`, otherWS, raw).Scan(&foreignID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "GET", "/api/v1/creation-templates?content_format=long_article", nil, &list)
	for _, tpl := range list {
		if tpl.ID == foreignID {
			t.Fatalf("跨工作区模板不应出现在列表：%+v", tpl)
		}
	}
	env.expectErr(t, "PUT", "/api/v1/creation-templates/"+foreignID.String(), map[string]any{
		"content_format": "long_article", "name": "越权改", "structure": []map[string]any{{"heading": "x"}},
	}, "not_found")
	env.expectErr(t, "DELETE", "/api/v1/creation-templates/"+foreignID.String(), nil, "not_found")

	env.mustJSON(t, "DELETE", "/api/v1/creation-templates/"+created.ID.String(), nil, nil)
	env.mustJSON(t, "GET", "/api/v1/creation-templates?content_format=long_article", nil, &list)
	for _, tpl := range list {
		if tpl.ID == created.ID {
			t.Fatalf("删除后仍出现在列表：%+v", tpl)
		}
	}
	// 同一工作区的模板保留，用于确认删除只作用于目标。
	var savedWS uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM creation_template WHERE id=$1 AND deleted_at IS NULL`, saved.ID).Scan(&savedWS); err != nil || savedWS != ws {
		t.Fatalf("另存模板应仍在当前工作区：%s %v", savedWS, err)
	}
}
