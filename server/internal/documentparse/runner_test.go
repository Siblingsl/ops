package documentparse

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
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
		"word/document.xml": "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>运营笔记</w:t></w:r></w:p></w:body></w:document>",
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
		"word/document.xml":            "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>",
		"word/_rels/document.xml.rels": "<Relationships><Relationship TargetMode=\"External\" Target=\"https://example.invalid\"/></Relationships>",
	})
	got, err := parseInWASI("notes.docx", external)
	if err == nil || got.ErrorCode != "docx_external_link_unsupported" {
		t.Fatalf("external relationship was not rejected: %+v, %v", got, err)
	}

	macro := docxFixture(t, map[string]string{
		"word/document.xml":   "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>",
		"[Content_Types].xml": "<Types><Default ContentType=\"application/vnd.ms-word.document.macroEnabled.main+xml\"/></Types>",
	})
	got, err = parseInWASI("notes.docx", macro)
	if err == nil || got.ErrorCode != "docx_macro_unsupported" {
		t.Fatalf("macro content was not rejected: %+v, %v", got, err)
	}
	missingPaginationFiles := minimalOPCDOCXFiles(false)
	delete(missingPaginationFiles, "docProps/app.xml")
	missingPaginationFiles["[Content_Types].xml"] = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
	missingPaginationFiles["_rels/.rels"] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
	missingPaginationFiles["word/document.xml"] = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>`
	missingPagination := docxRawFixture(t, missingPaginationFiles)
	got, err = parseInWASI("notes.docx", missingPagination)
	if err == nil || got.ErrorCode != "docx_page_count_unverifiable" {
		t.Fatalf("DOCX without saved pagination must require PDF conversion: %+v, %v", got, err)
	}
}

func TestParseDOCXRejectsCaseInsensitiveDuplicatePartNames(t *testing.T) {
	data := docxCaseCollisionFixture(t)
	parsed, err := parseInWASI("case-collision.docx", data)
	if err == nil || parsed.ErrorCode != "docx_invalid" {
		t.Fatalf("DOCX with part names that collide under OPC ASCII case-insensitive comparison must be rejected: %+v, %v", parsed, err)
	}
}

func TestParseDOCXRejectsNonCanonicalPartPath(t *testing.T) {
	data := docxNonCanonicalPathFixture(t)
	parsed, err := parseInWASI("noncanonical-path.docx", data)
	if err == nil || parsed.ErrorCode != "docx_invalid" {
		t.Fatalf("DOCX part paths containing dot segments must be rejected: %+v, %v", parsed, err)
	}
}

func TestParseDOCXRejectsEncryptedZIPEntryFlag(t *testing.T) {
	data := docxEncryptedEntryFlagFixture(t)
	parsed, err := parseInWASI("encrypted-entry.docx", data)
	if err == nil || parsed.ErrorCode != "docx_encrypted" {
		t.Fatalf("DOCX entries marked as encrypted must be rejected before decompression: %+v, %v", parsed, err)
	}
}

func TestParseDOCXMinimalOPCPackageAndRejectsExternalRootRelationship(t *testing.T) {
	files := minimalOPCDOCXFiles(false)
	parsed, err := parseInWASI("minimal-opc.docx", docxFixture(t, files))
	if err != nil || !strings.Contains(parsed.Text, "最小 OPC 文档") || parsed.Pages == nil || *parsed.Pages != 1 {
		t.Fatalf("minimal OPC package should parse its body and saved page count: result=%+v err=%v", parsed, err)
	}

	files = minimalOPCDOCXFiles(true)
	parsed, err = parseInWASI("external-root-relationship.docx", docxFixture(t, files))
	if err == nil || parsed.ErrorCode != "docx_external_link_unsupported" {
		t.Fatalf("external package-root relationships must be rejected: result=%+v err=%v", parsed, err)
	}
}

func TestParseDOCXRejectsIncompleteOPCPackage(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]string)
	}{
		{name: "missing content types", mutate: func(files map[string]string) { delete(files, "[Content_Types].xml") }},
		{name: "missing root relationships", mutate: func(files map[string]string) { delete(files, "_rels/.rels") }},
		{name: "missing office document relationship", mutate: func(files map[string]string) {
			files["_rels/.rels"] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/extended-properties" Target="docProps/app.xml"/></Relationships>`
		}},
		{name: "missing main document content type", mutate: func(files map[string]string) {
			files["[Content_Types].xml"] = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := minimalOPCDOCXFiles(false)
			tc.mutate(files)
			parsed, err := parseInWASI("incomplete-opc.docx", docxRawFixture(t, files))
			if err == nil || parsed.ErrorCode != "docx_invalid" {
				t.Fatalf("incomplete DOCX package must be rejected: result=%+v err=%v", parsed, err)
			}
		})
	}
}

