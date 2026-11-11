package app

import (
	"errors"
	"time"

	"github.com/google/uuid"

	"ops/internal/skills"
)

// D-176 Phase 1：技能领域核在 ops/internal/skills；本文件保持 app 内旧符号可用。

type SkillFields = skills.SkillFields

type skillDef = skills.Def

const (
	skillInstructionLimit = skills.InstructionLimit
	skillSlotBudget       = skills.SlotBudget
	skillEffectiveLimit   = skills.EffectiveLimit
	skillCatalogRenderMax = skills.CatalogRenderMax
	skillHintLimit        = skills.HintLimit
	skillWorkspaceLimit   = skills.WorkspaceLimit
	skillAccountLimit     = skills.AccountLimit
	skillPersonalLimit    = skills.PersonalLimit
	skillBindingLimit     = skills.BindingLimit
	skillNameMax          = skills.NameMax
	skillSummaryMax       = skills.SummaryMax
	skillTriggerMax       = skills.TriggerMax
	skillImportMaxBytes   = skills.ImportMaxBytes
	skillJSONMaxBytes     = skills.JSONMaxBytes
)

const (
	skillReasonRetired   = skills.ReasonRetired
	skillReasonDisabled  = skills.ReasonDisabled
	skillReasonTaskOff   = skills.ReasonTaskOff
	skillReasonAgentOff  = skills.ReasonAgentOff
	skillReasonPlatform  = skills.ReasonPlatform
	skillReasonFormat    = skills.ReasonFormat
	skillReasonTask      = skills.ReasonTask
	skillReasonLimit     = skills.ReasonLimit
	skillReasonBudget    = skills.ReasonBudget
	skillReasonNotLoaded = skills.ReasonNotLoaded
)

func skillTaskAllowed(taskType string) bool { return skills.TaskAllowed(taskType) }
func skillTaskApplicable(f SkillFields, taskType string) bool {
	return skills.TaskApplicable(f, taskType)
}
func normalizeEnumArray(a []string) []string { return skills.NormalizeEnumArray(a) }
func skillMatchesTarget(f SkillFields, platform, format string) bool {
	return skills.MatchesTarget(f, platform, format)
}
func skillLayer(d *skillDef, accountID uuid.UUID) int { return skills.Layer(d, accountID) }
func skillContentHash(f SkillFields) string           { return skills.ContentHash(f) }
func skillPartitionFingerprint(accountID uuid.UUID, audience *uuid.UUID, items []skillBindingFinger) (string, error) {
	return skills.PartitionFingerprint(accountID, audience, items)
}
func skillImpactToken(skillID uuid.UUID, revision int64, action string, items []skillImpactBinding) (string, error) {
	return skills.ImpactToken(skillID, revision, action, items)
}
func skillPublishDigest(operation string, skillID *uuid.UUID, scope string, accountID *uuid.UUID, f SkillFields) (string, error) {
	return skills.PublishDigest(operation, skillID, scope, accountID, f)
}
func skillBuiltinByKey(key string) *skillDef { return skills.BuiltinByKey(key) }
func skillBuiltinByID(id uuid.UUID) *skillDef { return skills.BuiltinByID(id) }
func skillBuiltinUUID(key string) uuid.UUID   { return skills.BuiltinUUID(key) }
func checkBuiltinRegistry() error             { return skills.CheckBuiltinRegistry() }
func canonJSON(v any) (string, error)         { return skills.CanonJSON(v) }
func canonHash(v any) (string, error)         { return skills.CanonHash(v) }
func canonUUID(u *uuid.UUID) any              { return skills.CanonUUID(u) }
func canonRFC3339(t time.Time) string         { return skills.CanonRFC3339(t) }

type builtinSkill = skills.Builtin
type skillBindingFinger = skills.BindingFinger
type skillImpactBinding = skills.ImpactBinding

var builtinSkills = skills.Builtins

func validateSkillFields(f *SkillFields) error {
	if err := skills.ValidateFields(f); err != nil {
		var ve *skills.ValidationError
		if errors.As(err, &ve) {
			if len(ve.Fields) > 0 {
				return validationFields(ve.Message, ve.Fields)
			}
			return validation(ve.Message)
		}
		return validation(err.Error())
	}
	return nil
}

func validateSkillCombos(platforms, formats []string) error {
	if err := skills.ValidateCombos(platforms, formats); err != nil {
		var ve *skills.ValidationError
		if errors.As(err, &ve) {
			if len(ve.Fields) > 0 {
				return validationFields(ve.Message, ve.Fields)
			}
			return validation(ve.Message)
		}
		return validation(err.Error())
	}
	return nil
}
