// Package cxcanonicaljson implements the canonical JSON byte format in
// docs/24 §4.6 for immutable content-production snapshots and parameter hashes.
package cxcanonicaljson

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode/utf8"
)

// Parse decodes JSON without losing integer spelling before canonicalization.
func Parse(data []byte) (any, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("canonical JSON requires valid UTF-8")
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("multiple JSON values")
		}
		return nil, err
	}
	return value, nil
}

// Marshal returns compact UTF-8 canonical JSON with normalized line endings.
// Decimal values must be validated and represented as fixed-point strings by
// the caller, as required by the CX snapshot contract.
func Marshal(value any) ([]byte, error) {
	var out strings.Builder
	if err := appendValue(&out, value); err != nil {
		return nil, err
	}
	return []byte(out.String()), nil
}

// Hash returns SHA-256 of Marshal(value) as lowercase hexadecimal.
func Hash(value any) (string, error) {
	data, err := Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func appendValue(out *strings.Builder, value any) error {
	switch value := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		if value {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case string:
		return appendString(out, value)
	case json.Number:
		return appendInteger(out, string(value))
	case int:
		out.WriteString(fmt.Sprintf("%d", value))
	case int8:
		out.WriteString(fmt.Sprintf("%d", value))
	case int16:
		out.WriteString(fmt.Sprintf("%d", value))
	case int32:
		out.WriteString(fmt.Sprintf("%d", value))
	case int64:
		out.WriteString(fmt.Sprintf("%d", value))
	case uint:
		out.WriteString(fmt.Sprintf("%d", value))
	case uint8:
		out.WriteString(fmt.Sprintf("%d", value))
	case uint16:
		out.WriteString(fmt.Sprintf("%d", value))
	case uint32:
		out.WriteString(fmt.Sprintf("%d", value))
	case uint64:
		out.WriteString(fmt.Sprintf("%d", value))
	case []any:
		out.WriteByte('[')
		for i, item := range value {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := appendValue(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			if !utf8.ValidString(key) {
				return fmt.Errorf("canonical JSON requires valid UTF-8 object keys")
			}
			keys = append(keys, normalizeNewlines(key))
		}
		sort.Strings(keys)
		out.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := appendString(out, key); err != nil {
				return err
			}
			out.WriteByte(':')
			// Look up the original key whose normalized form is this key. A
			// normalized collision is rejected instead of silently dropping data.
			var original string
			found := false
			for candidate := range value {
				if normalizeNewlines(candidate) == key {
					if found {
						return fmt.Errorf("object keys collide after newline normalization")
					}
					original, found = candidate, true
				}
			}
			if err := appendValue(out, value[original]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		// Named slices, structs, and other JSON-serializable Go values are
		// encoded through encoding/json first and re-canonicalized, so the
		// byte format stays exactly the restricted JSON above. Values that
		// encoding/json cannot represent fail closed. Decimal numbers keep
		// being rejected by appendInteger after the round trip.
		encoded, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("unsupported canonical JSON value %T: %w", value, err)
		}
		decoded, err := Parse(encoded)
		if err != nil {
			return fmt.Errorf("unsupported canonical JSON value %T: %w", value, err)
		}
		return appendValue(out, decoded)
	}
	return nil
}

func appendInteger(out *strings.Builder, value string) error {
	if value == "-0" {
		out.WriteByte('0')
		return nil
	}
	if value == "" || value[0] == '+' || strings.ContainsAny(value, ".eE") {
		return fmt.Errorf("canonical JSON decimals must be fixed-point strings")
	}
	start := 0
	if value[0] == '-' {
		start = 1
	}
	if start == len(value) || (value[start] == '0' && len(value)-start > 1) {
		return fmt.Errorf("invalid canonical JSON integer")
	}
	for _, c := range value[start:] {
		if c < '0' || c > '9' {
			return fmt.Errorf("invalid canonical JSON integer")
		}
	}
	out.WriteString(value)
	return nil
}

func appendString(out *strings.Builder, value string) error {
	if !utf8.ValidString(value) {
		return fmt.Errorf("canonical JSON requires valid UTF-8 strings")
	}
	value = normalizeNewlines(value)
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(out, `\u%04x`, r)
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
	return nil
}

func normalizeNewlines(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
}