func TestParseDOCXRejectsForeignOPCMetadataElements(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]string)
	}{
		{
			name: "foreign relationship element",
			mutate: func(files map[string]string) {
				files["_rels/.rels"] = strings.Replace(files["_rels/.rels"], `<Relationship Id="rId1"`, `<f:Relationship xmlns:f="urn:foreign" Id="rId1"`, 1)
			},
		},
		{
			name: "foreign content type override",
			mutate: func(files map[string]string) {
				files["[Content_Types].xml"] = strings.Replace(files["[Content_Types].xml"], `<Override PartName="/word/document.xml"`, `<f:Override xmlns:f="urn:foreign" PartName="/word/document.xml"`, 1)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := minimalOPCDOCXFiles(false)
			tc.mutate(files)
			parsed, err := parseInWASI("foreign-opc-metadata.docx", docxRawFixture(t, files))
			if err == nil || parsed.ErrorCode != "docx_invalid" {
				t.Fatalf("OPC metadata elements in foreign namespaces must not satisfy package structure: result=%+v err=%v", parsed, err)
			}
		})
	}
}

func TestParseDOCXRejectsMissingOrDuplicatePackageRelationshipIDs(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]string)
	}{
		{
			name: "missing main document relationship id",
			mutate: func(files map[string]string) {
				files["_rels/.rels"] = strings.Replace(files["_rels/.rels"], ` Id="rId1"`, "", 1)
			},
		},
		{
			name: "duplicate relationship ids",
			mutate: func(files map[string]string) {
				files["_rels/.rels"] = strings.Replace(files["_rels/.rels"], `Id="rId2"`, `Id="rId1"`, 1)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := minimalOPCDOCXFiles(false)
			tc.mutate(files)
			parsed, err := parseInWASI("invalid-package-relationship-id.docx", docxRawFixture(t, files))
			if err == nil || parsed.ErrorCode != "docx_invalid" {
				t.Fatalf("package relationship IDs must be present and unique: result=%+v err=%v", parsed, err)
			}
		})
	}
}

func TestParseDOCXRejectsMainDocumentContentTypeOverrideConflict(t *testing.T) {
	cases := []struct {
		name         string
		contentTypes string
	}{
		{
			name:         "specific override takes precedence",
			contentTypes: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/document.xml" ContentType="application/xml"/></Types>`,
		},
		{
			name:         "duplicate XML defaults are rejected",
			contentTypes: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Default Extension="XML" ContentType="application/xml"/></Types>`,
		},
		{
			name:         "duplicate main document overrides are rejected",
			contentTypes: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/xml"/><Override PartName="/WORD/DOCUMENT.XML" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := minimalOPCDOCXFiles(false)
			files["[Content_Types].xml"] = tc.contentTypes
			parsed, err := parseInWASI("content-type-override-conflict.docx", docxRawFixture(t, files))
			if err == nil || parsed.ErrorCode != "docx_invalid" {
				t.Fatalf("conflicting main document content type mapping must be rejected: result=%+v err=%v", parsed, err)
			}
		})
	}
}

func TestParseDOCXAcceptsMainDocumentContentTypeDefaultMapping(t *testing.T) {
	files := minimalOPCDOCXFiles(false)
	files["[Content_Types].xml"] = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
	parsed, err := parseInWASI("default-main-content-type.docx", docxRawFixture(t, files))
	if err != nil || !strings.Contains(parsed.Text, "最小 OPC 文档") {
		t.Fatalf("XML default mapping for a main document without its own override should parse: result=%+v err=%v", parsed, err)
	}
}

func TestParseDOCXRejectsNonWordprocessingMainDocumentStructure(t *testing.T) {
	cases := []struct {
		name     string
		document string
	}{
		{
			name:     "foreign namespace",
			document: `<w:document xmlns:w="urn:foreign"><w:body><w:p><w:r><w:t>not WordprocessingML</w:t></w:r></w:p></w:body></w:document>`,
		},
		{
			name:     "wrong root element",
			document: `<w:body xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>not a document root</w:t></w:r></w:p></w:body>`,
		},
		{
			name:     "missing main body",
			document: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>missing body</w:t></w:r></w:p></w:document>`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := minimalOPCDOCXFiles(false)
			files["word/document.xml"] = tc.document
			parsed, err := parseInWASI("invalid-main-document.docx", docxRawFixture(t, files))
			if err == nil || parsed.ErrorCode != "docx_invalid" {
				t.Fatalf("non-Wordprocessing main-document structure must be rejected: result=%+v err=%v", parsed, err)
			}
		})
	}
}

