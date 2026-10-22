package app

// NW-A2 / NW-D2：新建作品幂等与 checking 回落（docs/22 操作动线问题清单 P0）。

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func (e *testEnv) postWithHeader(t *testing.T, path string, in any, headers map[string]string) (int, []byte) {
	t.Helper()
	b, _ := json.Marshal(in)
	req, _ := http.NewRequest("POST", e.http.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", e.csrf)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func TestNWA2_CreateWorkIsIdempotent(t *testing.T) {
	f := env.accounts(t)
	accountID := f.wechat.ID.String()
	path := "/api/v1/accounts/" + accountID + "/works"
	key := uuid.NewString()

	var first, second Work
	if st, b := env.postWithHeader(t, path, map[string]string{"title": ""}, map[string]string{"Idempotency-Key": key}); st != 200 {
		t.Fatalf("first create: %d %s", st, b)
	} else if err := json.Unmarshal(b, &first); err != nil {
		t.Fatal(err)
	}
	if st, b := env.postWithHeader(t, path, map[string]string{"title": ""}, map[string]string{"Idempotency-Key": key}); st != 200 {
		t.Fatalf("second create: %d %s", st, b)
	} else if err := json.Unmarshal(b, &second); err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("same idempotency key created two works: %s vs %s", first.ID, second.ID)
	}
	var n int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL AND client_request_id=$2`, f.wechat.ID, key).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want 1 work for the key, got %d", n)
	}
	// 不同 key 仍然可以再建一篇（不是按内容去重）。
	if st, b := env.postWithHeader(t, path, map[string]string{"title": ""}, map[string]string{"Idempotency-Key": uuid.NewString()}); st != 200 {
		t.Fatalf("third create: %d %s", st, b)
	} else {
		var third Work
		if err := json.Unmarshal(b, &third); err != nil {
			t.Fatal(err)
		}
		if third.ID == first.ID {
			t.Fatal("different key should create a new work")
		}
	}
}

func TestNWD2_ContentChangeLeavesChecking(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "检查中的作品"}, &wk)
	id := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": "先写观点"}, nil)
	// 直接置为 checking，模拟检查已发起（检查接口本身需要正文，这里只验证状态回落规则）。
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='checking' WHERE id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}
	var after Work
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]string{"viewpoint": "改过的观点"}, &after)
	if after.Status != "drafting" {
		t.Fatalf("content change during checking should return to drafting, got %s", after.Status)
	}
}
