package skills

import "github.com/google/uuid"

// Def 是统一解析器看到的定义（DB 行或内置注册表）。
type Def struct {
	ID          uuid.UUID
	Builtin     bool
	BuiltinKey  string
	Scope       string // builtin | workspace | account | personal
	WorkspaceID *uuid.UUID
	UserID      *uuid.UUID
	AccountID   *uuid.UUID
	Fields      SkillFields
	Revision    int64
	Origin      string
	SourceKey   string
	ContentHash string
}

// 兼容未导出旧名（同包 builtin/resolve 使用）。
type skillDef = Def

func (d *Def) contentHash() string {
	if d.ContentHash == "" {
		d.ContentHash = skillContentHash(d.Fields)
	}
	return d.ContentHash
}

// EnsureContentHash 供 app 调用（跨包无法使用未导出 contentHash）。
func (d *Def) EnsureContentHash() string { return d.contentHash() }

func Layer(d *Def, accountID uuid.UUID) int {
	switch {
	case d.Scope == "personal":
		return 0
	case d.AccountID != nil && *d.AccountID == accountID:
		return 1
	case d.WorkspaceID != nil:
		return 2
	default:
		return 3
	}
}

func skillLayer(d *skillDef, accountID uuid.UUID) int { return Layer(d, accountID) }

const (
	ReasonRetired   = "builtin_retired"
	ReasonDisabled  = "disabled"
	ReasonTaskOff   = "task_disabled"
	ReasonAgentOff  = "agent_disabled"
	ReasonPlatform  = "platform_mismatch"
	ReasonFormat    = "format_mismatch"
	ReasonTask      = "task_mismatch"
	ReasonLimit     = "candidate_limit"
	ReasonBudget    = "budget_exceeded"
	ReasonNotLoaded = "not_loaded"
)

const (
	skillReasonRetired   = ReasonRetired
	skillReasonDisabled  = ReasonDisabled
	skillReasonTaskOff   = ReasonTaskOff
	skillReasonAgentOff  = ReasonAgentOff
	skillReasonPlatform  = ReasonPlatform
	skillReasonFormat    = ReasonFormat
	skillReasonTask      = ReasonTask
	skillReasonLimit     = ReasonLimit
	skillReasonBudget    = ReasonBudget
	skillReasonNotLoaded = ReasonNotLoaded
)