func TestParseDOCXAcceptsStrictWordprocessingMainDocument(t *testing.T) {
	files := minimalOPCDOCXFiles(false)
	files["_rels/.rels"] = strings.Replace(files["_rels/.rels"], "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument", 1)
	files["word/document.xml"] = strings.Replace(files["word/document.xml"], "http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main", 1)
	parsed, err := parseInWASI("strict-wordprocessing-main-document.docx", docxRawFixture(t, files))
	if err != nil || !strings.Contains(parsed.Text, "最小 OPC 文档") {
		t.Fatalf("strict WordprocessingML main document should parse: result=%+v err=%v", parsed, err)
	}
}

func TestParseDOCXRejectsHighCompressionExpandedSizeUnderWASI(t *testing.T) {
	const expandedLimit = 96 << 20
	compressed, ratio := highCompressionDOCXFixture(t)
	start := time.Now()
	result, err := parseInWASI("high-compression.docx", compressed)
	elapsed := time.Since(start)
	if err == nil || result.ErrorCode != "docx_expanded_size_limit" {
		t.Fatalf("high-compression DOCX should fail from its declared expanded size: result %+v, err %v", result, err)
	}
	t.Logf("DEV-QA26_METRIC_DOCX_ZIP_BOMB %s", fmt.Sprintf(`{"expanded_bytes":%d,"compressed_bytes":%d,"ratio":%.1f,"parse_ms":%.2f,"result":"%s"}`, expandedLimit+1, len(compressed), ratio, float64(elapsed.Microseconds())/1000, result.ErrorCode))
}

func TestParseDOCXAcceptsLargeDocumentEntryAndTruncatesText(t *testing.T) {
	const expandedDocumentEntry = 4 << 20
	compressed, ratio := compressedDocumentEntryDOCXFixture(t, expandedDocumentEntry)
	start := time.Now()
	result, err := parseInWASI("large-document-entry.docx", compressed)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("large compressed DOCX entry should parse: result %+v, err %v", result, err)
	}
	if result.Pages == nil || *result.Pages != 1 || result.PageBasis != "docx_saved_pagination" || result.InjectedChars != 20000 || result.TruncatedFrom == nil || *result.TruncatedFrom != 20001 || result.TruncatedTo == nil || *result.TruncatedTo != result.ExtractedChars || result.ExtractedChars <= result.InjectedChars || len([]rune(result.Text)) != result.InjectedChars {
		t.Fatalf("large DOCX entry should parse with a bounded text receipt: %+v", result)
	}
	t.Logf("DEV-QA26_METRIC_DOCX_LARGE_ENTRY %s", fmt.Sprintf(`{"expanded_bytes":%d,"compressed_bytes":%d,"ratio":%.1f,"parse_ms":%.2f,"extracted_chars":%d,"injected_chars":%d}`, expandedDocumentEntry, len(compressed), ratio, float64(elapsed.Microseconds())/1000, result.ExtractedChars, result.InjectedChars))
}

