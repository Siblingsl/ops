//go:build wasip1

package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"

	pdf "github.com/giraffesyo/pdf"
)

const (
	maxDocumentBytes = 20 << 20
	maxDocumentChars = 20000
	maxDocumentPages = 100
	maxCSVRows       = 10000
	maxCSVColumns    = 100
	maxZipExpanded   = 96 << 20

	opcContentTypesNamespace       = "http://schemas.openxmlformats.org/package/2006/content-types"
	opcRelationshipsNamespace      = "http://schemas.openxmlformats.org/package/2006/relationships"
	extendedPropertiesNamespace    = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
	wordprocessingMainNamespace    = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
	strictWordprocessingMainNS     = "http://purl.oclc.org/ooxml/wordprocessingml/main"
	wordDocumentContentType        = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
	wordDocumentRelationship       = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
	strictWordDocumentRelationship = "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument"
)

type request struct {
	Name string `json:"name"`
	Data []byte `json:"data"`
}

type result struct {
	ParserVersion  string `json:"parser_version,omitempty"`
	Text           string `json:"text"`
	Pages          *int   `json:"pages,omitempty"`
	PageBasis      string `json:"page_basis,omitempty"`
	Rows           *int   `json:"rows,omitempty"`
	ExtractedChars int    `json:"extracted_chars"`
	InjectedChars  int    `json:"injected_chars"`
	TruncatedFrom  *int   `json:"truncated_from,omitempty"`
	TruncatedTo    *int   `json:"truncated_to,omitempty"`
	ErrorCode      string `json:"error,omitempty"`
}

type extractor struct {
	text    strings.Builder
	chars   int
	written int
}

func (e *extractor) add(value string) {
	for _, r := range value {
		e.chars++
		if e.written < maxDocumentChars {
			e.text.WriteRune(r)
			e.written++
		}
	}
}

func (e *extractor) addXMLText(value []byte) {
	ascii := 0
	for ascii < len(value) && value[ascii] < utf8.RuneSelf {
		ascii++
	}
	e.chars += ascii
	if remaining := maxDocumentChars - e.written; remaining > 0 {
		written := min(ascii, remaining)
		_, _ = e.text.Write(value[:written])
		e.written += written
	}
	value = value[ascii:]
	for len(value) > 0 {
		_, size := utf8.DecodeRune(value)
		e.chars++
		if e.written < maxDocumentChars {
			_, _ = e.text.Write(value[:size])
			e.written++
		}
		value = value[size:]
	}
}

func (e *extractor) result() result {
	out := result{Text: e.text.String(), ExtractedChars: e.chars, InjectedChars: min(e.chars, maxDocumentChars)}
	if e.chars > maxDocumentChars {
		from, to := maxDocumentChars+1, e.chars
		out.TruncatedFrom, out.TruncatedTo = &from, &to
	}
	return out
}

func main() {
	var input request
	if err := json.NewDecoder(io.LimitReader(os.Stdin, maxDocumentBytes*2)).Decode(&input); err != nil {
		writeError("invalid_document")
		return
	}
	out, err := parse(input.Name, input.Data)
	if err != nil {
		code := "invalid_document"
		if value, ok := err.(codedError); ok {
			code = value.code
		}
		writeError(code)
		return
	}
	out.ParserVersion = "ops-document-v1/pdf0.7.0"
	_ = json.NewEncoder(os.Stdout).Encode(out)
}

type codedError struct{ code string }

func (e codedError) Error() string { return e.code }
func invalid(code string) error    { return codedError{code: code} }

func writeError(code string) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": code})
}

func parse(name string, data []byte) (result, error) {
	if len(data) == 0 || len(data) > maxDocumentBytes {
		return result{}, invalid("document_size_invalid")
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".pdf":
		return parsePDF(data)
	case ".docx":
		return parseDOCX(data)
	case ".csv":
		return parseCSV(data)
	default:
		return result{}, invalid("document_type_unsupported")
	}
}

