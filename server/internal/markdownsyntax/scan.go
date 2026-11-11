package markdownsyntax

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extensionast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
	"golang.org/x/net/html"
)

const RulesVersion = "cx-render-1"

const maxFindings = 50

var (
	footnoteDefinition    = regexp.MustCompile(`(?m)^[ \t]{0,3}\[\^([^\]\r\n]+)\]:`)
	footnoteReference     = regexp.MustCompile(`\[\^([^\]\r\n]+)\]`)
	referenceDefinition   = regexp.MustCompile(`(?m)^[ \t]{0,3}\[([^\]\^\r\n]+)\]:`)
	fullReferenceLink     = regexp.MustCompile(`!?\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]`)
	shortcutReferenceLink = regexp.MustCompile(`!?\[([^\]\r\n]+)\]`)
	definitionList        = regexp.MustCompile(`(?m)^([^\r\n]+)\r?\n[ \t]{0,3}[:~][ \t]+\S`)
	tocMarker             = regexp.MustCompile(`(?i)\[\[toc\]\]`)
	mathOperator          = regexp.MustCompile(`[=+*/^_{}\\]`)
	taskMarker            = regexp.MustCompile(`^[ \t]*(?:[-+*]|[0-9]{1,9}[.)])[ \t]+\[[ xX]\][ \t]+`)
	emailPattern          = regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`)
	phonePattern          = regexp.MustCompile(`1[3-9][0-9]{9}`)
	longSecretPattern     = regexp.MustCompile(`(?i)\b(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~+/-]{12,})\b`)
)

type Section struct {
	ID      string
	Heading string
	Content string
}

type Finding struct {
	SectionID      string `json:"section_id"`
	SectionHeading string `json:"section_heading"`
	Line           int    `json:"line"`
	Column         int    `json:"column"`
	Syntax         string `json:"syntax"`
	Severity       string `json:"severity"`
	Excerpt        string `json:"excerpt"`
	Reason         string `json:"reason"`
	Suggestion     string `json:"suggestion"`
}

type Report struct {
	BasisRevision   int             `json:"basis_revision"`
	InputHash       string          `json:"input_hash"`
	RulesVersion    string          `json:"rules_version"`
	Issues          []Finding       `json:"issues"`
	Converted       []Finding       `json:"converted"`
	Warnings        []Finding       `json:"warnings"`
	FixSuggestions  []FixSuggestion `json:"fix_suggestions,omitempty"`
	Total           int             `json:"total"`
	Truncated       bool            `json:"truncated"`
	HasErrors       bool            `json:"-"`
}

type byteRange struct{ start, end int }
type categorizedFinding struct {
	kind         string
	finding      Finding
	sectionOrder int
}

var markdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

var allowedHTMLTags = map[string]bool{
	"section": true, "span": true, "div": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
	"p": true, "blockquote": true, "ul": true, "ol": true, "li": true,
	"dl": true, "dt": true, "dd": true, "strong": true, "b": true, "em": true,
	"i": true, "a": true, "img": true, "br": true, "hr": true, "del": true,
	"s": true, "strike": true, "ins": true, "pre": true, "code": true,
	"kbd": true, "mark": true, "small": true, "sub": true, "sup": true,
	"table": true, "thead": true, "tbody": true, "tfoot": true, "tr": true,
	"th": true, "td": true, "caption": true, "details": true, "summary": true,
	"figure": true, "figcaption": true,
}

// Scan checks a saved set of work sections with source positions. It does not render HTML.
func Scan(sections []Section, basisRevision int, assetIDs map[string]bool) Report {
	input := struct {
		RulesVersion string    `json:"rules_version"`
		Basis        int       `json:"basis_revision"`
		Sections     []Section `json:"sections"`
		Assets       []string  `json:"assets"`
	}{RulesVersion: RulesVersion, Basis: basisRevision, Sections: sections}
	for id := range assetIDs {
		input.Assets = append(input.Assets, id)
	}
	sort.Strings(input.Assets)
	canonical, _ := json.Marshal(input)
	hash := sha256.Sum256(canonical)
	report := Report{BasisRevision: basisRevision, InputHash: hex.EncodeToString(hash[:]), RulesVersion: RulesVersion,
		Issues: []Finding{}, Converted: []Finding{}, Warnings: []Finding{}}
	all := make([]categorizedFinding, 0)
	for i, section := range sections {
		findings := scanSection(section, assetIDs)
		for j := range findings {
			findings[j].sectionOrder = i
		}
		all = append(all, findings...)
	}
	sort.SliceStable(all, func(i, j int) bool {
		priority := func(kind string) int {
			switch kind {
			case "issue":
				return 0
			case "converted":
				return 1
			default:
				return 2
			}
		}
		if priority(all[i].kind) != priority(all[j].kind) {
			return priority(all[i].kind) < priority(all[j].kind)
		}
		a, b := all[i].finding, all[j].finding
		if all[i].sectionOrder != all[j].sectionOrder {
			return all[i].sectionOrder < all[j].sectionOrder
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		if a.Column != b.Column {
			return a.Column < b.Column
		}
		return a.Syntax < b.Syntax
	})
	report.Total = len(all)
	report.Truncated = len(all) > maxFindings
	for _, item := range all {
		if item.kind == "issue" {
			report.HasErrors = true
			break
		}
	}
	if len(all) > maxFindings {
		all = all[:maxFindings]
	}
	for _, item := range all {
		switch item.kind {
		case "converted":
			report.Converted = append(report.Converted, item.finding)
		case "warning":
			report.Warnings = append(report.Warnings, item.finding)
		default:
			report.Issues = append(report.Issues, item.finding)
		}
	}
	// DEEP-02：可安全自动修复的子集挂到报告上；不可修的仍只报告。
	report.FixSuggestions = SuggestFixes(sections)
	return report
}

func scanSection(section Section, assetIDs map[string]bool) []categorizedFinding {
	source := []byte(section.Content)
	doc := markdown.Parser().Parse(text.NewReader(source))
	protected := make([]byteRange, 0)
	out := make([]categorizedFinding, 0)
	add := func(kind, syntax string, at int, reason, suggestion string) {
		line, column := sourceLocation(source, at)
		out = append(out, categorizedFinding{kind: kind, finding: Finding{
			SectionID: section.ID, SectionHeading: safeText(section.Heading, 120), Line: line, Column: column,
			Syntax: syntax, Severity: map[bool]string{true: "error", false: "warning"}[kind == "issue"],
			Excerpt: safeExcerpt(source, at), Reason: reason, Suggestion: suggestion,
		}})
	}
	var taskOffsets []int
	var htmlParts []byteRange
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n := node.(type) {
		case *ast.Heading:
			if n.Level == 1 || n.Level == 2 {
				add("converted", "h"+itoa(n.Level)+"_to_h3", lineStart(source, firstNodeOffset(n)), "正文标题会统一显示为三级标题。", "保留当前规则，发布前核对标题层级。")
			} else if n.Level >= 4 {
				add("converted", "h4_to_strong", lineStart(source, firstNodeOffset(n)), "四级及更深正文标题会转换为加粗段落。", "如需标题层级，请改用三级标题。")
			}
		case *ast.FencedCodeBlock:
			protectSegments(&protected, n.Lines(), len(source))
			if strings.EqualFold(strings.TrimSpace(string(n.Language(source))), "mermaid") {
				at := firstNodeOffset(n)
				if n.Info != nil {
					at = n.Info.Segment.Start
				}
				add("issue", "mermaid", lineStart(source, at), "Mermaid 图表不会被当前排版器渲染。", "请改用图片并上传到本作品，或移除图表源码。")
			}
		case *ast.CodeBlock:
			protectSegments(&protected, n.Lines(), len(source))
		case *ast.CodeSpan:
			_ = ast.Walk(n, func(child ast.Node, childEntering bool) (ast.WalkStatus, error) {
				if childEntering {
					if t, ok := child.(*ast.Text); ok {
						protected = append(protected, byteRange{t.Segment.Start, t.Segment.Stop})
					}
				}
				return ast.WalkContinue, nil
			})
		case *ast.HTMLBlock:
			protectSegments(&protected, n.Lines(), len(source))
			if n.Lines().Len() > 0 {
				first := n.Lines().At(0)
				last := n.Lines().At(n.Lines().Len() - 1)
				htmlParts = append(htmlParts, byteRange{first.Start, last.Stop})
			}
		case *ast.RawHTML:
			for i := 0; i < n.Segments.Len(); i++ {
				seg := n.Segments.At(i)
				protected = append(protected, byteRange{seg.Start, seg.Stop})
				htmlParts = append(htmlParts, byteRange{seg.Start, seg.Stop})
			}
		case *ast.List:
			depth := 1
			for parent := n.Parent(); parent != nil; parent = parent.Parent() {
				if _, ok := parent.(*ast.List); ok {
					depth++
				}
			}
			if depth > 3 {
				at := firstNodeOffset(n)
				add("issue", "list_too_deep", lineStart(source, at), "当前排版最多支持三级列表。", "请合并或减少列表嵌套层级。")
			}
		case *extensionast.TaskCheckBox:
			if at := taskMarkerOffset(node, source); at >= 0 {
				taskOffsets = append(taskOffsets, at)
			}
		case *ast.Link, *ast.AutoLink:
			destination := nodeDestination(node, source)
			if destination != "" {
				at := linkOffset(node, source)
				if at >= 0 && strings.HasPrefix(string(source[at:]), "[^") {
					break
				}
				addURLFinding(destination, at, add)
			}
		case *ast.Image:
			destination := string(n.Destination)
			at := linkOffset(node, source)
			if id := assetIDFromURL(destination); id != "" && assetIDs[id] {
				break
			}
			add("warning", "unmanaged_image", at, "图片未关联到当前作品资产，交付构建会阻断。", "请先把图片逐张上传到当前作品并插入托管链接。")
		}
		return ast.WalkContinue, nil
	})

	for _, at := range taskOffsets {
		add("converted", "task_list_to_marker", at, "任务列表会显示为不可交互的勾选符号。", "无需修改；检查发布后的符号和文字即可。")
	}
	for _, part := range htmlParts {
		out = append(out, scanHTML(source, part, section, assetIDs)...)
	}
	masked := maskRanges(source, protected)
	out = append(out, scanUnsupportedInlineSyntax(source, masked, section)...)
	return out
}

func scanUnsupportedInlineSyntax(source, masked []byte, section Section) []categorizedFinding {
	var out []categorizedFinding
	addOne := func(kind, syntax string, at int, reason, suggestion string) {
		line, column := sourceLocation(source, at)
		out = append(out, categorizedFinding{kind: kind, finding: Finding{SectionID: section.ID,
			SectionHeading: safeText(section.Heading, 120), Line: line, Column: column, Syntax: syntax,
			Severity: map[bool]string{true: "error", false: "warning"}[kind == "issue"], Excerpt: safeExcerpt(source, at),
			Reason: reason, Suggestion: suggestion}})
	}
	footnotes := map[string]bool{}
	definitionLines := map[int]bool{}
	for _, match := range footnoteDefinition.FindAllSubmatchIndex(masked, -1) {
		if isEscaped(masked, match[0]) {
			continue
		}
		label := strings.ToLower(string(masked[match[2]:match[3]]))
		footnotes[label] = true
		definitionLines[lineStart(source, match[0])] = true
		addOne("issue", "footnote", match[0], "当前渲染器不支持 Markdown 脚注。", "请改为正文中的普通引用说明或链接。")
	}
	for _, match := range footnoteReference.FindAllSubmatchIndex(masked, -1) {
		if isEscaped(masked, match[0]) || !footnotes[strings.ToLower(string(masked[match[2]:match[3]]))] {
			continue
		}
		if definitionLines[lineStart(source, match[0])] {
			continue
		}
		addOne("issue", "footnote", match[0], "当前渲染器不支持 Markdown 脚注。", "请改为正文中的普通引用说明或链接。")
	}

	definitions := map[string]bool{}
	referenceDefinitionLines := map[int]bool{}
	for _, match := range referenceDefinition.FindAllSubmatchIndex(masked, -1) {
		if isEscaped(masked, match[0]) {
			continue
		}
		referenceDefinitionLines[lineStart(source, match[0])] = true
		definitions[normalizeReference(string(masked[match[2]:match[3]]))] = true
	}
	seenRefs := map[int]bool{}
	for _, match := range fullReferenceLink.FindAllSubmatchIndex(masked, -1) {
		if isEscaped(masked, match[0]) {
			continue
		}
		if referenceDefinitionLines[lineStart(source, match[0])] {
			continue
		}
		label := string(masked[match[4]:match[5]])
		if strings.TrimSpace(label) == "" {
			label = string(masked[match[2]:match[3]])
		}
		if strings.HasPrefix(strings.TrimSpace(label), "^") {
			continue
		}
		if definitions[normalizeReference(label)] {
			seenRefs[match[0]] = true
			if match[4] > 0 {
				seenRefs[match[4]-1] = true
			}
			addOne("issue", "reference_link", match[0], "当前渲染器不支持引用式链接。", "请改为显式 http/https 地址。")
		}
	}
	for _, match := range shortcutReferenceLink.FindAllSubmatchIndex(masked, -1) {
		if isEscaped(masked, match[0]) || seenRefs[match[0]] {
			continue
		}
		if referenceDefinitionLines[lineStart(source, match[0])] {
			continue
		}
		label := string(masked[match[2]:match[3]])
		if strings.HasPrefix(strings.TrimSpace(label), "^") {
			continue
		}
		if definitions[normalizeReference(label)] {
			addOne("issue", "reference_link", match[0], "当前渲染器不支持引用式链接。", "请改为显式 http/https 地址。")
		}
	}

	for _, match := range definitionList.FindAllSubmatchIndex(masked, -1) {
		at := match[0] + bytesIndex(masked[match[0]:match[1]], []byte("\n")) + 1
		if !isEscaped(masked, at) {
			addOne("issue", "definition_list", at, "当前渲染器不支持 Markdown 定义列表。", "请改为普通段落或项目符号列表。")
		}
	}
	for _, match := range tocMarker.FindAllIndex(masked, -1) {
		if !isEscaped(masked, match[0]) {
			addOne("issue", "toc", match[0], "当前渲染器不支持自动目录标记。", "请手工编写目录，或移除目录标记。")
		}
	}
	for i := 0; i < len(masked); i++ {
		if masked[i] != '$' || isEscaped(masked, i) {
			continue
		}
		delim := []byte("$")
		if i+1 < len(masked) && masked[i+1] == '$' {
			delim = []byte("$$")
		}
		start := i + len(delim)
		rel := bytesIndex(masked[start:], delim)
		if rel < 0 {
			continue
		}
		end := start + rel
		inside := strings.TrimSpace(string(masked[start:end]))
		if inside != "" && (string(delim) == "$$" || mathOperator.MatchString(inside)) {
			addOne("issue", "math", i, "当前渲染器不支持数学公式语法。", "请改为普通文本或上传公式图片。")
			i = end + len(delim) - 1
		}
	}
	for _, pair := range [][2]string{{`\(`, `\)`}, {`\[`, `\]`}} {
		for i := 0; i < len(masked); i++ {
			if !bytes.HasPrefix(masked[i:], []byte(pair[0])) || isEscaped(masked, i) {
				continue
			}
			rel := bytesIndex(masked[i+len(pair[0]):], []byte(pair[1]))
			if rel >= 0 {
				addOne("issue", "math", i, "当前渲染器不支持数学公式语法。", "请改为普通文本或上传公式图片。")
				i += len(pair[0]) + rel + len(pair[1]) - 1
			}
		}
	}
	return out
}

func scanHTML(source []byte, part byteRange, section Section, assetIDs map[string]bool) []categorizedFinding {
	if part.start < 0 || part.end > len(source) || part.start >= part.end {
		return nil
	}
	fragment := source[part.start:part.end]
	z := html.NewTokenizer(strings.NewReader(string(fragment)))
	out := make([]categorizedFinding, 0)
	pos := 0
	for {
		typeOfToken := z.Next()
		raw := z.Raw()
		if typeOfToken == html.ErrorToken {
			break
		}
		tokenStart := part.start + pos
		pos += len(raw)
		if typeOfToken != html.StartTagToken && typeOfToken != html.SelfClosingTagToken {
			continue
		}
		token := z.Token()
		tag := strings.ToLower(token.Data)
		knownDangerousTag := false
		switch tag {
		case "script", "style", "iframe", "video", "audio", "link", "source", "embed", "object", "base":
			knownDangerousTag = true
			out = append(out, makeFinding("issue", "dangerous_html", source, tokenStart, section,
				"该 HTML 标签会执行脚本、加载外部资源或嵌入活动内容。", "请删除此标签，或改为安全的静态内容。"))
		}
		if !knownDangerousTag && !allowedHTMLTags[tag] {
			out = append(out, makeFinding("converted", "html_tag_fallback", source, tokenStart, section,
				"当前标签会转换为通用容器，子内容和允许属性会保留。", "如样式结构重要，请改用支持的安全 HTML 标签。"))
		}
		for _, attr := range token.Attr {
			name := strings.ToLower(attr.Key)
			if strings.HasPrefix(name, "on") {
				out = append(out, makeFinding("issue", "dangerous_html", source, tokenStart, section,
					"HTML 事件属性不允许进入排版内容。", "请删除事件属性并保留必要的静态文字。"))
			}
			if name == "src" && tag != "img" && attr.Val != "" {
				out = append(out, makeFinding("issue", "external_resource", source, tokenStart, section,
					"当前策略不允许原始 HTML 加载外部资源。", "请删除该资源引用，或使用当前作品中已托管的图片。"))
			}
			if (name == "href" || name == "src") && unsafeURL(attr.Val) {
				out = append(out, makeFinding("issue", "unsafe_url", source, tokenStart, section,
					"链接协议不安全。", "请改为 http/https 链接或移除地址。"))
				continue
			}
			u, err := url.Parse(strings.TrimSpace(attr.Val))
			if name == "href" && err == nil && u.Scheme == "" {
				out = append(out, makeFinding("warning", "relative_link", source, tokenStart, section,
					"相对链接会被移除，读者无法通过此链接跳转。", "请改用可公开访问的 http/https 地址或移除链接。"))
			}
			if name == "src" && tag == "img" {
				if id := assetIDFromURL(attr.Val); id == "" || !assetIDs[id] {
					out = append(out, makeFinding("warning", "unmanaged_image", source, tokenStart, section,
						"图片未关联到当前作品资产，交付构建会阻断。", "请先把图片逐张上传到当前作品并插入托管链接。"))
				}
			}
		}
	}
	return out
}

func addURLFinding(raw string, at int, add func(string, string, int, string, string)) {
	if unsafeURL(raw) {
		add("issue", "unsafe_url", at, "链接协议不安全。", "请改为 http/https 链接或移除地址。")
		return
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err == nil && u.Scheme == "" && !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		add("warning", "relative_link", at, "相对链接会被移除，读者无法通过此链接跳转。", "请改用可公开访问的 http/https 地址或移除链接。")
	}
}

func unsafeURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return true
	}
	scheme := strings.ToLower(u.Scheme)
	return scheme != "" && scheme != "http" && scheme != "https"
}

func makeFinding(kind, syntax string, source []byte, at int, section Section, reason, suggestion string) categorizedFinding {
	line, column := sourceLocation(source, at)
	severity := "warning"
	if kind == "issue" {
		severity = "error"
	}
	return categorizedFinding{kind: kind, finding: Finding{SectionID: section.ID, SectionHeading: safeText(section.Heading, 120),
		Line: line, Column: column, Syntax: syntax, Severity: severity, Excerpt: safeExcerpt(source, at), Reason: reason, Suggestion: suggestion}}
}

func nodeDestination(node ast.Node, source []byte) string {
	switch n := node.(type) {
	case *ast.Link:
		return string(n.Destination)
	case *ast.AutoLink:
		return string(n.URL(source))
	default:
		return ""
	}
}

func linkOffset(node ast.Node, source []byte) int {
	child := firstTextOffset(node)
	if child < 0 {
		return 0
	}
	start := lineStart(source, child)
	if start < child {
		line := source[start:child]
		if at := strings.LastIndex(string(line), "["); at >= 0 {
			if node.Kind() == ast.KindImage {
				at--
			}
			return start + max(0, at)
		}
	}
	return child
}

func taskMarkerOffset(node ast.Node, source []byte) int {
	for parent := node.Parent(); parent != nil; parent = parent.Parent() {
		if _, ok := parent.(*ast.ListItem); !ok {
			continue
		}
		if child := firstTextOffset(parent); child >= 0 {
			start := lineStart(source, child)
			lineEnd := bytesIndex(source[start:], []byte("\n"))
			if lineEnd < 0 {
				lineEnd = len(source) - start
			}
			if loc := taskMarker.FindIndex(source[start : start+lineEnd]); loc != nil {
				return start + loc[0]
			}
		}
	}
	return -1
}

func firstTextOffset(node ast.Node) int {
	var found = -1
	_ = ast.Walk(node, func(child ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering && found < 0 {
			if t, ok := child.(*ast.Text); ok {
				found = t.Segment.Start
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	return found
}

func firstNodeOffset(node ast.Node) int {
	if textNode, ok := node.(*ast.FencedCodeBlock); ok && textNode.Info != nil {
		return textNode.Info.Segment.Start
	}
	if n, ok := node.(interface{ Lines() *text.Segments }); ok && n.Lines() != nil && n.Lines().Len() > 0 {
		return n.Lines().At(0).Start
	}
	return firstTextOffset(node)
}

func protectSegments(ranges *[]byteRange, segments *text.Segments, size int) {
	if segments == nil {
		return
	}
	for i := 0; i < segments.Len(); i++ {
		segment := segments.At(i)
		if segment.Start >= 0 && segment.Stop <= size && segment.Start < segment.Stop {
			*ranges = append(*ranges, byteRange{segment.Start, segment.Stop})
		}
	}
}

func maskRanges(source []byte, ranges []byteRange) []byte {
	out := append([]byte(nil), source...)
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	for _, span := range ranges {
		if span.start < 0 || span.end > len(out) || span.start >= span.end {
			continue
		}
		for i := span.start; i < span.end; i++ {
			if out[i] != '\n' && out[i] != '\r' {
				out[i] = ' '
			}
		}
	}
	return out
}

func sourceLocation(source []byte, at int) (int, int) {
	if at < 0 {
		at = 0
	}
	if at > len(source) {
		at = len(source)
	}
	line := 1
	lineStartAt := 0
	for i := 0; i < at; i++ {
		if source[i] == '\n' {
			line++
			lineStartAt = i + 1
		}
	}
	columnBytes := source[lineStartAt:at]
	columnBytes = bytesTrimRightCR(columnBytes)
	return line, utf8.RuneCount(columnBytes) + 1
}

func lineStart(source []byte, at int) int {
	if at < 0 {
		return 0
	}
	if at > len(source) {
		at = len(source)
	}
	for at > 0 && source[at-1] != '\n' {
		at--
	}
	return at
}

func safeExcerpt(source []byte, at int) string {
	textValue := string(source)
	runes := []rune(textValue)
	pos := utf8.RuneCount(source[:max(0, min(at, len(source)))])
	start := max(0, pos-24)
	end := min(len(runes), start+80)
	if end-start < 80 {
		start = max(0, end-80)
	}
	textValue = string(runes[start:end])
	textValue = emailPattern.ReplaceAllString(textValue, "[邮箱已隐藏]")
	textValue = phonePattern.ReplaceAllString(textValue, "[手机号已隐藏]")
	textValue = longSecretPattern.ReplaceAllString(textValue, "[凭证已隐藏]")
	return textValue
}

func safeText(value string, limit int) string {
	value = emailPattern.ReplaceAllString(value, "[邮箱已隐藏]")
	value = phonePattern.ReplaceAllString(value, "[手机号已隐藏]")
	value = longSecretPattern.ReplaceAllString(value, "[凭证已隐藏]")
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}

func isEscaped(source []byte, at int) bool {
	count := 0
	for i := at - 1; i >= 0 && source[i] == '\\'; i-- {
		count++
	}
	return count%2 == 1
}

func normalizeReference(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

func assetIDFromURL(raw string) string {
	const prefix = "/api/v1/assets/"
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	path := u.Path
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	part := strings.TrimPrefix(path, prefix)
	part = strings.TrimSuffix(part, "/file")
	if strings.Contains(part, "/") || len(part) != 36 {
		return ""
	}
	return strings.ToLower(part)
}

func bytesIndex(source, needle []byte) int {
	if len(needle) == 0 {
		return 0
	}
	return strings.Index(string(source), string(needle))
}

func bytesTrimRightCR(source []byte) []byte {
	return bytes.TrimSuffix(source, []byte("\r"))
}

func itoa(value int) string {
	return string(rune('0' + value))
}
