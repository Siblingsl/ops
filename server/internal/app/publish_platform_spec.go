package app

// Publish platform rules live here so a new platform cannot be added only in a
// route or a CHECK constraint. Sources: docs/24 (XHS), docs/19 (Toutiao),
// docs/06 §5.3 (WeChat MP); docs/41 §3.2 is the implementation contract.
import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

type publishRatio struct {
	W int
	H int
}

type publishPlatformSpec struct {
	Platform      string
	TitleMin      int
	TitleMax      int
	BodyMax       int
	TagMin        int
	TagMax        int
	CoverRequired bool
	CoverRatios   []publishRatio
	SummaryMax    int
	AllowURLs     bool
	AllowContact  bool
	AllowQRCode   bool
}

var publishPlatformSpecs = map[string]publishPlatformSpec{
	"wechat_mp": {
		Platform: "wechat_mp", TitleMin: 1, TitleMax: 64, BodyMax: 0, TagMin: 0, TagMax: 10,
		CoverRequired: true, SummaryMax: 120, AllowURLs: false, AllowContact: true, AllowQRCode: true,
	},
	"xhs": {
		Platform: "xhs", TitleMin: 1, TitleMax: 20, BodyMax: 1000, TagMin: 1, TagMax: 10,
		CoverRequired: true, CoverRatios: []publishRatio{{3, 4}},
		AllowURLs: false, AllowContact: false, AllowQRCode: false,
	},
	"toutiao": {
		Platform: "toutiao", TitleMin: 1, TitleMax: 30, BodyMax: 0, TagMin: 0, TagMax: 5,
		CoverRequired: true, CoverRatios: []publishRatio{{3, 4}, {4, 3}},
		AllowURLs: true, AllowContact: true, AllowQRCode: true,
	},
}

func publishPlatformSupported(platform string) bool {
	_, ok := publishPlatformSpecs[platform]
	return ok
}

func publishPlatformSpecFor(platform string) (publishPlatformSpec, bool) {
	spec, ok := publishPlatformSpecs[platform]
	return spec, ok
}

type PublishCheck struct {
	Code     string `json:"code"`
	OK       bool   `json:"ok"`
	Severity string `json:"severity"`
	Field    string `json:"field"`
	Message  string `json:"message"`
}

type PublishValidation struct {
	Checks           []PublishCheck `json:"checks"`
	ValidatorVersion string         `json:"validator_version"`
	CheckedAt        time.Time      `json:"checked_at"`
}

type publishValidationOptions struct {
	SkipRequested bool
	Now           time.Time
}

type publishValidationContext struct {
	BannedWords []string
	Options     publishValidationOptions
}

var (
	publishURLPattern     = regexp.MustCompile(`(?:https?://|www\.)[^\s]+`)
	publishContactPattern = regexp.MustCompile(`(?:微信|威信|VX|vx|QQ|qq|电话|手机号|tel|微信ID|加我)[:：\s]*[A-Za-z0-9_\-+]{3,}`)
	publishPhonePattern   = regexp.MustCompile(`1[3-9][0-9]{9}|0[0-9]{2,3}-[0-9]{7,8}`)
	publishQRPattern      = regexp.MustCompile(`二维码|扫码|QR\s*code|QRCode`)
)

