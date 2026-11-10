//go:build wasip1

package main

// DEV-A21：32MiB 主文档的字节级扫描器，替代 encoding/xml 的全量 tokenize。
//
// 语义与原来的 parseDOCXMainDocument 逐条对齐：
//   - 根节点必须是 wordprocessingml 命名空间的 document，body 只能有一个；
//   - w:t 内的文本计入正文，w:tab→"\t"、w:br/w:cr→"\n"（type=page 计分页）、
//     w:lastRenderedPageBreak 计分页、w:p→"\n"；
//   - 分页数达到 maxDocumentPages、文档为空、声明页数与页内分页不符均按原错误码拒绝。
//
// 差异只在实现：文本以子切片直接喂给 extractor（不再复制成 CharData），
// 实体只在片段出现 '&' 时才解码，w:t 之外的文本完全跳过。

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

type nsDecl struct {
	prefix string
	uri    string
}

type rawAttr struct {
	name  []byte
	value []byte
}

type docxScan struct {
	data       []byte
	pos        int
	e          *extractor
	pageBreaks int
	names      [][]byte   // 元素栈（原始限定名），len 即当前深度
	scopes     [][]nsDecl // 与 names 对齐的命名空间声明栈
	documentNS string
	rootSeen   bool
	bodyCount  int
	textDepth  int
}

// readDocumentEntry 按声明大小一次性分配后读取主文档（A21）：
// io.ReadAll 的倍增扩容在 32MiB 上会多占一份临时缓冲，这里改成精确预分配，
// 并在读满后确认已到 EOF（同时触发 zip 的 CRC 校验）。
func readDocumentEntry(file *zip.File, maxBytes int64) ([]byte, error) {
	if file.UncompressedSize64 == 0 || file.UncompressedSize64 > uint64(maxBytes) {
		return nil, errors.New("zip entry outside size cap")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	content := make([]byte, int(file.UncompressedSize64))
	if _, err := io.ReadFull(reader, content); err != nil {
		return nil, errors.New("zip entry is corrupt")
	}
	var tail [1]byte
	if read, err := reader.Read(tail[:]); read != 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return nil, errors.New("zip entry exceeds declared size")
	}
	return content, nil
}

func parseDOCXMainDocumentBytes(content []byte, declaredPages int) (result, error) {
	if !utf8.Valid(content) {
		return result{}, invalid("docx_encoding_invalid")
	}
	scan := &docxScan{data: content, e: &extractor{}}
	if err := scan.run(); err != nil {
		return result{}, err
	}
	if !scan.rootSeen || scan.bodyCount != 1 || len(scan.names) != 0 {
		return result{}, invalid("docx_invalid")
	}
	if strings.TrimSpace(scan.e.text.String()) == "" {
		return result{}, invalid("docx_empty")
	}
	if declaredPages != 1+scan.pageBreaks {
		return result{}, invalid("docx_page_count_unverifiable")
	}
	out := scan.e.result()
	out.Pages = &declaredPages
	out.PageBasis = "docx_saved_pagination"
	return out, nil
}

func (s *docxScan) run() error {
	for s.pos < len(s.data) {
		if s.data[s.pos] != '<' {
			start := s.pos
			for s.pos < len(s.data) && s.data[s.pos] != '<' {
				s.pos++
			}
			s.text(s.data[start:s.pos])
			continue
		}
		if s.pos+1 >= len(s.data) {
			return invalid("docx_invalid")
		}
		switch s.data[s.pos+1] {
		case '/':
			if err := s.endTag(); err != nil {
				return err
			}
		case '!':
			if err := s.bangMarkup(); err != nil {
				return err
			}
		case '?':
			end := bytes.Index(s.data[s.pos+2:], []byte("?>"))
			if end < 0 {
				return invalid("docx_invalid")
			}
			s.pos += 2 + end + 2
		case '>', '<':
			return invalid("docx_invalid")
		default:
			if err := s.startTag(); err != nil {
				return err
			}
		}
		if s.pageBreaks >= maxDocumentPages {
			return invalid("document_page_limit")
		}
	}
	return nil
}

