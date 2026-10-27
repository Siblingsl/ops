package app

import "testing"

func TestAW07PlanValidationAndEvidenceKinds(t *testing.T) {
	valid := []agentPlanStepDefinition{{ID: "read", Title: "读取资料", Acceptance: "引用已保存的读取结果"}}
	if err := agentValidatePlanSteps(valid); err != nil {
		t.Fatalf("valid plan rejected: %v", err)
	}
	for name, steps := range map[string][]agentPlanStepDefinition{
		"duplicate ids":    {{ID: "same", Title: "A", Acceptance: "证据"}, {ID: "same", Title: "B", Acceptance: "证据"}},
		"empty acceptance": {{ID: "a", Title: "A"}},
		"oversized target": {{ID: "a", Title: "A", TargetRef: string(make([]byte, 501)), Acceptance: "证据"}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := agentValidatePlanSteps(steps); err == nil {
				t.Fatal("invalid plan accepted")
			}
		})
	}
}

func TestAW07StructuredQuestionAndAnswerValidation(t *testing.T) {
	items := []agentQuestionItem{{ID: "goal", Title: "这次优先目标是什么？", Required: true, Options: []agentQuestionOption{
		{ID: "reach", Label: "提升触达"}, {ID: "save", Label: "增加收藏"},
	}}, {ID: "tone", Title: "希望的语气？", Required: false, Options: []agentQuestionOption{
		{ID: "warm", Label: "亲切"}, {ID: "direct", Label: "直接"},
	}}}
	if err := agentValidateQuestionItems(items); err != nil {
		t.Fatalf("valid questions rejected: %v", err)
	}
	answers, text, err := agentValidateQuestionAnswers(items, []agentQuestionAnswer{
		{QuestionID: "goal", ChoiceID: "reach"}, {QuestionID: "tone", Skip: true},
	})
	if err != nil || len(answers) != 2 || text == "" {
		t.Fatalf("valid grouped answer rejected: answers=%+v text=%q err=%v", answers, text, err)
	}
	for name, candidate := range map[string][]agentQuestionAnswer{
		"required skipped":   {{QuestionID: "goal", Skip: true}, {QuestionID: "tone", Skip: true}},
		"unknown choice":     {{QuestionID: "goal", ChoiceID: "unknown"}, {QuestionID: "tone", Skip: true}},
		"choice and text":    {{QuestionID: "goal", ChoiceID: "reach", Text: "also text"}, {QuestionID: "tone", Skip: true}},
		"duplicate question": {{QuestionID: "goal", ChoiceID: "reach"}, {QuestionID: "goal", ChoiceID: "save"}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := agentValidateQuestionAnswers(items, candidate); err == nil {
				t.Fatal("invalid grouped answer accepted")
			}
		})
	}
	invalidItems := []agentQuestionItem{{ID: "duplicate", Title: "问题", Required: true, Options: []agentQuestionOption{{ID: "a", Label: "A"}, {ID: "a", Label: "重复"}}}}
	if err := agentValidateQuestionItems(invalidItems); err == nil {
		t.Fatal("duplicate option id accepted")
	}
}