func parsePDF(data []byte) (result, error) {
	if pdfHasName(data, "Encrypt") {
		return result{}, invalid("pdf_encrypted")
	}
	doc, err := pdf.ExtractWithOptions(context.Background(), bytes.NewReader(data), int64(len(data)), pdf.Options{
		Pages: []pdf.PageRange{{First: 1, Last: maxDocumentPages + 1}}, Strict: true, Concurrency: 1,
	})
	if err != nil {
		if errors.Is(err, pdf.ErrPasswordRequired) {
			return result{}, invalid("pdf_encrypted")
		}
		return result{}, invalid("pdf_invalid_or_encrypted")
	}
	pages := doc.PageCount
	if pages < 1 || pages > maxDocumentPages {
		return result{}, invalid("document_page_limit")
	}
	e := &extractor{}
	hasImages := false
	for _, page := range doc.Pages {
		e.add(page.Text())
		hasImages = hasImages || page.ImageCount > 0
	}
	if strings.TrimSpace(e.text.String()) == "" {
		if hasImages {
			return result{}, invalid("pdf_scanned_unsupported")
		}
		return result{}, invalid("pdf_no_text_layer")
	}
	out := e.result()
	out.Pages = &pages
	out.PageBasis = "pdf"
	return out, nil
}

// The encryption dictionary reference is a clear-text PDF name in its trailer/xref.
// Decode hexadecimal name escapes too; conservatively reject this name anywhere.
func pdfHasName(data []byte, wanted string) bool {
	for i := 0; i < len(data); i++ {
		if data[i] != '/' {
			continue
		}
		var name strings.Builder
		for j := i + 1; j < len(data) && !strings.ContainsRune(" \t\r\n\x00\f()<>[]{}/%", rune(data[j])); j++ {
			if data[j] == '#' && j+2 < len(data) {
				if value, err := strconv.ParseUint(string(data[j+1:j+3]), 16, 8); err == nil {
					name.WriteByte(byte(value))
					j += 2
					continue
				}
			}
			if name.Len() < 64 {
				name.WriteByte(data[j])
			}
		}
		if name.String() == wanted {
			return true
		}
	}
	return false
}

func parseCSV(data []byte) (result, error) {
	if !utf8.Valid(data) {
		return result{}, invalid("csv_utf8_required")
	}
	reader := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})))
	reader.FieldsPerRecord = -1
	reader.ReuseRecord = true
	e := &extractor{}
	rows, columns := 0, 0
	for {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return result{}, invalid("csv_invalid")
		}
		rows++
		if rows > maxCSVRows || len(record) > maxCSVColumns {
			return result{}, invalid("csv_limit_exceeded")
		}
		columns = max(columns, len(record))
		var encoded bytes.Buffer
		writer := csv.NewWriter(&encoded)
		if err := writer.Write(record); err != nil {
			return result{}, invalid("csv_invalid")
		}
		writer.Flush()
		if writer.Error() != nil {
			return result{}, invalid("csv_invalid")
		}
		e.add(encoded.String())
	}
	if rows == 0 || columns == 0 {
		return result{}, invalid("csv_empty")
	}
	out := e.result()
	out.Rows = &rows
	return out, nil
}