// bangMarkup 处理 <!--注释-->、<![CDATA[...]]> 与 <!DOCTYPE ...>。
func (s *docxScan) bangMarkup() error {
	rest := s.data[s.pos:]
	switch {
	case bytes.HasPrefix(rest, []byte("<!--")):
		end := bytes.Index(rest[4:], []byte("-->"))
		if end < 0 {
			return invalid("docx_invalid")
		}
		s.pos += 4 + end + 3
	case bytes.HasPrefix(rest, []byte("<![CDATA[")):
		end := bytes.Index(rest[9:], []byte("]]>"))
		if end < 0 {
			return invalid("docx_invalid")
		}
		s.cdataText(rest[9 : 9+end])
		s.pos += 9 + end + 3
	default:
		end := bytes.IndexByte(rest, '>')
		if end < 0 {
			return invalid("docx_invalid")
		}
		s.pos += end + 1
	}
	return nil
}

// tagEnd 返回标签结束 '>' 的下标，跳过引号内的内容（属性值里可能有 '>'）。
func (s *docxScan) tagEnd(from int) (int, bool) {
	var quote byte
	for index := from; index < len(s.data); index++ {
		value := s.data[index]
		if quote != 0 {
			if value == quote {
				quote = 0
			}
			continue
		}
		switch value {
		case '"', '\'':
			quote = value
		case '>':
			return index, true
		}
	}
	return 0, false
}

func (s *docxScan) startTag() error {
	end, ok := s.tagEnd(s.pos + 1)
	if !ok {
		return invalid("docx_invalid")
	}
	body := s.data[s.pos+1 : end]
	s.pos = end + 1
	selfClosing := false
	for len(body) > 0 {
		last := body[len(body)-1]
		if last == '/' {
			selfClosing = true
		}
		if !isXMLSpace(last) && last != '/' {
			break
		}
		body = body[:len(body)-1]
	}
	name, attrs, err := splitTag(body)
	if err != nil {
		return invalid("docx_invalid")
	}
	decls := make([]nsDecl, 0, 2)
	for _, attr := range attrs {
		switch {
		case bytes.Equal(attr.name, []byte("xmlns")):
			decls = append(decls, nsDecl{uri: string(attr.value)})
		case bytes.HasPrefix(attr.name, []byte("xmlns:")):
			decls = append(decls, nsDecl{prefix: string(attr.name[6:]), uri: string(attr.value)})
		}
	}
	s.scopes = append(s.scopes, decls)
	prefix, local := splitName(name)
	namespace := s.resolveNamespace(string(prefix))
	depth := len(s.names)

	if s.textDepth != 0 {
		// 与 encoding/xml 版本一致：w:t 内部的嵌套元素不参与语义，只加深一层。
	} else {
		if depth == 0 {
			if string(local) != "document" || (namespace != wordprocessingMainNamespace && namespace != strictWordprocessingMainNS) {
				return invalid("docx_invalid")
			}
			s.rootSeen = true
			s.documentNS = namespace
		} else if depth == 1 && string(local) == "body" && namespace == s.documentNS {
			s.bodyCount++
			if s.bodyCount > 1 {
				return invalid("docx_invalid")
			}
		}
		if namespace == s.documentNS {
			switch string(local) {
			case "t":
				if !selfClosing {
					s.textDepth = depth + 1
				}
			case "tab":
				s.e.add("\t")
			case "br", "cr":
				s.e.add("\n")
				for _, attr := range attrs {
					_, attrLocal := splitName(attr.name)
					if string(attrLocal) == "type" && string(attr.value) == "page" {
						s.pageBreaks++
					}
				}
			case "lastRenderedPageBreak":
				s.pageBreaks++
			case "p":
				s.e.add("\n")
			}
		}
	}
	if selfClosing {
		s.scopes = s.scopes[:len(s.scopes)-1]
		return nil
	}
	s.names = append(s.names, name)
	return nil
}

func (s *docxScan) endTag() error {
	end, ok := s.tagEnd(s.pos + 2)
	if !ok {
		return invalid("docx_invalid")
	}
	name := bytes.TrimSpace(s.data[s.pos+2 : end])
	s.pos = end + 1
	if len(s.names) == 0 {
		return invalid("docx_invalid")
	}
	depth := len(s.names)
	if !bytes.Equal(s.names[depth-1], name) {
		return invalid("docx_invalid")
	}
	if s.textDepth == depth {
		s.textDepth = 0
	}
	s.names = s.names[:depth-1]
	s.scopes = s.scopes[:depth-1]
	return nil
}

func (s *docxScan) text(raw []byte) {
	if s.textDepth == 0 || len(s.names) != s.textDepth || len(raw) == 0 {
		return
	}
	if bytes.IndexByte(raw, '&') < 0 {
		s.e.addXMLText(raw)
		return
	}
	s.e.addXMLText(decodeEntities(raw))
}

