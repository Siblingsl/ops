package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；preview_link.go 批次）：
// hmac.Write 为 C 类（Hash 永不报错，显式注释）；预览资源 w.Write 失败必须上抛。

type be02FailWriter struct {
	http.ResponseWriter
	err error
}

func (w be02FailWriter) Write([]byte) (int, error) { return 0, w.err }

func TestBE02PreviewSignVerifyRoundTrip(t *testing.T) {
	claims := previewClaims{
		WorkspaceID: uuid.MustParse(env.me(t).Workspace.ID),
		WorkID:      uuid.New(),
		ExpiresAt:   env.srv.now().Add(time.Hour).Unix(),
	}
	token, err := env.srv.signPreview(claims)
	if err != nil {
		t.Fatal(err)
	}
	got, err := env.srv.verifyPreview(token)
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceID != claims.WorkspaceID || got.WorkID != claims.WorkID || got.ExpiresAt != claims.ExpiresAt {
		t.Fatalf("round-trip mismatch: %+v vs %+v", got, claims)
	}
}

func TestBE02PreviewAssetWriteFailureSurfacesError(t *testing.T) {
	work := opt37CreateWork(t, "BE-02 预览写出失败")
	asset := env.upload(t, work.ID.String(), testPNG(8, 8))
	token, _ := opt37PreviewToken(t, work.ID)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/public-previews/"+token+"/assets/"+asset.ID.String(), nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("token", token)
	routeCtx.URLParams.Add("assetId", asset.ID.String())
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))

	rec := httptest.NewRecorder()
	fail := be02FailWriter{ResponseWriter: rec, err: errors.New("client_gone")}
	if err := env.srv.getPublicPreviewAsset(fail, req); err == nil {
		t.Fatal("ResponseWriter.Write 失败必须上抛，不得伪装成功")
	} else if err.Error() != "client_gone" {
		t.Fatalf("应返回写出错误，实际 %v", err)
	}
}