func parseDOCX(data []byte) (result, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(archive.File) > 256 {
		return result{}, invalid("docx_invalid")
	}
	total := uint64(0)
	var document *zip.File
	declaredPages := 0
	hasMainDocumentContentType := false
	hasMainDocumentRelationship := false
	partNames := make(map[string]struct{}, len(archive.File))
	for _, file := range archive.File {
		if file.FileInfo().IsDir() {
			continue
		}
		partPath := path.Clean(file.Name)
		if partPath != file.Name {
			return result{}, invalid("docx_invalid")
		}
		name := strings.ToLower(partPath)
		partName := asciiLower(partPath)
		if _, exists := partNames[partName]; exists {
			return result{}, invalid("docx_invalid")
		}
		partNames[partName] = struct{}{}
		if file.Flags&1 != 0 {
			return result{}, invalid("docx_encrypted")
		}
		if strings.Contains(name, "word/embeddings/") || strings.Contains(name, "word/activex/") ||
			strings.Contains(name, "vbaproject") || strings.HasSuffix(name, ".bin") || strings.Contains(name, "afchunk") {
			return result{}, invalid("docx_embedded_content_unsupported")
		}
		total += file.UncompressedSize64
		if total > maxZipExpanded {
			return result{}, invalid("docx_expanded_size_limit")
		}
		if name == "word/document.xml" {
			document = file
		}
		if name == "docprops/app.xml" {
			content, err := readZipFile(file, 2<<20)
			if err != nil {
				return result{}, invalid("docx_page_count_unverifiable")
			}
			declaredPages = savedDOCXPages(content)
		}
		if strings.HasSuffix(name, ".rels") {
			content, err := readZipFile(file, 2<<20)
			if err != nil {
				return result{}, invalid("docx_invalid")
			}
			external, err := hasExternalRelationship(content)
			if err != nil || external {
				return result{}, invalid("docx_external_link_unsupported")
			}
			if name == "_rels/.rels" {
				hasMainDocumentRelationship, err = hasPackageMainDocumentRelationship(content)
				if err != nil {
					return result{}, invalid("docx_invalid")
				}
			}
		}
		if name == "[content_types].xml" {
			content, err := readZipFile(file, 2<<20)
			if err != nil || bytes.Contains(bytes.ToLower(content), []byte("macroenabled")) {
				return result{}, invalid("docx_macro_unsupported")
			}
			hasMainDocumentContentType, err = hasWordDocumentContentType(content)
			if err != nil {
				return result{}, invalid("docx_invalid")
			}
		}
	}
	if document == nil || !hasMainDocumentContentType || !hasMainDocumentRelationship {
		return result{}, invalid("docx_invalid")
	}
	if declaredPages < 1 {
		return result{}, invalid("docx_page_count_unverifiable")
	}
	if declaredPages > maxDocumentPages {
		return result{}, invalid("document_page_limit")
	}
	if document.UncompressedSize64 > 32<<20 {
		return result{}, invalid("docx_encoding_invalid")
	}
	documentReader, err := document.Open()
	if err != nil {
		return result{}, invalid("docx_encoding_invalid")
	}
	defer documentReader.Close()
	validatingReader := &utf8LimitReader{reader: documentReader, maxBytes: 32 << 20}
	out, parseErr := parseDOCXMainDocument(validatingReader, declaredPages)
	if err := validatingReader.finish(); err != nil {
		return result{}, invalid("docx_encoding_invalid")
	}
	if parseErr != nil {
		return result{}, parseErr
	}
	return out, nil
}

func parseDOCXMainDocument(reader io.Reader, declaredPages int) (result, error) {
	e := &extractor{}
	decoder := xml.NewDecoder(reader)
	pageBreaks := 0
	depth := 0
	rootSeen := false
	documentNamespace := ""
	bodyCount := 0
	textDepth := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			if !rootSeen || bodyCount != 1 {
				return result{}, invalid("docx_invalid")
			}
			break
		}
		if err != nil {
			return result{}, invalid("docx_invalid")
		}
		switch item := token.(type) {
		case xml.StartElement:
			if textDepth != 0 {
				depth++
				continue
			}
			if depth == 0 {
				if item.Name.Local != "document" || (item.Name.Space != wordprocessingMainNamespace && item.Name.Space != strictWordprocessingMainNS) {
					return result{}, invalid("docx_invalid")
				}
				rootSeen = true
				documentNamespace = item.Name.Space
			} else if depth == 1 && item.Name.Local == "body" && item.Name.Space == documentNamespace {
				bodyCount++
				if bodyCount > 1 {
					return result{}, invalid("docx_invalid")
				}
			}
			if item.Name.Space == documentNamespace {
				switch item.Name.Local {
				case "t":
					textDepth = depth + 1
				case "tab":
					e.add("\t")
				case "br", "cr":
					e.add("\n")
					for _, attr := range item.Attr {
						if attr.Name.Local == "type" && attr.Value == "page" {
							pageBreaks++
						}
					}
				case "lastRenderedPageBreak":
					pageBreaks++
				case "p":
					e.add("\n")
				}
			}
			depth++
		case xml.CharData:
			if textDepth != 0 && depth == textDepth {
				e.addXMLText([]byte(item))
			}
		case xml.EndElement:
			if textDepth != 0 {
				if textDepth == depth {
					textDepth = 0
				}
				depth--
				continue
			}
			depth--
		}
		if pageBreaks >= maxDocumentPages {
			return result{}, invalid("document_page_limit")
		}
	}
	if strings.TrimSpace(e.text.String()) == "" {
		return result{}, invalid("docx_empty")
	}
	if declaredPages != 1+pageBreaks {
		return result{}, invalid("docx_page_count_unverifiable")
	}
	out := e.result()
	out.Pages = &declaredPages
	out.PageBasis = "docx_saved_pagination"
	return out, nil
}