func (s *docxScan) cdataText(raw []byte) {
	if s.textDepth == 0 || len(s.names) != s.textDepth || len(raw) == 0 {
		return
	}
	s.e.addXMLText(raw)
}

func (s *docxScan) resolveNamespace(prefix string) string {
	for index := len(s.scopes) - 1; index >= 0; index-- {
		for _, decl := range s.scopes[index] {
			if decl.prefix == prefix {
				return decl.uri
			}
		}
	}
	return ""
}

func splitName(name []byte) ([]byte, []byte) {
	if colon := bytes.IndexByte(name, ':'); colon >= 0 {
		return name[:colon], name[colon+1:]
	}
	return nil, name
}

func splitTag(body []byte) ([]byte, []rawAttr, error) {
	index := 0
	for index < len(body) && !isXMLSpace(body[index]) {
		index++
	}
	name := body[:index]
	if len(name) == 0 {
		return nil, nil, errors.New("empty element name")
	}
	attrs := make([]rawAttr, 0, 4)
	for index < len(body) {
		for index < len(body) && isXMLSpace(body[index]) {
			index++
		}
		if index >= len(body) {
			break
		}
		start := index
		for index < len(body) && body[index] != '=' && !isXMLSpace(body[index]) {
			index++
		}
		key := body[start:index]
		for index < len(body) && isXMLSpace(body[index]) {
			index++
		}
		if index >= len(body) || body[index] != '=' {
			return nil, nil, errors.New("attribute without value")
		}
		index++
		for index < len(body) && isXMLSpace(body[index]) {
			index++
		}
		if index >= len(body) || (body[index] != '"' && body[index] != '\'') {
			return nil, nil, errors.New("unquoted attribute value")
		}
		quote := body[index]
		index++
		valueStart := index
		for index < len(body) && body[index] != quote {
			index++
		}
		if index >= len(body) {
			return nil, nil, errors.New("unterminated attribute value")
		}
		value := body[valueStart:index]
		index++
		if bytes.IndexByte(value, '&') >= 0 {
			value = decodeEntities(value)
		}
		attrs = append(attrs, rawAttr{name: key, value: value})
	}
	return name, attrs, nil
}

func isXMLSpace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}

// decodeEntities 解码 XML 预定义实体与数字引用。未知实体保持原样：
// 正文是数据而非指令，保留字面量比中断整篇解析更安全。
func decodeEntities(raw []byte) []byte {
	if bytes.IndexByte(raw, '&') < 0 {
		return raw
	}
	out := make([]byte, 0, len(raw))
	for index := 0; index < len(raw); {
		if raw[index] != '&' {
			out = append(out, raw[index])
			index++
			continue
		}
		semi := bytes.IndexByte(raw[index:], ';')
		if semi < 0 || semi > 12 {
			out = append(out, raw[index])
			index++
			continue
		}
		entity := raw[index+1 : index+semi]
		switch string(entity) {
		case "lt":
			out = append(out, '<')
		case "gt":
			out = append(out, '>')
		case "amp":
			out = append(out, '&')
		case "quot":
			out = append(out, '"')
		case "apos":
			out = append(out, '\'')
		default:
			if runeValue, ok := decodeNumericEntity(entity); ok {
				out = utf8.AppendRune(out, runeValue)
			} else {
				out = append(out, raw[index:index+semi+1]...)
			}
		}
		index += semi + 1
	}
	return out
}

func decodeNumericEntity(entity []byte) (rune, bool) {
	if len(entity) < 2 || entity[0] != '#' {
		return 0, false
	}
	digits := entity[1:]
	base := 10
	if digits[0] == 'x' || digits[0] == 'X' {
		digits = digits[1:]
		base = 16
	}
	if len(digits) == 0 || len(digits) > 8 {
		return 0, false
	}
	value := rune(0)
	for _, digit := range digits {
		var number rune
		switch {
		case digit >= '0' && digit <= '9':
			number = rune(digit - '0')
		case base == 16 && digit >= 'a' && digit <= 'f':
			number = rune(digit-'a') + 10
		case base == 16 && digit >= 'A' && digit <= 'F':
			number = rune(digit-'A') + 10
		default:
			return 0, false
		}
		value = value*rune(base) + number
	}
	if value == 0 || value > utf8.MaxRune || (value >= 0xD800 && value <= 0xDFFF) {
		return 0, false
	}
	return value, true
}
