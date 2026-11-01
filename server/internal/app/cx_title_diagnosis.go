package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type cxTitleAIDimension struct {
	Key      string `json:"key"`
	Score    int    `json:"score"`
	Evidence string `json:"evidence"`
}

type cxTitleFindingSpan struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Unit  string `json:"unit"`
}

type cxTitleAIFinding struct {
	Dimension  string              `json:"dimension"`
	Severity   string              `json:"severity"`
	Evidence   string              `json:"evidence"`
	Span       *cxTitleFindingSpan `json:"span"`
	SectionID  string              `json:"section_id,omitempty"`
	Message    string              `json:"message"`
	Suggestion string              `json:"suggestion"`
}

type cxTitleAIOutput struct {
	Dimensions []cxTitleAIDimension `json:"dimensions"`
	Findings   []cxTitleAIFinding   `json:"findings"`
	Candidates []string             `json:"candidates"`
}

type cxTitleDiagnosisSection struct {
	ID   string
	Text string
}

func (o *cxTitleAIOutput) UnmarshalJSON(raw []byte) error {
	type plain cxTitleAIOutput
	if err := cxRequireJSONFields(raw, "dimensions", "findings", "candidates"); err != nil {
		return err
	}
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("标题诊断输出包含多个 JSON 值")
		}
		return err
	}
	*o = cxTitleAIOutput(value)
	return nil
}

func (d *cxTitleAIDimension) UnmarshalJSON(raw []byte) error {
	type plain cxTitleAIDimension
	if err := cxRequireJSONFields(raw, "key", "score", "evidence"); err != nil {
		return err
	}
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	*d = cxTitleAIDimension(value)
	return nil
}

func (f *cxTitleAIFinding) UnmarshalJSON(raw []byte) error {
	type plain cxTitleAIFinding
	if err := cxRequireJSONFields(raw, "dimension", "severity", "evidence", "span", "message", "suggestion"); err != nil {
		return err
	}
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	*f = cxTitleAIFinding(value)
	return nil
}

func (s *cxTitleFindingSpan) UnmarshalJSON(raw []byte) error {
	type plain cxTitleFindingSpan
	if err := cxRequireJSONFields(raw, "start", "end", "unit"); err != nil {
		return err
	}
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	*s = cxTitleFindingSpan(value)
	return nil
}

func cxRequireJSONFields(raw []byte, required ...string) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return errors.New("标题诊断输出对象格式无效")
	}
	for _, field := range required {
		if _, ok := fields[field]; !ok {
			return fmt.Errorf("标题诊断输出缺少字段 %s", field)
		}
	}
	return nil
}

func (o cxTitleAIOutput) validate(title string, sections []cxTitleDiagnosisSection) error {
	limits := map[string]int{"promise": 15, "audience": 10, "uniqueness": 10, "risk": 5}
	if len(o.Dimensions) != len(limits) {
		return errors.New("dimensions 必须恰好包含 promise、audience、uniqueness、risk")
	}
	seen := make(map[string]bool, len(limits))
	for _, dimension := range o.Dimensions {
		limit, ok := limits[dimension.Key]
		if !ok || seen[dimension.Key] || dimension.Score < 0 || dimension.Score > limit || strings.TrimSpace(dimension.Evidence) == "" {
			return fmt.Errorf("dimensions.%s 的键、分数或依据无效", dimension.Key)
		}
		seen[dimension.Key] = true
	}
	if o.Findings == nil || len(o.Findings) > 20 {
		return errors.New("findings 最多 20 项")
	}
	for i, finding := range o.Findings {
		if _, ok := limits[finding.Dimension]; !ok || strings.TrimSpace(finding.Severity) == "" || strings.TrimSpace(finding.Evidence) == "" || strings.TrimSpace(finding.Message) == "" || strings.TrimSpace(finding.Suggestion) == "" {
			return fmt.Errorf("findings[%d] 的维度、证据或说明无效", i)
		}
		if finding.Span == nil {
			if finding.SectionID != "" {
				return fmt.Errorf("findings[%d] 无 span 时不能指定 section_id", i)
			}
			continue
		}
		if finding.Span.Unit != "unicode_code_point" || finding.Span.Start < 0 || finding.Span.End <= finding.Span.Start {
			return fmt.Errorf("findings[%d].span 格式无效", i)
		}
		source := title
		if finding.SectionID != "" {
			found := false
			for _, section := range sections {
				if section.ID == finding.SectionID {
					source, found = section.Text, true
					break
				}
			}
			if !found {
				return fmt.Errorf("findings[%d].section_id 不属于当前作品", i)
			}
		}
		runes := []rune(source)
		if finding.Span.End > len(runes) || string(runes[finding.Span.Start:finding.Span.End]) != finding.Evidence {
			return fmt.Errorf("findings[%d].span 无法切出 evidence", i)
		}
	}
	if o.Candidates == nil || len(o.Candidates) > 3 {
		return errors.New("candidates 最多 3 项")
	}
	for i, candidate := range o.Candidates {
		if candidate == "" || len([]rune(candidate)) > 100 {
			return fmt.Errorf("candidates[%d] 必须为 1..100 个 Unicode 码点", i)
		}
	}
	return nil
}

type cxTitleRuleDimension struct {
	Score *int   `json:"score"`
	Max   int    `json:"max"`
	State string `json:"state"`
}

type cxTitleRuleResult struct {
	RuleScore  int                             `json:"rule_score"`
	RuleMax    int                             `json:"rule_max"`
	Coverage   string                          `json:"coverage"`
	Dimensions map[string]cxTitleRuleDimension `json:"dimensions"`
}

