package app

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type agentArtifactTable struct {
	Columns []string   `json:"columns"`
	Rows    [][]string `json:"rows"`
}

func agentReadArtifactTable(text string) (agentArtifactTable, string, error) {
	if !utf8.ValidString(text) || runeLen(text) > 20000 {
		return agentArtifactTable{}, "", validation("表格内容须为最多 20000 字的 UTF-8 CSV")
	}
	reader := csv.NewReader(strings.NewReader(text))
	reader.FieldsPerRecord = 0
	var records [][]string
	for {
		row, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil || len(row) == 0 || len(row) > 100 || len(records) >= 10000 {
			return agentArtifactTable{}, "", validation("表格须为列数一致的 CSV，最多 10000 行、100 列，首行为列名")
		}
		records = append(records, row)
	}
	if len(records) == 0 {
		return agentArtifactTable{}, "", validation("表格至少需要一行 CSV 列名")
	}
	var canonical bytes.Buffer
	writer := csv.NewWriter(&canonical)
	if err := writer.WriteAll(records); err != nil {
		return agentArtifactTable{}, "", err
	}
	return agentArtifactTable{Columns: records[0], Rows: records[1:]}, canonical.String(), nil
}

func agentArtifactTextContent(kind, text string) ([]byte, error) {
	content := map[string]any{"format": "text", "text": text}
	if kind == "table" {
		table, canonical, err := agentReadArtifactTable(text)
		if err != nil {
			return nil, err
		}
		content["text"], content["table"] = canonical, table
	}
	return json.Marshal(content)
}

func agentCSVSafeCell(cell string) string {
	probe := strings.TrimLeftFunc(cell, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' || r == '\'' })
	first, _ := utf8.DecodeRuneInString(cell)
	prefix, _ := utf8.DecodeRuneInString(probe)
	if unicode.IsControl(first) || first == '\uFEFF' || strings.ContainsRune("=+-@＝＋－＠", prefix) {
		return "文本：" + cell
	}
	return cell
}

// Downloads are private version reads. They never serialize a conversation or an action result.
func (s *Server) getAgentArtifactFile(w http.ResponseWriter, r *http.Request) error {
	artifactID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	version, err := strconv.Atoi(r.URL.Query().Get("version"))
	if err != nil || version < 1 {
		return validation("下载需要明确的产物版本")
	}
	format := r.URL.Query().Get("format")
	if format != "md" && format != "txt" && format != "csv" && format != "original" {
		return validation("下载格式无效")
	}
	var conversationID, versionID uuid.UUID
	var sourceMessageID *uuid.UUID
	var kind, sourceKind string
	var raw []byte
	err = s.db.QueryRow(r.Context(), `SELECT a.conversation_id,a.kind,v.id,v.source_kind,v.source_message_id,v.content_ref
		FROM agent_artifact a JOIN agent_conversation c ON c.id=a.conversation_id
		JOIN agent_artifact_version v ON v.artifact_id=a.id AND v.version=$2
		WHERE a.id=$1 AND c.workspace_id=$3 AND c.user_id=$4`,
		artifactID, version, ident(r.Context()).WorkspaceID, ident(r.Context()).UserID).
		Scan(&conversationID, &kind, &versionID, &sourceKind, &sourceMessageID, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	var content struct {
		Format       string `json:"format"`
		Text         string `json:"text"`
		AttachmentID string `json:"attachment_id"`
		Data         struct {
			Summary string `json:"summary"`
			Titles  []struct {
				Text string `json:"text"`
			} `json:"titles"`
		} `json:"data"`
		ObjectRef struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		} `json:"object_ref"`
	}
	if json.Unmarshal(raw, &content) != nil {
		return errNotFound
	}
	if content.ObjectRef.Type == "work" {
		workID, err := uuid.Parse(content.ObjectRef.ID)
		if err != nil {
			return errNotFound
		}
		var accountID uuid.UUID
		if err := s.db.QueryRow(r.Context(), `SELECT w.account_id FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, workID, ident(r.Context()).WorkspaceID).Scan(&accountID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errNotFound
			}
			return err
		}
		if _, err := s.visibleAccount(r.Context(), accountID); err != nil {
			return err
		}
	}
	var data []byte
	contentType := "text/plain; charset=utf-8"
	extension := format
	if format == "original" {
		if kind != "image" || sourceKind != "attachment" {
			return validation("此产物没有可下载的原文件")
		}
		attachmentID, err := uuid.Parse(content.AttachmentID)
		if err != nil {
			return errNotFound
		}
		var storagePath, imageMIME string
		err = s.db.QueryRow(r.Context(), `SELECT storage_path,mime FROM agent_attachment a
			WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND kind='image' AND parse_status='ready'
			AND EXISTS(SELECT 1 FROM agent_attachment_ref ref WHERE ref.attachment_id=a.id AND ref.conversation_id=$4
				AND (ref.artifact_version_id=$5 OR ref.message_id=$6))`,
			attachmentID, ident(r.Context()).WorkspaceID, ident(r.Context()).UserID, conversationID, versionID, sourceMessageID).Scan(&storagePath, &imageMIME)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		data, err = os.ReadFile(s.agentAttachmentFile(storagePath))
		if err != nil {
			return errNotFound
		}
		contentType = imageMIME
		if imageMIME == "image/jpeg" {
			extension = "jpg"
		} else if imageMIME == "image/png" {
			extension = "png"
		} else {
			return errNotFound
		}
	} else {
		text := content.Text
		if content.Format == "json" {
			text = content.Data.Summary
			if len(content.Data.Titles) > 0 {
				lines := make([]string, 0, len(content.Data.Titles))
				for _, title := range content.Data.Titles {
					lines = append(lines, title.Text)
				}
				text = strings.Join(lines, "\n")
			}
		}
		if text == "" || (content.Format != "text" && content.Format != "json") {
			return validation("此产物不支持所选文本下载格式")
		}
		if agentContainsSecret(text, s.agentSecretValues(r.Context(), ident(r.Context()).WorkspaceID)) {
			return validation("产物疑似含敏感凭据，不能下载")
		}
		if format == "csv" {
			if kind != "table" {
				return validation("只有表格产物可以下载 CSV")
			}
			table, _, err := agentReadArtifactTable(text)
			if err != nil {
				return err
			}
			records := append([][]string{table.Columns}, table.Rows...)
			for i := range records {
				for j := range records[i] {
					records[i][j] = agentCSVSafeCell(records[i][j])
				}
			}
			var encoded bytes.Buffer
			writer := csv.NewWriter(&encoded)
			if err := writer.WriteAll(records); err != nil {
				return err
			}
			data = encoded.Bytes()
			contentType = "text/csv; charset=utf-8"
		} else {
			data = []byte(text)
			if format == "md" {
				contentType = "text/markdown; charset=utf-8"
			}
		}
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": fmt.Sprintf("ops-artifact-v%d.%s", version, extension)}))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	_, err = w.Write(data)
	return err
}