func hasWordDocumentContentType(data []byte) (bool, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	depth := 0
	rootSeen := false
	defaultXMLContentType := ""
	hasDefaultXMLContentType := false
	overrideContentType := ""
	hasOverrideContentType := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			contentType := defaultXMLContentType
			hasContentType := hasDefaultXMLContentType
			if hasOverrideContentType {
				contentType = overrideContentType
				hasContentType = true
			}
			return rootSeen && hasContentType && strings.EqualFold(contentType, wordDocumentContentType), nil
		}
		if err != nil {
			return false, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			if depth == 0 {
				if item.Name.Local != "Types" || item.Name.Space != opcContentTypesNamespace {
					return false, errors.New("invalid OPC content types root")
				}
				rootSeen = true
			} else if depth == 1 && item.Name.Space == opcContentTypesNamespace && (item.Name.Local == "Default" || item.Name.Local == "Override") {
				extension, partName, contentType := "", "", ""
				for _, attr := range item.Attr {
					if attr.Name.Space != "" {
						continue
					}
					switch attr.Name.Local {
					case "Extension":
						extension = attr.Value
					case "PartName":
						partName = attr.Value
					case "ContentType":
						contentType = attr.Value
					}
				}
				if item.Name.Local == "Default" && strings.EqualFold(extension, "xml") {
					if hasDefaultXMLContentType {
						return false, errors.New("duplicate OPC XML default content type")
					}
					hasDefaultXMLContentType = true
					defaultXMLContentType = contentType
				} else if item.Name.Local == "Override" && strings.EqualFold(strings.TrimPrefix(partName, "/"), "word/document.xml") {
					if hasOverrideContentType {
						return false, errors.New("duplicate OPC main document content type override")
					}
					hasOverrideContentType = true
					overrideContentType = contentType
				}
			}
			depth++
		case xml.EndElement:
			depth--
		}
	}
}

func hasPackageMainDocumentRelationship(data []byte) (bool, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	depth := 0
	rootSeen := false
	matchingRelationships := 0
	relationshipIDs := make(map[string]struct{})
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return rootSeen && matchingRelationships == 1, nil
		}
		if err != nil {
			return false, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			if depth == 0 {
				if item.Name.Local != "Relationships" || item.Name.Space != opcRelationshipsNamespace {
					return false, errors.New("invalid OPC package relationships root")
				}
				rootSeen = true
			} else if depth == 1 && item.Name.Space == opcRelationshipsNamespace && item.Name.Local == "Relationship" {
				relationshipID, relationshipType, target, targetMode := "", "", "", ""
				for _, attr := range item.Attr {
					if attr.Name.Space != "" {
						continue
					}
					switch attr.Name.Local {
					case "Id":
						relationshipID = attr.Value
					case "Type":
						relationshipType = attr.Value
					case "Target":
						target = attr.Value
					case "TargetMode":
						targetMode = attr.Value
					}
				}
				if relationshipID == "" {
					return false, errors.New("OPC relationship is missing Id")
				}
				if _, exists := relationshipIDs[relationshipID]; exists {
					return false, errors.New("duplicate OPC relationship Id")
				}
				relationshipIDs[relationshipID] = struct{}{}
				if (relationshipType == wordDocumentRelationship || relationshipType == strictWordDocumentRelationship) &&
					(targetMode == "" || strings.EqualFold(targetMode, "Internal")) &&
					strings.EqualFold(strings.TrimPrefix(target, "/"), "word/document.xml") {
					matchingRelationships++
				}
			}
			depth++
		case xml.EndElement:
			depth--
		}
	}
}

func asciiLower(value string) string {
	bytes := []byte(value)
	for index, current := range bytes {
		if current >= 'A' && current <= 'Z' {
			bytes[index] = current + ('a' - 'A')
		}
	}
	return string(bytes)
}

