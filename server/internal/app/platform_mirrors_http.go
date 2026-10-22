package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) getPlatformAccountSnapshot(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	id := ident(r.Context())
	var snapshot map[string]any
	var displayName, publicID, avatar, bio, verifiedType, remoteType *string
	var safeFields, fieldStates []byte
	var revision int64
	var observedAt time.Time
	var adapterVersion string
	var mappingVersion int
	err = s.db.QueryRow(r.Context(), `SELECT display_name,public_account_id,avatar_ref,bio,verified_type,remote_account_type,
		safe_fields,field_states,revision,observed_at,adapter_version,mapping_version
		FROM platform_account_snapshot WHERE account_id=$1 AND workspace_id=$2`, accountID, id.WorkspaceID).Scan(
		&displayName, &publicID, &avatar, &bio, &verifiedType, &remoteType, &safeFields, &fieldStates, &revision, &observedAt, &adapterVersion, &mappingVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, map[string]any{"snapshot": nil, "state": "not_synced"})
	}
	if err != nil {
		return err
	}
	var safe any
	var states any
	_ = json.Unmarshal(safeFields, &safe)
	_ = json.Unmarshal(fieldStates, &states)
	snapshot = map[string]any{"account_id": accountID, "display_name": displayName, "public_account_id": publicID,
		"avatar_ref": avatar, "bio": bio, "verified_type": verifiedType, "remote_account_type": remoteType,
		"safe_fields": safe, "field_states": states, "revision": revision, "observed_at": observedAt,
		"adapter_version": adapterVersion, "mapping_version": mappingVersion}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"snapshot": snapshot, "state": "available"})
}

