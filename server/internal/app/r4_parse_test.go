package app

import "testing"

func TestParseMDSections(t *testing.T) {
	parts := parseMDSections("## 先说结论\n\n一句话。\n\n## 具体怎么做\n\n步骤一。")
	if len(parts) != 2 {
		t.Fatalf("want 2 parts, got %d", len(parts))
	}
	if parts[0].Heading != "先说结论" || parts[1].Heading != "具体怎么做" {
		t.Fatalf("headings: %#v", parts)
	}
	if parts[0].Body != "一句话。" {
		t.Fatalf("body0: %q", parts[0].Body)
	}
}
