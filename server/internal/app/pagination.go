package app

import (
	"encoding/base64"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

const listPageSize = 50

type listCursor struct {
	CreatedAt time.Time
	ID        uuid.UUID
}

func parseListCursor(r *http.Request) (*listCursor, error) {
	raw := r.URL.Query().Get("cursor")
	if raw == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, validation("分页游标无效")
	}
	at, id, ok := strings.Cut(string(b), "|")
	if !ok {
		return nil, validation("分页游标无效")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return nil, validation("分页游标无效")
	}
	itemID, err := uuid.Parse(id)
	if err != nil {
		return nil, validation("分页游标无效")
	}
	return &listCursor{CreatedAt: createdAt, ID: itemID}, nil
}

func encodeListCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}
