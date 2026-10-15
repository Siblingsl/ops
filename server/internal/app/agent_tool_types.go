package app

import (
	"context"
	"encoding/json"
	"time"
)

// 16 文档第 3 节：工具体系的类型定义。条目本身写在 agent_tools_*.go 中，
// 启动时由 agent_catalog.go 构建索引并做静态自检（第 3.7 节）。

// ToolKind 是工具类别（16 文档第 3.2 节）。判定以接口的实际副作用为准，而不是 HTTP 方法。
type ToolKind string

const (
	// toolR 读取：不写业务数据，也不调用 AI。
	toolR ToolKind = "R"
	// toolG 生成：调用 AI 但不写业务数据。
	toolG ToolKind = "G"
	// toolW 写入：写入业务数据，一次点击执行。
	toolW ToolKind = "W"
	// toolH 人工确认点：W 中对应 H-01 至 H-09 或 HC-20 的接口。
	toolH ToolKind = "H"
	// toolX 不可逆：硬删除、删文件、覆盖正文、转让所有权、移出成员、超管处置用户。
	toolX ToolKind = "X"
)

// Role 是工具可见的最低角色（16 文档第 9.1 节）。
type Role string

const (
	roleViewer      Role = "viewer"
	roleEditor      Role = "editor"
	roleOwner       Role = "owner"
	roleSystemAdmin Role = "system_admin"
)

// ToolParam 是工具参数（16 文档第 3.1 节）。
type ToolParam struct {
	Name     string
	In       string // path | query | body | multipart
	Field    string // multipart：构造出的表单字段名（第 8.4 节，模型传的是附件 ID）
	Schema   json.RawMessage
	Required bool
	Source   string // U | G | O | F，第 4 节；空表示 F
	Editable bool   // 卡片上是否允许用户修改
}

// HumanField 是只由执行请求填入的字段（16 文档第 3.5 节），不出现在给模型的工具定义中。
type HumanField struct {
	Name   string
	In     string // query | body
	Schema json.RawMessage
}

// SecondConfirm 描述不可逆操作的二次确认方式（16 文档第 5.7 节）。
// TypeName 为空表示输入用户名。
type SecondConfirm struct {
	TypeName string
}

// TargetRule 从参数得出目标对象，用于卡片唯一性、预览与链接。
type TargetRule struct {
	Type  string // work | section | material | topic | ...
	Param string // 参数名
}

// PreviewRule 说明提出卡片时读取哪些当前值做“修改前 / 修改后”。
// 卡片机制的完整实现属 DEV-AG06；本任务只保留结构与少量可机械推导的取值。
type PreviewRule struct {
	Kind   string // "" 表示不预览；"fields" 表示读取 Fields 列出的顶层字段
	Fields []string
}

// AgentTool 是工具目录条目（16 文档第 3.1 节）。
type AgentTool struct {
	Name          string
	Domain        string
	Kind          ToolKind
	Method, Path  string
	Description   string
	Params        []ToolParam
	Fixed         map[string]any
	Human         []HumanField
	ClientPayload string
	MinRole       Role
	Gate          string
	SecondConfirm *SecondConfirm
	BodyClass     bool
	SSE           bool
	Target        TargetRule
	Preview       PreviewRule
	Fingerprint   bool
	Project       func(status int, body []byte) any
	// ProjectArgs 是需要读取参数才能投影的场合（第 3.6 节第 1 项的 works__read_sections）。
	// 非空时优先于 Project。这是 §3.1 结构的最小扩展，登记在 docs/90 的 D-117。
	ProjectArgs func(args map[string]any, status int, body []byte) any
	// ProposePreview 在提出卡片时读取条目专属状态（第 5.6 节）：返回额外展示的差异与
	// 指纹来源对象，并把提出时的守卫值（如 base_revision）写入 args 随卡片冻结。
	ProposePreview func(ctx context.Context, s *Server, st *agentRunState, t *AgentTool, args map[string]any) ([]agentChange, map[string]any, error)
	// EnrichExecute 在执行前重新读取当前状态，把分发所需的完整参数写入 args（第 5.3 节第 7 项）。
	EnrichExecute func(ctx context.Context, s *Server, st *agentRunState, t *AgentTool, args map[string]any) error
	Secrets       []string
	ExecTimeout   time.Duration
	Notes         string
}

// Mutating 表示该条目会产生业务写入，需要提出卡片（第 5 节）。
func (t *AgentTool) Mutating() bool {
	return t.Kind == toolW || t.Kind == toolH || t.Kind == toolX
}

// ---- 参数构造助手（保持条目紧凑，语义与第 3.4 节一致） ----

func js(s string) json.RawMessage { return json.RawMessage(s) }

const (
	schemaUUID    = `{"type":"string","format":"uuid"}`
	schemaStr     = `{"type":"string"}`
	schemaInt     = `{"type":"integer"}`
	schemaBool    = `{"type":"boolean"}`
	schemaIntMin0 = `{"type":"integer","minimum":0}`
)

func strMax(n int) string { return `{"type":"string","maxLength":` + agentItoa(n) + `}` }