var (
	cxTitleNumericPattern     = regexp.MustCompile(`[0-9０-９一二三四五六七八九十百千万亿]+`)
	cxTitleTimedNumberPattern = regexp.MustCompile(`[0-9０-９一二三四五六七八九十百千万亿]+(?:年|月|日|天|小时|分钟|秒)`)
)

func scoreCXTitle(platform, title string, positioningTags []string) cxTitleRuleResult {
	result := cxTitleRuleResult{Coverage: "complete", Dimensions: make(map[string]cxTitleRuleDimension, 6)}
	set := func(key string, score, max int) {
		value := score
		result.Dimensions[key] = cxTitleRuleDimension{Score: &value, Max: max, State: "available"}
		result.RuleScore += score
		result.RuleMax += max
	}
	unavailable := func(key string, max int) {
		result.Dimensions[key] = cxTitleRuleDimension{Max: max, State: "unavailable"}
		result.Coverage = "partial"
	}

	runes := []rune(title)
	lengthScore := 0
	switch platform {
	case "wechat_mp":
		if len(runes) > 0 && len(runes) <= 32 {
			lengthScore = 10
		}
		set("length", lengthScore, 10)
	case "xhs":
		switch n := len(runes); {
		case n <= 20:
			lengthScore = 10
		case n <= 30:
			lengthScore = 6
		default:
			lengthScore = 3
		}
		set("length", lengthScore, 10)
	default:
		unavailable("length", 10)
	}

	cleanTags := make([]string, 0, len(positioningTags))
	for _, tag := range positioningTags {
		if tag = strings.TrimSpace(tag); tag != "" {
			cleanTags = append(cleanTags, tag)
		}
	}
	if len(cleanTags) == 0 {
		unavailable("keywords", 10)
	} else {
		first := -1
		for _, tag := range cleanTags {
			byteOffset := strings.Index(title, tag)
			if byteOffset < 0 {
				continue
			}
			runeOffset := utf8.RuneCountInString(title[:byteOffset])
			if first < 0 || runeOffset < first {
				first = runeOffset
			}
		}
		keywordScore := 2
		if first >= 0 {
			switch {
			case first <= 7:
				keywordScore = 10
			case first <= 13:
				keywordScore = 6
			}
		}
		set("keywords", keywordScore, 10)
	}

	classes := 0
	if cxTitleNumericPattern.MatchString(title) {
		classes++
	}
	timeWords := []string{"今天", "昨天", "明天", "本周", "本月", "今年", "去年", "明年"}
	hasTime := cxTitleTimedNumberPattern.MatchString(title)
	for _, word := range timeWords {
		hasTime = hasTime || strings.Contains(title, word)
	}
	if hasTime {
		classes++
	}
	hasObject := false
	for _, tag := range cleanTags {
		hasObject = hasObject || strings.Contains(title, tag)
	}
	if hasObject {
		classes++
	}
	specificityScore := 2
	if classes >= 2 {
		specificityScore = 10
	} else if classes == 1 {
		specificityScore = 5
	}
	set("specificity", specificityScore, 10)

	curiosityWords := []string{"为什么", "为何", "如何", "怎么", "竟然", "原来", "却", "但"}
	curious := false
	for _, word := range curiosityWords {
		curious = curious || strings.Contains(title, word)
	}
	curiosityScore := 4
	if curious {
		curiosityScore = 10
	}
	set("curiosity", curiosityScore, 10)

	cleanlinessScore := 10
	for _, word := range adWords {
		if strings.Contains(title, word) {
			cleanlinessScore = 0
			break
		}
	}
	exclamationCount, emojiCount := 0, 0
	for _, char := range runes {
		if char == '!' || char == '！' {
			exclamationCount++
		}
		if (char >= 0x1F300 && char <= 0x1FAFF || char >= 0x2600 && char <= 0x27BF) && !(char >= 0x1F3FB && char <= 0x1F3FF) {
			emojiCount++
		}
	}
	cleanlinessScore -= max(0, exclamationCount-2) * 2
	cleanlinessScore -= max(0, emojiCount-3)
	cleanlinessScore = max(0, cleanlinessScore)
	set("cleanliness", cleanlinessScore, 10)

	structureScore := 10
	if len(runes) < 8 || len(runes) > 24 {
		structureScore -= 4
	}
	if hasRepeatedFourRuneSequence(runes) {
		structureScore -= 4
	}
	if isAllUppercaseLatin(runes) {
		structureScore -= 4
	}
	if isAllSymbols(runes) {
		structureScore -= 4
	}
	set("structure", max(0, structureScore), 10)
	return result
}

func hasRepeatedFourRuneSequence(runes []rune) bool {
	for i := 0; i+8 <= len(runes); i++ {
		repeated := true
		for j := 0; j < 4; j++ {
			if runes[i+j] != runes[i+4+j] {
				repeated = false
				break
			}
		}
		if repeated {
			return true
		}
	}
	return false
}

func isAllUppercaseLatin(runes []rune) bool {
	latinCount := 0
	for _, char := range runes {
		if char >= 'a' && char <= 'z' {
			return false
		}
		if char >= 'A' && char <= 'Z' {
			latinCount++
		}
	}
	return latinCount >= 2
}

func isAllSymbols(runes []rune) bool {
	hasContent := false
	for _, char := range runes {
		if unicode.IsSpace(char) {
			continue
		}
		hasContent = true
		if unicode.IsLetter(char) || unicode.IsNumber(char) {
			return false
		}
	}
	return hasContent
}
