// Package cxbuildvalidate performs service-side structural and source-integrity
// checks for HTML artifacts produced by the independent web and desktop clients.
package cxbuildvalidate

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	gmhtml "github.com/yuin/goldmark/renderer/html"
	_ "golang.org/x/image/webp"
	xhtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

type Section struct {
	ID        string
	Position  int
	Heading   string
	ContentMD string
}

type Asset struct {
	ID       string
	WorkID   *string
	SHA256   string
	MIME     string
	Width    int
	Height   int
	Bytes    int64
	Position int
	AltText  string
	Data     []byte
	IsCover  bool
}

type ImageEvidence struct {
	Index         int    `json:"index"`
	Role          string `json:"role"`
	SectionID     string `json:"section_id"`
	Heading       string `json:"heading"`
	AssetID       string `json:"asset_id"`
	DisplayName   string `json:"file_name"`
	MIME          string `json:"mime"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	Bytes         int64  `json:"bytes"`
	SHA256        string `json:"sha256"`
	OutputSHA256  string `json:"output_sha256"`
	Caption       string `json:"caption"`
	MappingStatus string `json:"mapping_status"`
}

type ValidationReport struct {
	ValidatorVersion string          `json:"validator_version"`
	ImageEvidence    []ImageEvidence `json:"image_evidence"`
	UnusedAssetIDs   []string        `json:"unused_asset_ids"`
}

type ValidationError struct {
	Code       string
	Message    string
	SectionID  string
	Occurrence int
	AssetID    string
}

func (e *ValidationError) Error() string { return e.Code + ": " + e.Message }

const ValidatorVersion = "cx-html-1"

var (
	assetRoute      = regexp.MustCompile(`^/api/v1/assets/([0-9a-fA-F-]{36})/file$`)
	cssUnsafe       = regexp.MustCompile(`(?i)(url\s*\(|@import|expression\s*\(|-moz-binding|behavior\s*:|\\|/\*|\*/)`)
	styleProperties = map[string]bool{
		"color": true, "background-color": true, "font-size": true, "font-weight": true, "font-style": true,
		"line-height": true, "letter-spacing": true, "text-align": true, "text-decoration": true,
		"margin": true, "margin-top": true, "margin-bottom": true, "margin-left": true, "margin-right": true,
		"padding": true, "padding-top": true, "padding-bottom": true, "padding-left": true, "padding-right": true,
		"border": true, "border-left": true, "border-right": true, "border-top": true, "border-bottom": true, "border-radius": true,
		"display": true, "width": true, "max-width": true, "height": true, "word-break": true,
		"white-space": true, "font-family": true, "box-sizing": true, "overflow-wrap": true,
		"list-style-type": true, "background": true, "border-collapse": true, "caption-side": true,
		"overflow-x": true,
	}
)

var markdown = goldmark.New(
	goldmark.WithExtensions(extension.GFM),
	goldmark.WithRendererOptions(gmhtml.WithUnsafe()),
)

// ValidateWechatHTML checks that the supplied DOM is a safe rendering of the
// frozen section sequence. stable selects the offline form, where image src
// values must contain the exact bytes of their frozen asset.
func ValidateWechatHTML(raw []byte, sections []Section, assets map[string]Asset, stable bool, expectedTitle ...string) (ValidationReport, error) {
	if !utf8.Valid(raw) || bytes.HasPrefix(raw, []byte{0xef, 0xbb, 0xbf}) || bytes.IndexByte(raw, 0) >= 0 {
		return ValidationReport{}, invalid("HTML must be strict UTF-8 without a BOM")
	}
	doc, err := xhtml.Parse(bytes.NewReader(raw))
	if err != nil {
		return ValidationReport{}, invalid("HTML DOM cannot be parsed")
	}
	body := firstElement(doc, "body")
	if body == nil {
		return ValidationReport{}, invalid("HTML body is missing")
	}
	if err := validateDocumentEnvelope(doc, body); err != nil {
		return ValidationReport{}, err
	}
	if stable && len(expectedTitle) > 0 {
		title := firstElement(firstElement(doc, "head"), "title")
		if title == nil || normalizeText(textContent([]*xhtml.Node{title})) != normalizeText(expectedTitle[0]) {
			return ValidationReport{}, invalid("stable HTML title does not match the frozen work title")
		}
	}
	root, err := onlyElementChild(body)
	if err != nil || root.Data != "section" {
		return ValidationReport{}, invalid("HTML must contain one section root")
	}
	if err := validateNodePolicy(root); err != nil {
		return ValidationReport{}, err
	}
	wrappers := make([]*xhtml.Node, 0, len(sections))
	for child := root.FirstChild; child != nil; child = child.NextSibling {
		if isBlankText(child) {
			continue
		}
		if child.Type != xhtml.ElementNode || child.Data != "div" || attr(child, "data-section-id") == "" {
			return ValidationReport{}, invalid("section root may contain only identified section wrappers")
		}
		wrappers = append(wrappers, child)
	}
	if len(wrappers) != len(sections) {
		return ValidationReport{}, invalid("rendered section count does not match the frozen source")
	}
	seenAssetIDs := map[string]bool{}
	report := ValidationReport{ValidatorVersion: ValidatorVersion, ImageEvidence: []ImageEvidence{}, UnusedAssetIDs: []string{}}
	for index, wrapper := range wrappers {
		section := sections[index]
		if attr(wrapper, "data-section-id") != section.ID {
			return ValidationReport{}, invalidAt("rendered section order does not match the frozen source", section.ID, 0, "")
		}
		if err := validateSectionText(wrapper, section); err != nil {
			return ValidationReport{}, err
		}
		expectedIDs, err := sourceImageIDs(section.ContentMD)
		if err != nil {
			return ValidationReport{}, invalid("frozen image references cannot be parsed")
		}
		actualImages := elements(wrapper, "img")
		if len(actualImages) != len(expectedIDs) {
			return ValidationReport{}, invalidAt("image occurrence count does not match the frozen section", section.ID, min(len(actualImages), len(expectedIDs))+1, "")
		}
		for occurrence, img := range actualImages {
			assetID, data, err := imageReference(img, stable, assets)
			if err != nil {
				var validationErr *ValidationError
				if errors.As(err, &validationErr) {
					if validationErr.SectionID == "" {
						validationErr.SectionID = section.ID
					}
					if validationErr.Occurrence == 0 {
						validationErr.Occurrence = occurrence + 1
					}
					if validationErr.AssetID == "" && occurrence < len(expectedIDs) {
						validationErr.AssetID = expectedIDs[occurrence]
					}
				}
				return ValidationReport{}, err
			}
			if assetID != expectedIDs[occurrence] {
				return ValidationReport{}, invalidAt("image occurrence order does not match the frozen section", section.ID, occurrence+1, expectedIDs[occurrence])
			}
			asset, ok := assets[assetID]
			if !ok || !validAsset(asset) {
				return ValidationReport{}, &ValidationError{Code: "image_missing", Message: "a referenced frozen asset is unavailable or changed"}
			}
			if stable && !bytes.Equal(data, asset.Data) {
				return ValidationReport{}, invalid("stable HTML image bytes differ from the frozen asset")
			}
			if alt := attr(img, "alt"); len([]rune(alt)) > 500 {
				return ValidationReport{}, invalid("image alternative text is too long")
			}
			caption := attr(img, "alt")
			if caption == "" {
				caption = asset.AltText
			}
			report.ImageEvidence = append(report.ImageEvidence, ImageEvidence{
				Index: len(report.ImageEvidence) + 1, Role: "body", SectionID: section.ID,
				Heading: section.Heading, AssetID: assetID, DisplayName: frozenAssetName(asset), MIME: asset.MIME,
				Width: asset.Width, Height: asset.Height, Bytes: asset.Bytes,
				SHA256: asset.SHA256, OutputSHA256: asset.SHA256, Caption: caption, MappingStatus: "verified",
			})
			seenAssetIDs[assetID] = true
		}
	}
	for assetID, asset := range assets {
		if !seenAssetIDs[assetID] && !asset.IsCover {
			report.UnusedAssetIDs = append(report.UnusedAssetIDs, assetID)
		}
	}
	return report, nil
}

func frozenAssetName(asset Asset) string {
	extension := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[asset.MIME]
	return "素材-" + asset.ID + extension
}

// ReferencedImageIDs returns Markdown/HTML image references in section order,
// retaining repeated occurrences for strict order validation.
func ReferencedImageIDs(sections []Section) ([]string, error) {
	ids := []string{}
	for _, section := range sections {
		found, err := sourceImageIDs(section.ContentMD)
		if err != nil {
			return nil, err
		}
		ids = append(ids, found...)
	}
	return ids, nil
}

// ValidateFrozenAsset checks the exact bytes and decoded image metadata against
// the immutable asset row captured by the build snapshot.
func ValidateFrozenAsset(asset Asset) error {
	if !validAsset(asset) {
		return imageMissing()
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(asset.Data))
	if err != nil || config.Width != asset.Width || config.Height != asset.Height {
		return imageMissing()
	}
	expectedFormat := map[string]string{"image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp"}[asset.MIME]
	if expectedFormat == "" || format != expectedFormat {
		return imageMissing()
	}
	return nil
}

func validateSectionText(wrapper *xhtml.Node, section Section) error {
	var expected bytes.Buffer
	if section.Heading != "" {
		expected.WriteString(section.Heading)
		expected.WriteByte('\n')
	}
	content := strings.ReplaceAll(section.ContentMD, "[markdownHTMLNode]", "")
	if err := markdown.Convert([]byte(content), &expected); err != nil {
		return invalid("frozen markdown cannot be parsed")
	}
	contextNode := &xhtml.Node{Type: xhtml.ElementNode, Data: "div", DataAtom: atom.Div}
	expectedNodes, err := xhtml.ParseFragment(bytes.NewReader(expected.Bytes()), contextNode)
	if err != nil {
		return invalid("frozen markdown rendering cannot be checked")
	}
	expectedText := textContent(expectedNodes)
	actualText := textContent([]*xhtml.Node{wrapper})
	if normalizeText(expectedText) != normalizeText(actualText) {
		return invalidAt("rendered text does not match the frozen section", section.ID, 0, "")
	}
	return nil
}

func sourceImageIDs(markdownSource string) ([]string, error) {
	var rendered bytes.Buffer
	if err := markdown.Convert([]byte(strings.ReplaceAll(markdownSource, "[markdownHTMLNode]", "")), &rendered); err != nil {
		return nil, err
	}
	contextNode := &xhtml.Node{Type: xhtml.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := xhtml.ParseFragment(bytes.NewReader(rendered.Bytes()), contextNode)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, node := range nodes {
		walk(node, func(n *xhtml.Node) {
			if n.Type != xhtml.ElementNode || n.Data != "img" {
				return
			}
			id, ok := routeAssetID(attr(n, "src"))
			if !ok {
				out = append(out, "")
				return
			}
			out = append(out, id)
		})
	}
	return out, nil
}

func imageReference(img *xhtml.Node, stable bool, assets map[string]Asset) (string, []byte, error) {
	src := attr(img, "src")
	declaredID := strings.ToLower(attr(img, "data-asset"))
	if stable {
		if declaredID == "" {
			return "", nil, invalid("stable HTML image must retain its asset identity")
		}
		asset, ok := assets[declaredID]
		if !ok {
			return "", nil, imageMissing()
		}
		parts := strings.SplitN(src, ",", 2)
		if len(parts) != 2 || !strings.HasSuffix(strings.ToLower(parts[0]), ";base64") {
			return "", nil, invalid("stable HTML images must be base64 data URIs")
		}
		mime := strings.TrimPrefix(strings.ToLower(parts[0]), "data:")
		mime = strings.TrimSuffix(mime, ";base64")
		if mime != asset.MIME || (mime != "image/jpeg" && mime != "image/png" && mime != "image/webp") {
			return "", nil, invalid("stable HTML image MIME does not match its frozen asset")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(parts[1])
		if err != nil || strings.ContainsAny(parts[1], "\r\n\t ") || base64.StdEncoding.EncodeToString(data) != parts[1] {
			return "", nil, invalid("stable HTML image data URI is malformed")
		}
		if !validAsset(asset) || int64(len(data)) != asset.Bytes || hashBytes(data) != asset.SHA256 {
			return "", nil, imageMissing()
		}
		return declaredID, data, nil
	}
	id, ok := routeAssetID(src)
	if !ok {
		return "", nil, &ValidationError{Code: "unmanaged_image", Message: "image source is not a local managed asset"}
	}
	if declaredID != "" && declaredID != id {
		return "", nil, invalid("image identity metadata does not match its managed asset route")
	}
	return id, nil, nil
}

func validateNodePolicy(root *xhtml.Node) error {
	if root.Type == xhtml.ElementNode {
		if !allowedTag(root.Data) {
			return invalid("HTML contains an unsupported element")
		}
		for _, attr := range root.Attr {
			key := strings.ToLower(attr.Key)
			switch key {
			case "style":
				if err := validateStyle(attr.Val); err != nil {
					return err
				}
			case "href":
				if root.Data != "a" || !safeNavigation(attr.Val) {
					return invalid("HTML contains an unsafe navigation link")
				}
			case "src":
				if root.Data != "img" {
					return invalid("HTML resource attribute is not allowed")
				}
			case "alt":
				if root.Data != "img" {
					return invalid("HTML image text attribute is misplaced")
				}
			case "data-asset":
				if root.Data != "img" {
					return invalid("HTML asset identity is misplaced")
				}
			case "data-section-id":
				if root.Data != "div" || !isSectionWrapper(root) || root.Parent == nil || root.Parent.Data != "section" {
					return invalid("HTML section identity is misplaced")
				}
			default:
				return invalid("HTML contains an unsupported attribute")
			}
		}
		if root.Data == "img" && attr(root, "src") == "" {
			return invalid("HTML image source is missing")
		}
	}
	for child := root.FirstChild; child != nil; child = child.NextSibling {
		if err := validateNodePolicy(child); err != nil {
			return err
		}
	}
	return nil
}

func validateDocumentEnvelope(doc, body *xhtml.Node) error {
	htmlNode := firstElement(doc, "html")
	head := firstElement(doc, "head")
	if htmlNode == nil || head == nil || body.Parent != htmlNode || head.Parent != htmlNode || len(htmlNode.Attr) != 0 || len(head.Attr) != 0 || len(body.Attr) != 0 {
		return invalid("HTML document envelope is malformed")
	}
	for child := head.FirstChild; child != nil; child = child.NextSibling {
		if child.Type == xhtml.TextNode && strings.TrimSpace(child.Data) == "" {
			continue
		}
		if child.Type != xhtml.ElementNode {
			return invalid("HTML head contains unsupported content")
		}
		switch child.Data {
		case "title":
			if len(child.Attr) != 0 || len(elements(child, "script")) != 0 {
				return invalid("HTML title is malformed")
			}
			for titleChild := child.FirstChild; titleChild != nil; titleChild = titleChild.NextSibling {
				if titleChild.Type != xhtml.TextNode {
					return invalid("HTML title may contain only text")
				}
			}
		case "meta":
			if len(child.Attr) != 1 || !strings.EqualFold(attr(child, "charset"), "utf-8") {
				return invalid("HTML head may contain only a UTF-8 charset declaration")
			}
		default:
			return invalid("HTML head may not load external or executable resources")
		}
	}
	return nil
}

func isSectionWrapper(node *xhtml.Node) bool { return attr(node, "data-section-id") != "" }

func validateStyle(value string) error {
	if cssUnsafe.MatchString(value) || strings.ContainsAny(value, "{}<>\x00") {
		return invalid("HTML CSS contains a resource or executable construct")
	}
	for _, declaration := range strings.Split(value, ";") {
		declaration = strings.TrimSpace(declaration)
		if declaration == "" {
			continue
		}
		parts := strings.SplitN(declaration, ":", 2)
		if len(parts) != 2 || !styleProperties[strings.ToLower(strings.TrimSpace(parts[0]))] || strings.TrimSpace(parts[1]) == "" {
			return invalid("HTML CSS contains an unsupported declaration")
		}
		value := strings.ToLower(strings.TrimSpace(parts[1]))
		if strings.Contains(value, "@") || strings.Contains(value, "javascript") || strings.Contains(value, "data:") || strings.Contains(value, "file:") || strings.Contains(value, "http:") || strings.Contains(value, "https:") {
			return invalid("HTML CSS contains a resource or executable value")
		}
	}
	return nil
}

func safeNavigation(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "javascript" || parsed.Scheme == "data" || parsed.Scheme == "file" || parsed.Scheme == "blob" {
		return false
	}
	if parsed.Scheme == "" {
		return !strings.HasPrefix(value, "//")
	}
	return parsed.Scheme == "http" || parsed.Scheme == "https"
}

func allowedTag(tag string) bool {
	switch tag {
	case "section", "div", "h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote", "ul", "ol", "li",
		"dl", "dt", "dd", "strong", "b", "em", "i", "a", "img", "br", "hr", "del", "s", "strike", "ins",
		"pre", "code", "kbd", "mark", "small", "sub", "sup", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
		"caption", "details", "summary", "figure", "figcaption":
		return true
	default:
		return false
	}
}

func validAsset(asset Asset) bool {
	if asset.ID == "" || len(asset.Data) == 0 || int64(len(asset.Data)) != asset.Bytes || hashBytes(asset.Data) != asset.SHA256 || asset.Width < 1 || asset.Height < 1 {
		return false
	}
	return asset.MIME == "image/jpeg" || asset.MIME == "image/png" || asset.MIME == "image/webp"
}

func routeAssetID(source string) (string, bool) {
	match := assetRoute.FindStringSubmatch(source)
	if len(match) != 2 {
		return "", false
	}
	return strings.ToLower(match[1]), true
}

func hashBytes(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func firstElement(node *xhtml.Node, name string) *xhtml.Node {
	var found *xhtml.Node
	walk(node, func(current *xhtml.Node) {
		if found == nil && current.Type == xhtml.ElementNode && current.Data == name {
			found = current
		}
	})
	return found
}

func onlyElementChild(node *xhtml.Node) (*xhtml.Node, error) {
	var element *xhtml.Node
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if isBlankText(child) {
			continue
		}
		if child.Type != xhtml.ElementNode || element != nil {
			return nil, fmt.Errorf("expected one element child")
		}
		element = child
	}
	if element == nil {
		return nil, fmt.Errorf("missing element child")
	}
	return element, nil
}

func elements(node *xhtml.Node, name string) []*xhtml.Node {
	out := []*xhtml.Node{}
	walk(node, func(current *xhtml.Node) {
		if current.Type == xhtml.ElementNode && current.Data == name {
			out = append(out, current)
		}
	})
	return out
}

func walk(node *xhtml.Node, visit func(*xhtml.Node)) {
	visit(node)
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		walk(child, visit)
	}
}

func attr(node *xhtml.Node, key string) string {
	for _, item := range node.Attr {
		if strings.EqualFold(item.Key, key) {
			return item.Val
		}
	}
	return ""
}

func isBlankText(node *xhtml.Node) bool {
	return node.Type == xhtml.TextNode && strings.TrimSpace(node.Data) == ""
}

func textContent(nodes []*xhtml.Node) string {
	var out strings.Builder
	var visit func(*xhtml.Node)
	visit = func(node *xhtml.Node) {
		if node.Type == xhtml.ElementNode && node.Data == "input" && strings.EqualFold(attr(node, "type"), "checkbox") {
			if hasAttr(node, "checked") {
				out.WriteString("☑")
			} else {
				out.WriteString("☐")
			}
			return
		}
		if node.Type == xhtml.TextNode {
			out.WriteString(node.Data)
			out.WriteByte(' ')
			return
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	for _, node := range nodes {
		visit(node)
	}
	return out.String()
}

func normalizeText(value string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(value, "\u00a0", " ")), " ")
}

func hasAttr(node *xhtml.Node, key string) bool {
	for _, item := range node.Attr {
		if strings.EqualFold(item.Key, key) {
			return true
		}
	}
	return false
}

func invalid(message string) error { return &ValidationError{Code: "html_invalid", Message: message} }
func invalidAt(message, sectionID string, occurrence int, assetID string) error {
	return &ValidationError{Code: "html_invalid", Message: message, SectionID: sectionID, Occurrence: occurrence, AssetID: assetID}
}
func imageMissing() error {
	return &ValidationError{Code: "image_missing", Message: "a referenced frozen asset is unavailable or changed"}
}
