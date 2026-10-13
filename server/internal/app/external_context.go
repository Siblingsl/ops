package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
)

func externalBlock(kind, id string, data any) string {
	payload, _ := json.Marshal(data)
	return fmt.Sprintf("<<<%s id=%s>>>\n%s\n<<<结束>>>\n", kind, id, payload)
}

func cleanExternalText(text string) string {
	return strings.Map(func(char rune) rune {
		if unicode.Is(unicode.Cf, char) || unicode.IsControl(char) && char != '\n' && char != '\t' {
			return -1
		}
		return char
	}, text)
}