func savedDOCXPages(data []byte) int {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	depth := 0
	rootSeen := false
	pagesCount := 0
	collectingPages := false
	var pagesText strings.Builder
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			if !rootSeen || depth != 0 || pagesCount != 1 || collectingPages {
				return 0
			}
			pages, _ := strconv.Atoi(strings.TrimSpace(pagesText.String()))
			return pages
		}
		if err != nil {
			return 0
		}
		switch item := token.(type) {
		case xml.StartElement:
			if depth == 0 {
				if rootSeen || item.Name.Local != "Properties" || item.Name.Space != extendedPropertiesNamespace {
					return 0
				}
				rootSeen = true
			} else if depth == 1 && item.Name.Local == "Pages" && item.Name.Space == extendedPropertiesNamespace {
				if pagesCount != 0 {
					return 0
				}
				pagesCount++
				collectingPages = true
			} else if collectingPages && depth == 2 {
				return 0
			}
			depth++
		case xml.CharData:
			if collectingPages && depth == 2 {
				pagesText.Write([]byte(item))
			}
		case xml.EndElement:
			if collectingPages && depth == 2 && item.Name.Local == "Pages" && item.Name.Space == extendedPropertiesNamespace {
				collectingPages = false
			}
			depth--
		}
	}
}

func readZipFile(file *zip.File, maxBytes int64) ([]byte, error) {
	if file.UncompressedSize64 > uint64(maxBytes) {
		return nil, errors.New("zip entry exceeds size cap")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	content, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil || int64(len(content)) > maxBytes {
		return nil, errors.New("zip entry exceeds size cap or is corrupt")
	}
	return content, nil
}

var errUTF8LimitExceeded = errors.New("zip entry exceeds size cap")

type utf8LimitReader struct {
	reader      io.Reader
	maxBytes    int64
	total       int64
	pending     [utf8.UTFMax]byte
	pendingSize int
	invalidUTF8 bool
	tooLarge    bool
	readErr     error
}

func (r *utf8LimitReader) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	if r.readErr != nil {
		return 0, r.readErr
	}
	remaining := r.maxBytes + 1 - r.total
	if remaining <= 0 {
		r.tooLarge = true
		return 0, errUTF8LimitExceeded
	}
	if int64(len(buffer)) > remaining {
		buffer = buffer[:int(remaining)]
	}
	read, err := r.reader.Read(buffer)
	if read > 0 {
		r.total += int64(read)
		r.validate(buffer[:read])
		if r.total > r.maxBytes {
			r.tooLarge = true
		}
	}
	if err != nil && !errors.Is(err, io.EOF) {
		r.readErr = err
	}
	return read, err
}

func (r *utf8LimitReader) validate(data []byte) {
	index := 0
	if r.pendingSize > 0 {
		var prefix [utf8.UTFMax]byte
		copy(prefix[:], r.pending[:r.pendingSize])
		take := min(len(data), utf8.UTFMax-r.pendingSize)
		copy(prefix[r.pendingSize:], data[:take])
		length := r.pendingSize + take
		if !utf8.FullRune(prefix[:length]) {
			r.pendingSize += copy(r.pending[r.pendingSize:], data[:take])
			return
		}
		_, size := utf8.DecodeRune(prefix[:length])
		if size == 1 && prefix[0] >= utf8.RuneSelf {
			r.invalidUTF8 = true
		}
		index = max(0, size-r.pendingSize)
		r.pendingSize = 0
	}
	for index < len(data) {
		if !utf8.FullRune(data[index:]) {
			r.pendingSize = copy(r.pending[:], data[index:])
			return
		}
		_, size := utf8.DecodeRune(data[index:])
		if size == 1 && data[index] >= utf8.RuneSelf {
			r.invalidUTF8 = true
		}
		index += size
	}
}

func (r *utf8LimitReader) finish() error {
	var buffer [32 << 10]byte
	for {
		_, err := r.Read(buffer[:])
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
	}
	if r.tooLarge {
		return errUTF8LimitExceeded
	}
	if r.pendingSize != 0 || r.invalidUTF8 {
		return errors.New("zip entry contains invalid UTF-8")
	}
	return r.readErr
}

func hasExternalRelationship(data []byte) (bool, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == "Relationship" {
			for _, attr := range start.Attr {
				if attr.Name.Space == "" && attr.Name.Local == "TargetMode" && strings.EqualFold(attr.Value, "External") {
					return true, nil
				}
			}
		}
	}
}
