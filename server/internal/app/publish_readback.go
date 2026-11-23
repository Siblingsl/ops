package app

// REF41 P3：发布回读核对。执行器填完后必须回读，回读证据写入
// publish_task.evidence.readback；只有回读一致才允许进入 filled/提交。
// 本文件只做纯函数与结构校验，不写数据库、不调用平台。

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// PublishReadbackFieldNames 是回读必须覆盖的五类字段。
var PublishReadbackFieldNames = []string{"title", "body", "tags", "cover", "schedule"}

// PublishBodyPromoSuffixes 是正文尾部允许出现的平台固定推广语。
// 只容忍清单内的固定后缀；截断、追加其他文案、丢段落都判不一致。
var PublishBodyPromoSuffixes = []string{
	"本文为推广内容",
	"下载APP查看更多",
}

type PublishReadback struct {
	CheckedAt         string                    `json:"checked_at"`
	AdapterVersion    string                    `json:"adapter_version"`
	OK                bool                      `json:"ok"`
	Fields            map[string]map[string]any `json:"fields"`
	ScreenshotAssetID string                    `json:"screenshot_asset_id"`
	TabRef            string                    `json:"tab_ref,omitempty"`
}

// ParsePublishReadback 把 evidence.readback 解析成结构并校验五类字段与截图。
// 传入 nil 或空对象返回错误，避免把“没有回读”当成通过。
func ParsePublishReadback(raw any) (*PublishReadback, error) {
	if raw == nil {
		return nil, errors.New("readback 缺失")
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("readback 无法序列化: %w", err)
	}
	var out PublishReadback
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("readback 结构不合法: %w", err)
	}
	if err := out.Validate(); err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *PublishReadback) Validate() error {
	if r == nil {
		return errors.New("readback 为空")
	}
	if strings.TrimSpace(r.ScreenshotAssetID) == "" {
		return errors.New("readback.screenshot_asset_id 缺失")
	}
	for _, name := range PublishReadbackFieldNames {
		field, ok := r.Fields[name]
		if !ok {
			return fmt.Errorf("readback.fields.%s 缺失", name)
		}
		if _, ok := field["ok"].(bool); !ok {
			return fmt.Errorf("readback.fields.%s.ok 必须是布尔值", name)
		}
	}
	return nil
}

// BuildPublishReadback 汇总五类字段的 ok，任何一类不一致则整体 ok=false。
func BuildPublishReadback(fields map[string]map[string]any, screenshotAssetID, adapterVersion string) *PublishReadback {
	ok := true
	for _, name := range PublishReadbackFieldNames {
		field, exists := fields[name]
		if !exists {
			ok = false
			continue
		}
		if passed, _ := field["ok"].(bool); !passed {
			ok = false
		}
	}
	return &PublishReadback{
		CheckedAt:         time.Now().UTC().Format(time.RFC3339),
		AdapterVersion:    adapterVersion,
		OK:                ok,
		Fields:            fields,
		ScreenshotAssetID: screenshotAssetID,
	}
}

// NormalizePublishText 做全角转半角、去零宽字符、连续空白折叠、首尾 trim。
func NormalizePublishText(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == 0x3000:
			b.WriteRune(' ')
		case r >= 0xFF01 && r <= 0xFF5E:
			b.WriteRune(r - 0xFEE0)
		case r == 0x200B || r == 0x200C || r == 0x200D || r == 0xFEFF || r == 0x2060:
			continue
		default:
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// NormalizePublishBody 在文本归一化后再去掉所有空白；平台自动换行
// 因此被视为一致，而截断/丢段落会改变长度与哈希。
func NormalizePublishBody(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, NormalizePublishText(s))
}

func ComparePublishTitle(expected, actual string) map[string]any {
	e := NormalizePublishText(expected)
	a := NormalizePublishText(actual)
	return map[string]any{
		"expected_hash": sha256Hex([]byte(e)),
		"actual_hash":   sha256Hex([]byte(a)),
		"ok":            e == a,
	}
}

func ComparePublishBody(expected, actual string, promoSuffixes []string) map[string]any {
	e := NormalizePublishBody(expected)
	a := NormalizePublishBody(actual)
	for _, suffix := range promoSuffixes {
		normalized := NormalizePublishBody(suffix)
		if normalized != "" && strings.HasSuffix(a, normalized) {
			a = strings.TrimSuffix(a, normalized)
			break
		}
	}
	return map[string]any{
		"expected_len":  len([]rune(e)),
		"actual_len":    len([]rune(a)),
		"expected_hash": sha256Hex([]byte(e)),
		"actual_hash":   sha256Hex([]byte(a)),
		"ok":            e == a,
	}
}

func ComparePublishTags(expected, actual []string) map[string]any {
	e := normalizePublishTags(expected)
	a := normalizePublishTags(actual)
	first := ""
	if len(a) > 0 {
		first = a[0]
	}
	ok := len(e) == len(a) && samePublishTagSet(e, a)
	if len(e) > 0 && len(a) > 0 {
		ok = ok && e[0] == a[0]
	}
	return map[string]any{
		"expected_count": len(e),
		"actual_count":   len(a),
		"first":          first,
		"ok":             ok,
	}
}

func ComparePublishCover(expectedPresent, actualPresent bool, expectedRatio, actualRatio float64) map[string]any {
	ok := expectedPresent == actualPresent
	if ok && expectedPresent {
		// 0.75 - 0.73 在 float64 下是 0.020000000000000018；容差含边界，避免恰好 0.02 被判失败。
		ok = math.Abs(expectedRatio-actualRatio) <= 0.02+1e-9
	}
	return map[string]any{
		"expected_present": expectedPresent,
		"present":          actualPresent,
		"expected_ratio":   formatRatio(expectedRatio),
		"actual_ratio":     formatRatio(actualRatio),
		"ok":               ok,
	}
}

func ComparePublishSchedule(expected, actual string) map[string]any {
	e := NormalizePublishText(expected)
	a := NormalizePublishText(actual)
	return map[string]any{
		"expected": e,
		"actual":   a,
		"ok":       e == a,
	}
}

func normalizePublishTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	for _, tag := range tags {
		normalized := NormalizePublishText(tag)
		if normalized == "" {
			continue
		}
		out = append(out, normalized)
	}
	return out
}

func samePublishTagSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := make(map[string]int, len(a))
	for _, item := range a {
		counts[item]++
	}
	for _, item := range b {
		counts[item]--
		if counts[item] < 0 {
			return false
		}
	}
	return true
}

func formatRatio(v float64) string {
	return strconv.FormatFloat(math.Round(v*100)/100, 'f', 2, 64)
}
