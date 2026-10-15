package app

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestOPT73RequestErrorsAreChineseAndAccountFieldsAreMapped(t *testing.T) {
	for _, raw := range []string{"{", `{"platform":1,"name":"测试","content_format":"image_note"}`} {
		resp := env.request("POST", "/api/v1/accounts", strings.NewReader(raw), "application/json")
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 422 {
			t.Fatalf("malformed JSON: status=%d body=%s", resp.StatusCode, body)
		}
		var out struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
		if out.Error.Message != "请求格式不正确，请检查 JSON 语法和字段类型" {
			t.Fatalf("malformed JSON message = %q", out.Error.Message)
		}
	}

	status, body := env.do("POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "", "content_format": "image_note"})
	if status != 422 {
		t.Fatalf("empty account name: status=%d body=%s", status, body)
	}
	var out struct {
		Error struct {
			Fields map[string]string `json:"fields"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if out.Error.Fields["name"] != "请填写账号名称" {
		t.Fatalf("account name field error = %#v", out.Error.Fields)
	}
}
