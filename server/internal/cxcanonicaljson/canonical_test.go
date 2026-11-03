package cxcanonicaljson

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type vector struct {
	Name      string `json:"name"`
	InputJSON string `json:"input_json"`
	Canonical string `json:"canonical"`
	SHA256    string `json:"sha256,omitempty"`
}

func TestSharedVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "cx02-canonical-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []vector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			value, err := Parse([]byte(v.InputJSON))
			if err != nil {
				t.Fatal(err)
			}
			canonical, err := Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if string(canonical) != v.Canonical {
				t.Fatalf("canonical = %q, want %q", canonical, v.Canonical)
			}
			if v.SHA256 != "" {
				sum := sha256.Sum256(canonical)
				if got := hex.EncodeToString(sum[:]); got != v.SHA256 {
					t.Fatalf("sha256 = %s, want %s", got, v.SHA256)
				}
			}
		})
	}
}

func TestMarshalNormalizesStringsAndPreservesNullAndMissing(t *testing.T) {
	lf, err := Marshal(map[string]any{"summary": "a\nb", "cover": nil})
	if err != nil {
		t.Fatal(err)
	}
	crlf, err := Marshal(map[string]any{"cover": nil, "summary": "a\r\nb"})
	if err != nil {
		t.Fatal(err)
	}
	if string(lf) != string(crlf) {
		t.Fatalf("line ending variants differ: %q != %q", lf, crlf)
	}
	missing, err := Marshal(map[string]any{"summary": "a\nb"})
	if err != nil {
		t.Fatal(err)
	}
	if string(missing) == string(lf) {
		t.Fatalf("null and missing fields must stay distinct: %q", lf)
	}
}

func TestMarshalRejectsDecimalNumbers(t *testing.T) {
	for _, value := range []any{json.Number("0.8"), json.Number("1e0"), float64(1.25)} {
		if _, err := Marshal(map[string]any{"ratio": value}); err == nil {
			t.Fatalf("expected decimal rejection for %#v", value)
		}
	}
	got, err := Marshal(map[string]any{"ratio": "0.80"})
	if err != nil || string(got) != `{"ratio":"0.80"}` {
		t.Fatalf("fixed decimal string = %q, err=%v", got, err)
	}
}

func TestMarshalUsesShortEscapesAndDoesNotEscapePrintableUnicode(t *testing.T) {
	got, err := Marshal(map[string]any{"s": "\b\f\n\r\t\x00\x1f/<>\u2028\u2029"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"s":"\b\f\n\n\t\u0000\u001f/<>` + "\u2028\u2029" + `"}`
	if string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

type canonicalFixtureEntry struct {
	Index int    `json:"index"`
	Role  string `json:"role"`
	Bytes int64  `json:"bytes"`
}

func TestMarshalEncodesNamedSlicesAndStructs(t *testing.T) {
	got, err := Marshal(map[string]any{
		"targets": []string{"wechat_html", "stable_html"},
		"evidence": []canonicalFixtureEntry{
			{Index: 1, Role: "cover", Bytes: 3200},
			{Index: 2, Role: "body", Bytes: 7},
		},
		"empty_evidence": []canonicalFixtureEntry{},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"empty_evidence":[],"evidence":[{"bytes":3200,"index":1,"role":"cover"},{"bytes":7,"index":2,"role":"body"}],` +
		`"targets":["wechat_html","stable_html"]}`
	if string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	// The same logical value must hash identically whether built from Go
	// structs or parsed back from plain JSON.
	plain, err := Parse([]byte(want))
	if err != nil {
		t.Fatal(err)
	}
	round, err := Marshal(plain)
	if err != nil {
		t.Fatal(err)
	}
	if string(round) != want {
		t.Fatalf("round trip = %s, want %s", round, want)
	}
}

func TestMarshalStillRejectsDecimalsHiddenInStructs(t *testing.T) {
	if _, err := Marshal(map[string]any{"ratio": 1.25}); err == nil {
		t.Fatalf("expected bare float64 rejection")
	}
	if _, err := Marshal(map[string]any{"entry": struct {
		Ratio float64 `json:"ratio"`
	}{Ratio: 0.8}}); err == nil {
		t.Fatalf("expected decimal field rejection inside struct")
	}
}

func TestMarshalRejectsUnserializableValues(t *testing.T) {
	if _, err := Marshal(map[string]any{"ch": make(chan int)}); err == nil {
		t.Fatalf("expected channel rejection")
	}
}