func (s *Server) listPlatformWorkMirrors(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	var platform string
	if err := s.db.QueryRow(r.Context(), `SELECT platform FROM platform_account WHERE id=$1 AND workspace_id=$2`, accountID, ident(r.Context()).WorkspaceID).Scan(&platform); err != nil {
		return err
	}
	column := platformExternalIDColumn(platform)
	limit := queryInt(r, "limit", 20)
	if limit < 1 || limit > 100 {
		return validation("limit 必须在 1～100 之间")
	}
	cursor, err := parseListCursor(r)
	if err != nil {
		return err
	}
	contentType := strings.TrimSpace(r.URL.Query().Get("content_type"))
	if contentType != "" && !validMirrorContentType(contentType) {
		return validation("content_type 筛选值无效")
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && !validRemoteStatus(status) {
		return validation("status 筛选值无效")
	}
	contentState := strings.TrimSpace(r.URL.Query().Get("content_state"))
	if contentState != "" && !validMirrorState(contentState) {
		return validation("content_state 筛选值无效")
	}
	bound := strings.TrimSpace(r.URL.Query().Get("bound"))
	if bound != "" && bound != "true" && bound != "false" {
		return validation("bound 必须是 true 或 false")
	}
	q := queryText(r, "q")
	boundExpr := "TRUE"
	boundProjection := "FALSE"
	if column != "" {
		boundProjection = `EXISTS (SELECT 1 FROM work w WHERE w.account_id=m.account_id AND w.deleted_at IS NULL
			AND w.` + column + `=m.external_id AND w.platform_binding_source IN ('user_link','user_confirm','official_exact'))`
		if bound == "true" {
			boundExpr = "EXISTS"
		} else if bound == "false" {
			boundExpr = "NOT EXISTS"
		}
		if boundExpr == "EXISTS" || boundExpr == "NOT EXISTS" {
			boundExpr += ` (SELECT 1 FROM work w WHERE w.account_id=m.account_id AND w.deleted_at IS NULL
				AND w.` + column + `=m.external_id AND w.platform_binding_source IN ('user_link','user_confirm','official_exact'))`
		}
	} else if bound == "true" {
		boundExpr = "FALSE"
	}
	query := `SELECT m.id,m.external_id,m.remote_content_type,m.remote_status,m.title,m.summary,m.cover_ref,m.canonical_url,
		m.published_at,m.remote_updated_at,m.content_state,m.content_error_code,m.field_coverage,m.last_seen_at,
		m.content_observed_at,m.revision,m.created_at,` + boundProjection + ` AS is_bound,
		latest_metric.as_of_at,latest_metric.observed_at
		FROM platform_work_mirror m
		LEFT JOIN LATERAL (SELECT as_of_at,observed_at FROM platform_metric_observation o
			WHERE o.workspace_id=m.workspace_id AND o.account_id=m.account_id AND o.external_account_key=m.external_account_key
			AND o.external_id=m.external_id AND o.scope='work' ORDER BY o.observed_at DESC,o.id DESC LIMIT 1) latest_metric ON TRUE
		WHERE m.workspace_id=$1 AND m.account_id=$2
		AND ($3='' OR m.remote_content_type=$3) AND ($4='' OR m.remote_status=$4) AND ($5='' OR m.content_state=$5)
		AND ($6='' OR m.title ILIKE '%'||$6||'%')
		AND ($7='' OR ` + boundExpr + `)
		AND ($8::timestamptz IS NULL OR (m.created_at,m.id)<($8,$9))
		ORDER BY m.created_at DESC,m.id DESC LIMIT $10`
	rows, err := s.db.Query(r.Context(), query, ident(r.Context()).WorkspaceID, accountID, contentType, status, contentState, q, bound, cursorTime(cursor), cursorID(cursor), limit+1)
	if err != nil {
		return err
	}
	items := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var externalID, remoteType, remoteStatus, title, summary string
		var cover, canonical, errorCode *string
		var publishedAt, remoteUpdatedAt, contentObservedAt *time.Time
		var contentState string
		var fieldCoverage []byte
		var lastSeen time.Time
		var revision int64
		var createdAt time.Time
		var isBound bool
		var latestMetricAsOf, latestMetricObserved *time.Time
		if err := rows.Scan(&id, &externalID, &remoteType, &remoteStatus, &title, &summary, &cover, &canonical, &publishedAt, &remoteUpdatedAt, &contentState, &errorCode, &fieldCoverage, &lastSeen, &contentObservedAt, &revision, &createdAt, &isBound, &latestMetricAsOf, &latestMetricObserved); err != nil {
			rows.Close()
			return err
		}
		var coverage any
		_ = json.Unmarshal(fieldCoverage, &coverage)
		items = append(items, map[string]any{"id": id, "external_id": externalID, "remote_content_type": remoteType, "remote_status": remoteStatus,
			"title": title, "summary": summary, "cover_ref": cover, "canonical_url": canonical, "published_at": publishedAt,
			"remote_updated_at": remoteUpdatedAt, "content_state": contentState, "content_error_code": errorCode,
			"field_coverage": coverage, "last_seen_at": lastSeen, "content_observed_at": contentObservedAt, "revision": revision,
			"created_at": createdAt.UTC().Format(time.RFC3339Nano), "is_bound": isBound,
			"latest_metric_as_of_at": latestMetricAsOf, "latest_metric_observed_at": latestMetricObserved})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var next *string
	if len(items) > limit {
		last := items[limit-1]
		at, _ := time.Parse(time.RFC3339Nano, last["created_at"].(string))
		id := last["id"].(uuid.UUID)
		value := encodeListCursor(at, id)
		next = &value
		items = items[:limit]
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"items": items, "next_cursor": next})
}

