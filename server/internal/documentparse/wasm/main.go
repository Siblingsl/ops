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
	for _, file := range archive.File {
		name := strings.ToLower(path.Clean(file.Name))
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
		}
		if name == "[content_types].xml" {
			content, err := readZipFile(file, 2<<20)
			if err != nil || bytes.Contains(bytes.ToLower(content), []byte("macroenabled")) {
				return result{}, invalid("docx_macro_unsupported")
			}
		}
	}
	if document == nil {
		return result{}, invalid("docx_invalid")
	}
	if declaredPages < 1 {
		return result{}, invalid("docx_page_count_unverifiable")
	}
	if declaredPages > maxDocumentPages {
		return result{}, invalid("document_page_limit")
	}
	content, err := readZipFile(document, 32<<20)
	if err != nil || !utf8.Valid(content) {
		return result{}, invalid("docx_encoding_invalid")
	}
	e := &extractor{}
	decoder := xml.NewDecoder(bytes.NewReader(content))
	pageBreaks := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return result{}, invalid("docx_invalid")
		}
		if item, ok := token.(xml.StartElement); ok {
			switch item.Name.Local {
			case "t":
				var text string
				if err := decoder.DecodeElement(&text, &item); err != nil {
					return result{}, invalid("docx_invalid")
				}
				e.add(text)
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

func savedDOCXPages(data []byte) int {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, err := decoder.Token()
		if err != nil {
			return 0
		}
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == "Pages" {
			var value string
			if decoder.DecodeElement(&value, &start) != nil {
				return 0
			}
			pages, _ := strconv.Atoi(strings.TrimSpace(value))
			return pages
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
				if attr.Name.Local == "TargetMode" && strings.EqualFold(attr.Value, "External") {
					return true, nil
				}
			}
		}
	}
}
