package documentparse

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == workerArg {
		if err := RunWorker(); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestParseCSVReportsExtractedAndInjectedCharacters(t *testing.T) {
	text := "title,value\n" + strings.Repeat("x", 20010) + ",ok\n"
	result, err := Parse(context.Background(), "report.csv", []byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if result.Rows == nil || *result.Rows != 2 || result.ExtractedChars <= 20000 || result.InjectedChars != 20000 {
		t.Fatalf("unexpected parse receipt: %+v", result)
	}
	if result.TruncatedFrom == nil || *result.TruncatedFrom != 20001 || result.TruncatedTo == nil || *result.TruncatedTo != result.ExtractedChars {
		t.Fatalf("missing truncation range: %+v", result)
	}
	if len([]rune(result.Text)) != result.InjectedChars {
		t.Fatalf("actual text length does not match receipt: got %d, receipt %+v", len([]rune(result.Text)), result)
	}
}

func TestParseCSVRejectsEncodingAndShapeLimits(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		code string
	}{
		{name: "encoding", data: []byte{0xff, 0xfe}, code: "csv_utf8_required"},
		{name: "columns", data: []byte(strings.TrimSuffix(strings.Repeat("x,", 100), ",") + ",x"), code: "csv_limit_exceeded"},
		{name: "rows", data: []byte(strings.Repeat("x\n", 10001)), code: "csv_limit_exceeded"},
		{name: "malformed quoting", data: []byte("a,b\n\"unfinished"), code: "csv_invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := parseInWASI("input.csv", tc.data)
			if err == nil || result.ErrorCode != tc.code {
				t.Fatalf("want %s, got result %+v err %v", tc.code, result, err)
			}
		})
	}
}

func TestParseDOCXExtractsTextAndRejectsExternalLinksAndMacros(t *testing.T) {
	data := docxFixture(t, map[string]string{
		"word/document.xml": "<w:document xmlns:w=\"urn:w\"><w:body><w:p><w:r><w:t>运营笔记</w:t></w:r></w:p></w:body></w:document>",
		"docProps/app.xml":  "<Properties><Pages>1</Pages></Properties>",
	})
	parsed, err := parseInWASI("notes.docx", data)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Text == "" || !strings.Contains(parsed.Text, "运营笔记") || parsed.Pages == nil || *parsed.Pages != 1 || parsed.PageBasis != "docx_saved_pagination" {
		t.Fatalf("unexpected DOCX parse receipt: %+v", parsed)
	}

	external := docxFixture(t, map[string]string{
		"word/document.xml":            "<w:document xmlns:w=\"urn:w\"><w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>",
		"word/_rels/document.xml.rels": "<Relationships><Relationship TargetMode=\"External\" Target=\"https://example.invalid\"/></Relationships>",
	})
	got, err := parseInWASI("notes.docx", external)
	if err == nil || got.ErrorCode != "docx_external_link_unsupported" {
		t.Fatalf("external relationship was not rejected: %+v, %v", got, err)
	}

	macro := docxFixture(t, map[string]string{
		"word/document.xml":   "<w:document xmlns:w=\"urn:w\"><w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>",
		"[Content_Types].xml": "<Types><Default ContentType=\"application/vnd.ms-word.document.macroEnabled.main+xml\"/></Types>",
	})
	got, err = parseInWASI("notes.docx", macro)
	if err == nil || got.ErrorCode != "docx_macro_unsupported" {
		t.Fatalf("macro content was not rejected: %+v, %v", got, err)
	}
	missingPagination := docxFixture(t, map[string]string{
		"word/document.xml": "<w:document xmlns:w=\"urn:w\"><w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>",
	})
	got, err = parseInWASI("notes.docx", missingPagination)
	if err == nil || got.ErrorCode != "docx_page_count_unverifiable" {
		t.Fatalf("DOCX without saved pagination must require PDF conversion: %+v, %v", got, err)
	}
}

func TestParsePDFTextLayerAndScannedFile(t *testing.T) {
	result, err := Parse(context.Background(), "brief.pdf", pdfFixture(t, true))
	if err != nil {
		t.Fatal(err)
	}
	if result.Pages == nil || *result.Pages != 1 || result.PageBasis != "pdf" || !strings.Contains(result.Text, "hello OPS") {
		t.Fatalf("unexpected PDF parse receipt: %+v", result)
	}
	result, err = Parse(context.Background(), "scan.pdf", pdfFixture(t, false))
	if err == nil || result.ErrorCode != "pdf_no_text_layer" {
		t.Fatalf("scanned PDF should be rejected without OCR: %+v, %v", result, err)
	}
	encrypted := bytes.Replace(pdfFixture(t, true), []byte("/Root 1 0 R"), []byte("/Root 1 0 R /#45ncrypt 6 0 R"), 1)
	result, err = parseInWASI("encrypted.pdf", encrypted)
	if err == nil || result.ErrorCode != "pdf_encrypted" {
		t.Fatalf("escaped encryption name must not bypass rejection: %+v %v", result, err)
	}
}

func TestWASISourceMatchesGeneratedArtifact(t *testing.T) {
	var source []byte
	for _, path := range []string{"wasm/main.go", "../../go.mod", "../../go.sum"} {
		part, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		source = append(source, bytes.ReplaceAll(part, []byte("\r\n"), []byte("\n"))...)
	}
	digest, err := os.ReadFile("parser-source.sha256")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprintf("%x", sha256.Sum256(source)) != strings.TrimSpace(string(digest)) {
		t.Fatal("WASI parser source changed; regenerate the embedded artifact with scripts/build-agent-document-parser.ps1")
	}
}

func TestParserRejectsUnknownExtensionWithoutReadingFilesystem(t *testing.T) {
	result, err := parseInWASI("C:\\private\\outside.csv", []byte("a,b\n1,2\n"))
	if err != nil || result.Rows == nil || *result.Rows != 2 {
		t.Fatalf("parser should treat the name as metadata and read only stdin: %+v %v", result, err)
	}
	result, err = parseInWASI("archive.zip", []byte("PK\x03\x04"))
	if err == nil || result.ErrorCode != "document_type_unsupported" {
		t.Fatalf("archives must not be parsed: %+v %v", result, err)
	}
}

func parseInWASI(name string, data []byte) (Result, error) {
	payload, err := json.Marshal(Request{Name: name, Data: data})
	if err != nil {
		return Result{}, err
	}
	output, err := runWASI(payload)
	if err != nil {
		return Result{}, err
	}
	var result Result
	if err := json.Unmarshal(output, &result); err != nil {
		return Result{}, err
	}
	if result.ErrorCode != "" {
		return result, fmt.Errorf("document rejected: %s", result.ErrorCode)
	}
	return result, nil
}

func docxFixture(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	for name, content := range files {
		entry, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func pdfFixture(t *testing.T, withText bool) []byte {
	t.Helper()
	content := ""
	font := ""
	resources := "<< >>"
	if withText {
		content = "BT /F1 12 Tf 72 720 Td (hello OPS) Tj ET"
		font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
		resources = "<< /Font << /F1 4 0 R >> >>"
	}
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources %s /Contents 5 0 R >>", resources),
		font,
		"<< /Length " + fmt.Sprint(len(content)) + " >>\nstream\n" + content + "\nendstream",
	}
	var out bytes.Buffer
	out.WriteString("%PDF-1.4\n")
	var offsets []int
	for i, object := range objects {
		offsets = append(offsets, out.Len())
		if object == "" {
			object = "<< >>"
		}
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := out.Len()
	fmt.Fprintf(&out, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&out, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&out, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF", len(offsets)+1, xref)
	return out.Bytes()
}