func (s *Server) getPlatformWorkMirror(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	mirrorID, err := pathID(r, "platformWorkId")
	if err != nil {
		return err
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	var platform, externalKey, externalID, remoteType, remoteStatus, title, bodyText, summary, authorDisplay string
	var bodyStructure, topics, tags, mediaRefs, coverage []byte
	var cover, canonical, contentHash, errorCode *string
	var publishedAt, remoteUpdatedAt, contentObservedAt *time.Time
	var contentState string
	var contentRevision int
	var revision int64
	var lastSeen, createdAt time.Time
	var operationID, sourceRunID *uuid.UUID
	err = s.db.QueryRow(r.Context(), `SELECT platform,external_account_key,external_id,remote_content_type,remote_status,title,body_text,author_display,
		body_structure,summary,topics,tags,cover_ref,media_refs,canonical_url,published_at,remote_updated_at,content_hash,
		content_revision,revision,field_coverage,content_state,content_error_code,content_observed_at,last_seen_at,
		last_sync_operation_id,source_run_id,created_at FROM platform_work_mirror
		WHERE id=$1 AND workspace_id=$2 AND account_id=$3`, mirrorID, ident(r.Context()).WorkspaceID, accountID).Scan(
		&platform, &externalKey, &externalID, &remoteType, &remoteStatus, &title, &bodyText, &authorDisplay, &bodyStructure, &summary, &topics, &tags,
		&cover, &mediaRefs, &canonical, &publishedAt, &remoteUpdatedAt, &contentHash, &contentRevision, &revision, &coverage,
		&contentState, &errorCode, &contentObservedAt, &lastSeen, &operationID, &sourceRunID, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	var structure, topicValues, tagValues, media, fieldCoverage any
	for raw, target := range map[string]*any{"structure": &structure, "topics": &topicValues, "tags": &tagValues, "media": &media, "coverage": &fieldCoverage} {
		var data []byte
		switch raw {
		case "structure":
			data = bodyStructure
		case "topics":
			data = topics
		case "tags":
			data = tags
		case "media":
			data = mediaRefs
		default:
			data = coverage
		}
		_ = json.Unmarshal(data, target)
	}
	metrics := []map[string]any{}
	obs, err := s.db.Query(r.Context(), `SELECT id,source,observed_at,as_of_at,window_start,window_end,temporal_kind,values,
		field_paths,adapter_version,mapping_version,quality_state,match_state FROM platform_metric_observation
		WHERE workspace_id=$1 AND account_id=$2 AND external_account_key=$3 AND external_id=$4 AND scope='work'
		ORDER BY observed_at DESC,id DESC LIMIT 100`, ident(r.Context()).WorkspaceID, accountID, externalKey, externalID)
	if err != nil {
		return err
	}
	for obs.Next() {
		var id uuid.UUID
		var source, temporal, quality, match, adapter string
		var observed time.Time
		var asOf, start, end *time.Time
		var values, paths []byte
		var mapping int
		if err := obs.Scan(&id, &source, &observed, &asOf, &start, &end, &temporal, &values, &paths, &adapter, &mapping, &quality, &match); err != nil {
			obs.Close()
			return err
		}
		var metricValues, fieldPaths any
		_ = json.Unmarshal(values, &metricValues)
		_ = json.Unmarshal(paths, &fieldPaths)
		metrics = append(metrics, map[string]any{"id": id, "source": source, "observed_at": observed, "as_of_at": asOf, "window_start": start, "window_end": end,
			"temporal_kind": temporal, "values": metricValues, "field_paths": fieldPaths, "adapter_version": adapter, "mapping_version": mapping, "quality_state": quality, "match_state": match})
	}
	obs.Close()
	if err := obs.Err(); err != nil {
		return err
	}
	column := platformExternalIDColumn(platform)
	bindings := []map[string]any{}
	if column != "" {
		rows, err := s.db.Query(r.Context(), `SELECT id,title,status,published_at,metric_binding_revision,publish_revision
		FROM work WHERE account_id=$1 AND deleted_at IS NULL AND `+column+`=$2
		AND platform_binding_source IN ('user_link','user_confirm','official_exact') ORDER BY id`, accountID, externalID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id uuid.UUID
			var title, status string
			var publishedAt *time.Time
			var bindingRevision int
			var publishRevision *int
			if err := rows.Scan(&id, &title, &status, &publishedAt, &bindingRevision, &publishRevision); err != nil {
				rows.Close()
				return err
			}
			bindings = append(bindings, map[string]any{"work_id": id, "title": title, "status": status, "published_at": publishedAt, "binding_revision": bindingRevision, "publish_revision": publishRevision})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	}
	item := map[string]any{"id": mirrorID, "account_id": accountID, "platform": platform, "external_account_key": externalKey, "external_id": externalID,
		"remote_content_type": remoteType, "remote_status": remoteStatus, "title": title, "body_text": bodyText, "author_display": authorDisplay, "body_structure": structure,
		"summary": summary, "topics": topicValues, "tags": tagValues, "cover_ref": cover, "media_refs": media, "canonical_url": canonical,
		"published_at": publishedAt, "remote_updated_at": remoteUpdatedAt, "content_hash": contentHash, "content_revision": contentRevision,
		"revision": revision, "field_coverage": fieldCoverage, "content_state": contentState, "content_error_code": errorCode,
		"content_observed_at": contentObservedAt, "last_seen_at": lastSeen, "last_sync_operation_id": operationID, "source_run_id": sourceRunID,
		"created_at": createdAt, "is_bound": len(bindings) > 0, "bindings": bindings, "metric_observations": metrics}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"work": item})
}

func validMirrorContentType(value string) bool {
	switch value {
	case "image_note", "video_note", "wechat_article", "toutiao_article", "toutiao_micro_post", "unknown":
		return true
	}
	return false
}
func validRemoteStatus(value string) bool {
	switch value {
	case "published", "draft", "reviewing", "hidden", "deleted", "unknown":
		return true
	}
	return false
}