func strMinMax(min, max int) string {
	return `{"type":"string","minLength":` + agentItoa(min) + `,"maxLength":` + agentItoa(max) + `}`
}

func intRange(min, max int) string {
	return `{"type":"integer","minimum":` + agentItoa(min) + `,"maximum":` + agentItoa(max) + `}`
}

func arrOf(item string, min, max int) string {
	s := `{"type":"array","items":` + item
	if min > 0 {
		s += `,"minItems":` + agentItoa(min)
	}
	if max > 0 {
		s += `,"maxItems":` + agentItoa(max)
	}
	return s + `}`
}

func enumOf(values ...string) string {
	s := `{"type":"string","enum":[`
	for i, v := range values {
		if i > 0 {
			s += ","
		}
		s += `"` + v + `"`
	}
	return s + `]}`
}

func agentItoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// editableFor：U/G/O 类文字字段默认允许用户在卡片上修改，F 类不允许（第 3.1 节）。
func editableFor(source string) bool { return source != "" && source != "F" }

// pPath 是 UUID 路径参数。
func pPath(name string) ToolParam {
	return ToolParam{Name: name, In: "path", Schema: js(schemaUUID), Required: true}
}

// pPathStr 是非 UUID 的路径参数（如 /trash/{type}/{id} 的 type、/prompt-templates/{taskType}）。
func pPathStr(name string) ToolParam {
	return ToolParam{Name: name, In: "path", Schema: js(schemaStr), Required: true}
}

// pPathEnum 是枚举路径参数（如 /daily/{id}/items/{idx}/{action} 的 action）。
func pPathEnum(name string, values ...string) ToolParam {
	return ToolParam{Name: name, In: "path", Schema: js(enumOf(values...)), Required: true}
}

// pPathInt 是序号路径参数（第 3.4 节第 2 条）。
func pPathInt(name string) ToolParam {
	return ToolParam{Name: name, In: "path", Schema: js(schemaIntMin0), Required: true}
}

// pQuery 是查询参数。
func pQuery(name, schema string, required bool, source string) ToolParam {
	return ToolParam{Name: name, In: "query", Schema: js(schema), Required: required, Source: source, Editable: editableFor(source)}
}

// pQueryF 是自由查询参数。
func pQueryF(name, schema string, required bool) ToolParam {
	return pQuery(name, schema, required, "F")
}

// pBody 是请求体参数。Source 为空时按 F 处理（第 4.2 节）。
func pBody(name, schema string, required bool, source string) ToolParam {
	return ToolParam{Name: name, In: "body", Schema: js(schema), Required: required, Source: source, Editable: editableFor(source)}
}

// pBodyF 是自由请求体参数。
func pBodyF(name, schema string, required bool) ToolParam { return pBody(name, schema, required, "F") }

// pBodyFixed 是不允许卡片修改的请求体参数（F 类）。
func pBodyFixed(name, schema string, required bool) ToolParam {
	return pBody(name, schema, required, "")
}

// pFile 是单附件参数（第 8.4 节）：name 是模型看到的参数名（attachment_id），
// field 是分发时构造出的 multipart 表单字段名（file）。
func pFile(name, field string, required bool) ToolParam {
	return ToolParam{Name: name, In: "multipart", Field: field, Schema: js(schemaUUID), Required: required}
}

// pFiles 是多附件参数（attachment_ids → files，第 8.4 节）。
func pFiles(name, field string, required bool) ToolParam {
	return ToolParam{Name: name, In: "multipart", Field: field,
		Schema: js(`{"type":"array","items":{"type":"string","format":"uuid"},"minItems":1}`), Required: required}
}

// hQuery / hBody 构造人工字段（第 3.5 节）。
func hQuery(name, schema string) HumanField {
	return HumanField{Name: name, In: "query", Schema: js(schema)}
}
func hBody(name, schema string) HumanField {
	return HumanField{Name: name, In: "body", Schema: js(schema)}
}

// fixed 构造固定注入值（模型不可见，也不能覆盖）。
func fixedArgs(kv ...any) map[string]any {
	m := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i].(string)] = kv[i+1]
	}
	return m
}

// target 构造目标对象规则。
func target(typ, param string) TargetRule { return TargetRule{Type: typ, Param: param} }

// previewFields 构造字段级预览规则。
func previewFields(fields ...string) PreviewRule { return PreviewRule{Kind: "fields", Fields: fields} }

// secondConfirmPlain 表示普通二次确认：只需用户确认，不输入对象名称（16 文档第 5.7 节标「—」的条目）。
func secondConfirmPlain() *SecondConfirm { return &SecondConfirm{} }

// secondConfirmAccountName 表示需要输入账号名称（16 文档第 5.7 节）。
func secondConfirmAccountName() *SecondConfirm { return &SecondConfirm{TypeName: "account_name"} }

// secondConfirmUsername 表示需要输入用户名（16 文档第 5.7 节）。
func secondConfirmUsername() *SecondConfirm { return &SecondConfirm{TypeName: "username"} }

// secondConfirmType 表示需要输入指定类型名称。
func secondConfirmType(name string) *SecondConfirm { return &SecondConfirm{TypeName: name} }
