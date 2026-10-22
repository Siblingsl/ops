package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// 拉取供应商的可用模型（GET {base_url}/models）。这是一个**只读**操作：
// 不写库、不改 last_test 字段，前端拿到列表后填进表单，用户点「保存」才持久化。
// 这样「点一下获取」不会悄悄改动线上配置，取消编辑也不会留下痕迹。
type discoverInput struct {
	ID      *uuid.UUID `json:"id"`
	BaseURL string     `json:"base_url"`
	APIKey  string     `json:"api_key"`
}

func (s *Server) discoverProviderModels(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	var in discoverInput
	if err := decode(r, &in); err != nil {
		return err
	}
	base := strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return validation("接口地址需要以 http:// 或 https:// 开头")
	}

	key := strings.TrimSpace(in.APIKey)
	// 编辑已有供应商时：只有接口地址没变才复用已保存的密钥。
	// 改了地址就必须重新填密钥——否则等于把旧密钥发往一个尚未验证的新地址。
	if key == "" {
		if in.ID == nil {
			return validation("请填写 API 密钥")
		}
		var storedBase string
		var enc []byte
		if err := s.db.QueryRow(ctx, `SELECT base_url, api_key_enc FROM model_provider
			WHERE id=$1 AND workspace_id=$2 AND execution_location='server'`,
			*in.ID, ident(ctx).WorkspaceID).Scan(&storedBase, &enc); err != nil {
			return errNotFound
		}
		if strings.TrimRight(storedBase, "/") != base {
			return validation("接口地址已修改，请先填写新的 API 密钥再获取模型")
		}
		decrypted, err := s.box.Decrypt(enc)
		if err != nil {
			return err
		}
		key = decrypted
	}

	tctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodGet, base+"/models", nil)
	if err != nil {
		return validation("接口地址无法解析")
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")

	res, err := s.aiHTTP.Do(req)
	if err != nil {
		msg := strings.ReplaceAll(err.Error(), key, "****")
		return apiErr(502, "provider_unreachable", "无法连接供应商："+truncate(msg, 200))
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return apiErr(502, "provider_unreachable", "读取供应商响应失败")
	}

	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return apiErr(422, "provider_unauthorized", "API 密钥无效或没有访问权限")
	case res.StatusCode == http.StatusNotFound:
		return apiErr(422, "provider_no_models", "这个接口地址下没有 /models 端点，请确认地址以 /v1 结尾")
	case res.StatusCode < 200 || res.StatusCode >= 300:
		return apiErr(502, "provider_error", fmt.Sprintf("供应商返回 %d：%s", res.StatusCode, truncate(strings.TrimSpace(string(body)), 160)))
	}

	models := parseModelList(body)
	if len(models) == 0 {
		return apiErr(422, "provider_no_models", "供应商没有返回任何模型，请确认接口地址与密钥是否正确")
	}
	return ok(w, map[string]any{"models": models, "count": len(models)})
}

// parseModelList 兼容两种常见形态：{"data":[{"id":"..."}]} 与 [{"id":"..."}]。
func parseModelList(body []byte) []string {
	var wrapped struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	ids := []string{}
	if err := json.Unmarshal(body, &wrapped); err == nil && len(wrapped.Data) > 0 {
		for _, m := range wrapped.Data {
			if id := strings.TrimSpace(m.ID); id != "" {
				ids = append(ids, id)
			}
		}
	} else {
		var plain []struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(body, &plain); err == nil {
			for _, m := range plain {
				if id := strings.TrimSpace(m.ID); id != "" {
					ids = append(ids, id)
				}
			}
		}
	}
	sort.Strings(ids)
	return dedupe(ids)
}

func dedupe(list []string) []string {
	seen := make(map[string]bool, len(list))
	out := make([]string, 0, len(list))
	for _, v := range list {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
