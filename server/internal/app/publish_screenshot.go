package app

// REF41 P3：发布回读截图入库。桌面执行器把 CDP 截图的 base64 放进
// result.evidence；服务端在落账前转存 asset 表，只保留 screenshot_asset_id，
// 避免把图片字节写进 publish_task.evidence。work_id 为空、account_id 必填，
// 与 P3-A6 的口径一致；不触碰 work 内容修订，避免填写中途让 manifest 失效。

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

const publishScreenshotMaxBytes = 6 << 20

func (s *Server) storePublishScreenshot(ctx context.Context, task *PublishTask, encoded string) (uuid.UUID, error) {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return uuid.Nil, errors.New("截图内容为空")
	}
	if strings.HasPrefix(encoded, "data:") {
		if idx := strings.Index(encoded, ","); idx >= 0 {
			encoded = encoded[idx+1:]
		}
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return uuid.Nil, fmt.Errorf("截图 base64 无法解码: %w", err)
	}
	if len(raw) == 0 || len(raw) > publishScreenshotMaxBytes {
		return uuid.Nil, fmt.Errorf("截图大小必须在 1 字节到 %d 字节之间", publishScreenshotMaxBytes)
	}
	data, mime, width, height, err := processImage(raw)
	if err != nil {
		return uuid.Nil, fmt.Errorf("截图不是可识别的图片: %w", err)
	}
	id := uuid.New()
	ext := ".jpg"
	if mime == "image/png" {
		ext = ".png"
	}
	rel := filepath.Join("publish-readback", task.ID.String(), id.String()+ext)
	if err := s.writeAssetFiles(filepath.ToSlash(rel), data, mime); err != nil {
		return uuid.Nil, err
	}
	digest := sha256Hex(data)
	if _, err := s.db.Exec(ctx, `INSERT INTO asset
		(id, workspace_id, account_id, work_id, storage_path, mime, width, height, bytes, sha256, position)
		VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,0)`,
		id, task.WorkspaceID, task.AccountID, filepath.ToSlash(rel), mime, width, height, len(data), digest); err != nil {
		removeAssetFiles(s.cfg.DataDir, filepath.ToSlash(rel))
		return uuid.Nil, err
	}
	return id, nil
}

func (s *Server) readStoredAsset(rel string) ([]byte, error) {
	return os.ReadFile(filepath.Join(s.cfg.DataDir, filepath.FromSlash(rel)))
}
