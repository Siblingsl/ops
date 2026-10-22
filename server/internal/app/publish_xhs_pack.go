package app

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/secure"
)

type xhsPackAsset struct {
	ID          uuid.UUID
	WorkID      uuid.UUID
	StoragePath string
	Mime        string
	Bytes       int64
	SHA256      string
}

type xhsZipEntry struct {
	Name string
	Data []byte
}

func (s *Server) packZip(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	basis, err := packBasisQuery(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var status, contentFormat, platform string
	var revision int
	err = tx.QueryRow(ctx, `SELECT w.status, w.content_format, a.platform, w.revision
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND w.deleted_at IS NULL AND a.workspace_id=$2 FOR SHARE OF w`, id, ident(ctx).WorkspaceID).
		Scan(&status, &contentFormat, &platform, &revision)
	if err != nil {
		return err
	}
	if platform != "xhs" {
		return validation("只有小红书作品可以下载发布包")
	}
	if status != "packed" && status != "published" {
		return stateInvalid("发布包还没有生成")
	}
	if basis != nil && *basis != revision {
		return packVersionConflict(revision)
	}
	if err := s.checkLatestMaterialBasis(ctx, tx, id); err != nil {
		return err
	}
	assets, err := readXhsPackAssets(ctx, tx, id, contentFormat)
	if err != nil {
		return err
	}
	cardTextIncluded := contentFormat == "card_post"
	cardText := ""
	if cardTextIncluded {
		cardText, err = readXhsPackText(ctx, tx, id)
		if err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	tmp, err := os.CreateTemp("", "ops-xhs-*.zip")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	defer tmp.Close()
	if err := writeXhsPackZip(tmp, assets, cardText, cardTextIncluded, func(a xhsPackAsset) ([]byte, error) {
		return s.readVerifiedPackAsset(a)
	}); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	verifyTx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer verifyTx.Rollback(ctx)
	var currentRevision int
	err = verifyTx.QueryRow(ctx, `SELECT w.revision FROM work w
		JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND w.deleted_at IS NULL AND a.workspace_id=$2 FOR SHARE OF w`, id, ident(ctx).WorkspaceID).Scan(&currentRevision)
	if err != nil {
		return err
	}
	if currentRevision != revision {
		return packVersionConflict(currentRevision)
	}
	if err := s.checkLatestMaterialBasis(ctx, verifyTx, id); err != nil {
		return err
	}
	if err := verifyTx.Commit(ctx); err != nil {
		return err
	}

	file, err := os.Open(tmpPath)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="xhs-%s.zip"`, time.Now().Format("20060102-1504")))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("X-OPS-Basis-Revision", strconv.Itoa(revision))
	_, err = io.Copy(w, file)
	return err
}

func packBasisQuery(r *http.Request) (*int, error) {
	value := r.URL.Query().Get("basis_revision")
	if value == "" {
		return nil, nil
	}
	revision, err := strconv.Atoi(value)
	if err != nil || revision < 1 {
		return nil, validation("作品修订号无效")
	}
	return &revision, nil
}

func packVersionConflict(serverRevision int) error {
	return apiErr(409, "version_conflict", "作品已修改，请刷新后重新下载发布包").With(map[string]any{
		"server_revision": serverRevision,
	})
}

func readXhsPackAssets(ctx context.Context, tx pgx.Tx, workID uuid.UUID, contentFormat string) ([]xhsPackAsset, error) {
	const noUUID = `'00000000-0000-0000-0000-000000000000'::uuid`
	var query string
	switch contentFormat {
	case "comic":
		query = `SELECT p.id, COALESCE(p.asset_id, ` + noUUID + `), COALESCE(a.id, ` + noUUID + `),
			COALESCE(a.work_id, ` + noUUID + `), COALESCE(a.storage_path,''), COALESCE(a.mime,''),
			COALESCE(a.bytes,-1), COALESCE(a.sha256,'')
			FROM comic_panel p LEFT JOIN asset a ON a.id=p.asset_id AND a.work_id=p.work_id
			WHERE p.work_id=$1 ORDER BY p.position`
	case "card_post":
		query = `SELECT c.id, COALESCE(c.image_asset_id, ` + noUUID + `), COALESCE(a.id, ` + noUUID + `),
			COALESCE(a.work_id, ` + noUUID + `), COALESCE(a.storage_path,''), COALESCE(a.mime,''),
			COALESCE(a.bytes,-1), COALESCE(a.sha256,'')
			FROM work_card c LEFT JOIN asset a ON a.id=c.image_asset_id AND a.work_id=c.work_id
			WHERE c.work_id=$1 ORDER BY c.position, c.created_at`
	default:
		query = `SELECT a.id, a.id, a.id, a.work_id, a.storage_path, a.mime, a.bytes, a.sha256
			FROM asset a WHERE a.work_id=$1 ORDER BY a.position, a.created_at`
	}
	rows, err := tx.Query(ctx, query, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var assets []xhsPackAsset
	for rows.Next() {
		var sourceID uuid.UUID
		var refID uuid.UUID
		var a xhsPackAsset
		if err := rows.Scan(&sourceID, &refID, &a.ID, &a.WorkID, &a.StoragePath, &a.Mime, &a.Bytes, &a.SHA256); err != nil {
			return nil, err
		}
		if refID == uuid.Nil || a.ID == uuid.Nil || a.ID != refID || a.WorkID != workID {
			return nil, stateInvalid("发布包所需图片缺失，请补齐图片后重新检查")
		}
		if a.StoragePath == "" || a.Bytes < 1 || (a.Mime != "image/jpeg" && a.Mime != "image/png") || len(a.SHA256) != 64 {
			return nil, stateInvalid("发布包所需图片信息不完整，请重新上传图片")
		}
		assets = append(assets, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if (contentFormat == "card_post" || contentFormat == "comic") && len(assets) == 0 {
		return nil, stateInvalid("发布包没有可用图片，请补齐图片后重新检查")
	}
	return assets, nil
}

func readXhsPackText(ctx context.Context, tx pgx.Tx, workID uuid.UUID) (string, error) {
	rows, err := tx.Query(ctx, `SELECT heading, content_md FROM work_section
		WHERE work_id=$1 AND deleted_at IS NULL ORDER BY position, created_at`, workID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var b strings.Builder
	first := true
	for rows.Next() {
		var heading, body string
		if err := rows.Scan(&heading, &body); err != nil {
			return "", err
		}
		if !first {
			b.WriteString("\n\n")
		}
		first = false
		if heading = strings.TrimSpace(heading); heading != "" {
			b.WriteString(heading + "\n")
		}
		b.WriteString(strings.TrimSpace(body))
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return b.String(), nil
}

func (s *Server) readVerifiedPackAsset(a xhsPackAsset) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(s.cfg.DataDir, filepath.FromSlash(a.StoragePath)))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, stateInvalid("发布包图片文件缺失，请重新上传图片")
		}
		return nil, fmt.Errorf("read xhs pack image: %w", err)
	}
	if int64(len(data)) != a.Bytes || secure.SHA256Hex(data) != a.SHA256 {
		return nil, stateInvalid("发布包图片校验失败，请重新上传图片")
	}
	return data, nil
}

func writeXhsPackZip(w io.Writer, assets []xhsPackAsset, cardText string, includeCardText bool, load func(xhsPackAsset) ([]byte, error)) error {
	zw := zip.NewWriter(w)
	add := func(name string, data []byte) error {
		f, err := zw.Create(name)
		if err != nil {
			return err
		}
		n, err := f.Write(data)
		if err != nil {
			return err
		}
		if n != len(data) {
			return io.ErrShortWrite
		}
		return nil
	}
	for i, asset := range assets {
		data, err := load(asset)
		if err != nil {
			_ = zw.Close()
			return err
		}
		ext := ".jpg"
		if asset.Mime == "image/png" {
			ext = ".png"
		}
		if err := add(fmt.Sprintf("%02d%s", i+1, ext), data); err != nil {
			_ = zw.Close()
			return err
		}
	}
	if includeCardText {
		if err := add("文案.txt", []byte(cardText)); err != nil {
			_ = zw.Close()
			return err
		}
	}
	return zw.Close()
}