func TestParseDOCXAcceptsEightMiBDocumentEntryAndTruncatesText(t *testing.T) {
	const expandedDocumentEntry = 8 << 20
	compressed, ratio := compressedDocumentEntryDOCXFixture(t, expandedDocumentEntry)
	start := time.Now()
	result, err := parseInWASI("large-document-entry-8mib.docx", compressed)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("8 MiB compressed DOCX entry should parse: result %+v, err %v", result, err)
	}
	if result.Pages == nil || *result.Pages != 1 || result.PageBasis != "docx_saved_pagination" || result.InjectedChars != 20000 || result.TruncatedFrom == nil || *result.TruncatedFrom != 20001 || result.TruncatedTo == nil || *result.TruncatedTo != result.ExtractedChars || result.ExtractedChars <= result.InjectedChars || len([]rune(result.Text)) != result.InjectedChars {
		t.Fatalf("8 MiB DOCX entry should parse with a bounded text receipt: %+v", result)
	}
	t.Logf("DEV-QA26_METRIC_DOCX_8MIB_ENTRY %s", fmt.Sprintf(`{"expanded_bytes":%d,"compressed_bytes":%d,"ratio":%.1f,"parse_ms":%.2f,"extracted_chars":%d,"injected_chars":%d}`, expandedDocumentEntry, len(compressed), ratio, float64(elapsed.Microseconds())/1000, result.ExtractedChars, result.InjectedChars))
}

func TestParseFiveMiBDocumentEntryThroughWindowsWorker(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("requires the isolated Windows parser worker")
	}
	const expandedDocumentEntry = 5 << 20
	compressed, ratio := compressedDocumentEntryDOCXFixture(t, expandedDocumentEntry)
	started := time.Now()
	result, err := Parse(context.Background(), "large-document-entry-5mib.docx", compressed)
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("5 MiB document.xml should parse through the bounded Windows worker in under 30 seconds: %v", err)
	}
	if result.Pages == nil || *result.Pages != 1 || result.PageBasis != "docx_saved_pagination" || result.InjectedChars != 20000 || result.TruncatedFrom == nil || *result.TruncatedFrom != 20001 || result.TruncatedTo == nil || *result.TruncatedTo != result.ExtractedChars || result.ExtractedChars <= result.InjectedChars || len([]rune(result.Text)) != result.InjectedChars {
		t.Fatalf("5 MiB DOCX entry should parse with a bounded text receipt: %+v", result)
	}
	t.Logf("DEV-QA26_METRIC_DOCX_5MIB_WINDOWS_WORKER %s", fmt.Sprintf(`{"expanded_bytes":%d,"compressed_bytes":%d,"ratio":%.1f,"parse_ms":%.2f,"extracted_chars":%d,"injected_chars":%d}`, expandedDocumentEntry, len(compressed), ratio, float64(elapsed.Microseconds())/1000, result.ExtractedChars, result.InjectedChars))
}