// validatePublishManifest is pure: callers pass the platform spec, banned words
// and the read time so every rule can be tested without a database.
func validatePublishManifest(platform string, payload PublishManifestPayload, ctx publishValidationContext) PublishValidation {
	now := ctx.Options.Now
	if now.IsZero() {
		now = time.Now()
	}
	checks := make([]PublishCheck, 0, 20)
	add := func(code string, ok bool, severity, field, message string) {
		checks = append(checks, PublishCheck{Code: code, OK: ok, Severity: severity, Field: field, Message: message})
	}

	spec, ok := publishPlatformSpecFor(platform)
	if !ok {
		add("platform_unsupported", false, "block", "platform", "暂不支持该发布平台")
		return PublishValidation{Checks: checks, ValidatorVersion: publishValidatorVersion, CheckedAt: now}
	}

	title := strings.TrimSpace(payload.Fields.Title)
	bodyMD := strings.TrimSpace(payload.Fields.BodyMD)
	bodyText := strings.TrimSpace(payload.Fields.BodyText)
	tags := payload.Fields.Tags
	// body_md 是主内容；公众号的 HTML 由现有渲染链在推送时生成，这里只保留 Markdown 快照。
	if bodyText == "" {
		bodyText = bodyMD
	}

	add("required", title != "", "block", "title", "标题不能为空")
	if spec.TitleMin > 0 {
		n := runeLen(title)
		add("length", n >= spec.TitleMin && n <= spec.TitleMax, "block", "title",
			fmt.Sprintf("标题需为 %d–%d 字，当前 %d 字", spec.TitleMin, spec.TitleMax, n))
	}
	add("required", bodyMD != "", "block", "body_md", "正文不能为空")
	if spec.BodyMax > 0 {
		n := runeLen(bodyText)
		add("length", n <= spec.BodyMax, "block", "body_text",
			fmt.Sprintf("正文不能超过 %d 字，当前 %d 字", spec.BodyMax, n))
	}
	if spec.SummaryMax > 0 {
		summary := publishPlatformString(payload.Fields.PlatformFields, "summary")
		add("length", runeLen(summary) <= spec.SummaryMax, "block", "platform_fields.summary",
			fmt.Sprintf("摘要不能超过 %d 字，当前 %d 字", spec.SummaryMax, runeLen(summary)))
	}

	if spec.CoverRequired {
		hasCover := payload.Fields.CoverAssetID != nil
		add("required", hasCover, "block", "cover_asset_id", "必须提供封面")
	}
	if hasPublishCover(payload.Fields.CoverAssetID) && len(spec.CoverRatios) > 0 {
		cover, found := publishCoverAsset(payload)
		okRatio := false
		detail := "封面比例需为 3:4" // replaced below for Toutiao's two allowed ratios.
		expected := publishRatiosLabel(spec.CoverRatios)
		detail = "封面比例需为 " + expected
		if found && cover.Width > 0 && cover.Height > 0 {
			for _, ratio := range spec.CoverRatios {
				if publishRatioClose(cover.Width, cover.Height, ratio) {
					okRatio = true
					break
				}
			}
			if !okRatio {
				found = false
			}
		}
		if !found {
			okRatio = false
		}
		add("cover_ratio", okRatio, "block", "cover_asset_id", detail)
	}

	tagCount := len(publishCleanTags(tags))
	add("tag_count", tagCount >= spec.TagMin && tagCount <= spec.TagMax, "block", "tags",
		fmt.Sprintf("标签需为 %d–%d 个，当前 %d 个", spec.TagMin, spec.TagMax, tagCount))

	if payload.Fields.ScheduleAt != nil && payload.Fields.ScheduleAt.Before(now) {
		add("schedule_past", false, "block", "schedule_at", "定时发布时间不能早于当前时间")
	} else {
		add("schedule_past", true, "block", "schedule_at", "定时发布时间可用")
	}

	if ctx.Options.SkipRequested && strings.TrimSpace(payload.Fields.SkipReason) == "" {
		add("skip_reason_required", false, "block", "skip_reason", "跳过发布必须填写原因")
	} else {
		add("skip_reason_required", true, "block", "skip_reason", "未跳过或已填写跳过原因")
	}

	// 外链/联系方式/二维码：公众号只允许“阅读原文”走 platform_fields.source_url。
	if !spec.AllowURLs {
		if url := publishURLPattern.FindString(bodyText); url != "" {
			add("banned_word", false, "block", "body_text", "正文包含不允许的外链："+publishTruncate(url, 80))
		}
	}
	if !spec.AllowContact {
		if hit := publishContactPattern.FindString(bodyText); hit != "" {
			add("banned_word", false, "block", "body_text", "正文包含联系方式："+publishTruncate(hit, 80))
		} else if hit := publishPhonePattern.FindString(bodyText); hit != "" {
			add("banned_word", false, "block", "body_text", "正文包含手机号："+publishTruncate(hit, 80))
		}
	}
	if !spec.AllowQRCode && publishQRPattern.MatchString(bodyText) {
		add("banned_word", false, "block", "body_text", "正文包含二维码或扫码引导")
	}

	bannedHits := 0
	for _, word := range ctx.BannedWords {
		word = strings.TrimSpace(word)
		if word == "" {
			continue
		}
		if strings.Contains(title, word) || strings.Contains(bodyText, word) {
			add("banned_word", false, "block", "title/body_text", fmt.Sprintf("命中禁用词「%s」", word))
			bannedHits++
			if bannedHits >= 20 {
				break
			}
		}
	}
	if bannedHits == 0 {
		add("banned_word", true, "block", "title/body_text", "未命中禁用词")
	}

	add("ai_disclosure", true, "warn", "ai_disclosure", publishAIDisclosure(platform))

	return PublishValidation{Checks: checks, ValidatorVersion: publishValidatorVersion, CheckedAt: now}
}

func publishValidationState(v PublishValidation) string {
	for _, check := range v.Checks {
		if check.Severity == "block" && !check.OK {
			return "invalid"
		}
	}
	return "valid"
}

func hasPublishCover(id *uuid.UUID) bool { return id != nil }

func publishCoverAsset(payload PublishManifestPayload) (PublishManifestAsset, bool) {
	for _, asset := range payload.Assets {
		if asset.Role == "cover" {
			return asset, true
		}
	}
	return PublishManifestAsset{}, false
}

func publishRatioClose(w, h int, ratio publishRatio) bool {
	if w <= 0 || h <= 0 || ratio.W <= 0 || ratio.H <= 0 {
		return false
	}
	actual := float64(w) / float64(h)
	expected := float64(ratio.W) / float64(ratio.H)
	return math.Abs(actual-expected) <= 0.03
}

func publishRatiosLabel(ratios []publishRatio) string {
	parts := make([]string, 0, len(ratios))
	for _, ratio := range ratios {
		parts = append(parts, fmt.Sprintf("%d:%d", ratio.W, ratio.H))
	}
	return strings.Join(parts, " 或 ")
}

func publishCleanTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, tag := range tags {
		tag = strings.TrimSpace(strings.TrimPrefix(tag, "#"))
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true
		out = append(out, tag)
	}
	return out
}

func publishPlatformString(fields map[string]any, key string) string {
	if fields == nil {
		return ""
	}
	if value, ok := fields[key]; ok {
		if s, ok := value.(string); ok {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func publishAIDisclosure(platform string) string {
	switch platform {
	case "xhs":
		return "发布时在「笔记内容声明」中勾选「笔记含 AI 合成内容」"
	case "toutiao":
		return "发布前查看头条发布页当前的 AI 内容声明选项，并按真实创作情况处理；具体位置与规则待实测（V-029）"
	default:
		return "发布时在公众号文末或后台声明内容使用了 AI 辅助"
	}
}

func publishTruncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "…"
}