func highCompressionDOCXFixture(t *testing.T) ([]byte, float64) {
	t.Helper()
	const expandedLimit = 96 << 20
	files := map[string][]byte{
		"[Content_Types].xml": []byte(minimalOPCDOCXFiles(false)["[Content_Types].xml"]),
		"_rels/.rels":         []byte(minimalOPCDOCXFiles(false)["_rels/.rels"]),
		"word/document.xml":   []byte("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>high compression</w:t></w:r></w:p></w:body></w:document>"),
		"docProps/app.xml":    []byte("<Properties><Pages>1</Pages></Properties>"),
	}
	baseExpanded := 0
	for _, content := range files {
		baseExpanded += len(content)
	}

	var compressed bytes.Buffer
	archive := zip.NewWriter(&compressed)
	for name, content := range files {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	payload, err := archive.Create("customXml/payload.xml")
	if err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("a"), 1<<20)
	remaining := expandedLimit + 1 - baseExpanded
	for remaining > 0 {
		count := min(remaining, len(chunk))
		if _, err := payload.Write(chunk[:count]); err != nil {
			t.Fatal(err)
		}
		remaining -= count
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	ratio := float64(expandedLimit+1) / float64(compressed.Len())
	if ratio < 100 {
		t.Fatalf("fixture compression ratio unexpectedly low: %.1f:1 (%d compressed bytes)", ratio, compressed.Len())
	}
	return compressed.Bytes(), ratio
}

func compressedDocumentEntryDOCXFixture(t *testing.T, expandedDocumentEntry int) ([]byte, float64) {
	t.Helper()
	prefix := []byte(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>`)
	suffix := []byte(`</w:t></w:r></w:p></w:body></w:document>`)
	var compressed bytes.Buffer
	archive := zip.NewWriter(&compressed)
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels"} {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(minimalOPCDOCXFiles(false)[name])); err != nil {
			t.Fatal(err)
		}
	}
	document, err := archive.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := document.Write(prefix); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("a"), 1<<20)
	remaining := expandedDocumentEntry - len(prefix) - len(suffix)
	for remaining > 0 {
		count := min(remaining, len(chunk))
		if _, err := document.Write(chunk[:count]); err != nil {
			t.Fatal(err)
		}
		remaining -= count
	}
	if _, err := document.Write(suffix); err != nil {
		t.Fatal(err)
	}
	app, err := archive.Create("docProps/app.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.Write([]byte("<Properties><Pages>1</Pages></Properties>")); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if compressed.Len() > maxBytes {
		t.Fatalf("high-compression fixture must fit the compressed file limit: %d", compressed.Len())
	}
	ratio := float64(expandedDocumentEntry) / float64(compressed.Len())
	if ratio < 100 {
		t.Fatalf("fixture compression ratio unexpectedly low: %.1f:1 (%d compressed bytes)", ratio, compressed.Len())
	}
	return compressed.Bytes(), ratio
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
	complete := minimalOPCDOCXFiles(false)
	for name, content := range files {
		complete[name] = content
	}
	return docxRawFixture(t, complete)
}

func docxRawFixture(t *testing.T, files map[string]string) []byte {
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

func docxCaseCollisionFixture(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	entries := [][2]string{
		{"word/document.xml", "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>第一部件</w:t></w:r></w:p></w:body></w:document>"},
		{"WORD/DOCUMENT.XML", "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>冲突部件</w:t></w:r></w:p></w:body></w:document>"},
		{"docProps/app.xml", "<Properties><Pages>1</Pages></Properties>"},
	}
	for _, item := range entries {
		entry, err := w.Create(item[0])
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(item[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func docxNonCanonicalPathFixture(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	entries := [][2]string{
		{"word/./document.xml", "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>点段路径</w:t></w:r></w:p></w:body></w:document>"},
		{"docProps/app.xml", "<Properties><Pages>1</Pages></Properties>"},
	}
	for _, item := range entries {
		entry, err := w.Create(item[0])
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(item[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func docxEncryptedEntryFlagFixture(t *testing.T) []byte {
	t.Helper()
	data := docxFixture(t, map[string]string{
		"word/document.xml": "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>加密条目标志</w:t></w:r></w:p></w:body></w:document>",
		"docProps/app.xml":  "<Properties><Pages>1</Pages></Properties>",
	})
	signature := []byte{0x50, 0x4b, 0x01, 0x02}
	for offset := bytes.Index(data, signature); offset >= 0; {
		if offset != 0 && offset+46 <= len(data) {
			nameLength := int(data[offset+28]) | int(data[offset+29])<<8
			if offset+46+nameLength <= len(data) && string(data[offset+46:offset+46+nameLength]) == "word/document.xml" {
				localOffset := int(data[offset+42]) | int(data[offset+43])<<8 | int(data[offset+44])<<16 | int(data[offset+45])<<24
				centralFlags := uint16(data[offset+8]) | uint16(data[offset+9])<<8
				localFlags := uint16(data[localOffset+6]) | uint16(data[localOffset+7])<<8
				centralFlags |= 1
				localFlags |= 1
				data[offset+8], data[offset+9] = byte(centralFlags), byte(centralFlags>>8)
				data[localOffset+6], data[localOffset+7] = byte(localFlags), byte(localFlags>>8)
				return data
			}
		}
		next := bytes.Index(data[offset+4:], signature)
		if next < 0 {
			break
		}
		offset += next + 4
	}
	t.Fatal("DOCX central directory entry not found")
	return nil
}

func minimalOPCDOCXFiles(externalRootRelationship bool) map[string]string {
	rootRelationships := `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/extended-properties" Target="docProps/app.xml"/>`
	if externalRootRelationship {
		rootRelationships += `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid" TargetMode="External"/>`
	}
	rootRelationships += `</Relationships>`
	return map[string]string{
		"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
		"_rels/.rels":         rootRelationships,
		"word/document.xml":   `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>最小 OPC 文档</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
		"docProps/app.xml":    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Word</Application><Pages>1</Pages></Properties>`,
	}
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
