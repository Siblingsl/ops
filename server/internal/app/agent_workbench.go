package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const agentWorkbenchFeatureEnv = "OPS_AGENT_WORKBENCH_FEATURES"

var agentWorkbenchFeatureNames = []string{
	"workbench_ui", "conversation_organize", "context_refs", "skill_requests", "artifacts",
	"run_control", "event_resume", "plans", "goals", "routines", "document_parse",
}

func agentFeaturesFromList(raw string) map[string]bool {
	features := make(map[string]bool, len(agentWorkbenchFeatureNames))
	for _, name := range agentWorkbenchFeatureNames {
		features[name] = false
	}
	for _, name := range strings.Split(raw, ",") {
		name = strings.TrimSpace(name)
		if _, ok := features[name]; ok {
			features[name] = true
		}
	}
	return features
}

func agentWorkbenchFeatures() map[string]bool {
	features := agentFeaturesFromList(os.Getenv(agentWorkbenchFeatureEnv))
	if features["goals"] && (!features["event_resume"] || !features["run_control"] || !features["plans"]) {
		features["goals"] = false
	}
	if features["routines"] && (!features["event_resume"] || !features["run_control"] || !features["plans"] || !features["goals"] || !features["artifacts"]) {
		features["routines"] = false
	}
	return features
}

func requireAgentFeature(name string) error {
	if agentWorkbenchFeatures()[name] {
		return nil
	}
	return apiErr(409, "agent_feature_unavailable", "该工作台功能尚未开放")
}

func agentRequestPayloadHash(payload any) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// claimAgentRequest must run in the same transaction as the operation it protects.
// A replay returns its original resource ID; no request or secret-bearing response is persisted.
func claimAgentRequest(ctx context.Context, tx pgx.Tx, workspaceID, userID uuid.UUID,
	operation string, requestID uuid.UUID, payload any) (*uuid.UUID, error) {
	hash, err := agentRequestPayloadHash(payload)
	if err != nil {
		return nil, err
	}
	key := []any{workspaceID, userID, operation, requestID}
	tag, err := tx.Exec(ctx, `INSERT INTO agent_request
		(workspace_id,user_id,operation,request_id,payload_hash,expires_at)
		VALUES ($1,$2,$3,$4,$5,now()+interval '24 hours')
		ON CONFLICT (workspace_id,user_id,operation,request_id) DO NOTHING`,
		key[0], key[1], key[2], key[3], hash)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 1 {
		return nil, nil
	}
	tag, err = tx.Exec(ctx, `UPDATE agent_request SET payload_hash=$5, resource_id=NULL,
		created_at=now(), expires_at=now()+interval '24 hours'
		WHERE workspace_id=$1 AND user_id=$2 AND operation=$3 AND request_id=$4 AND expires_at<=now()`,
		key[0], key[1], key[2], key[3], hash)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 1 {
		return nil, nil
	}
	resource, err := lookupAgentRequest(ctx, tx, workspaceID, userID, operation, requestID, hash)
	if err == nil && resource == nil {
		return nil, fmt.Errorf("agent request reservation disappeared")
	}
	return resource, err
}

type agentRequestReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func lookupAgentRequest(ctx context.Context, reader agentRequestReader, workspaceID, userID uuid.UUID,
	operation string, requestID uuid.UUID, payloadHash string) (*uuid.UUID, error) {
	var existingHash, resourceID string
	err := reader.QueryRow(ctx, `SELECT payload_hash,COALESCE(resource_id::text,'') FROM agent_request
		WHERE workspace_id=$1 AND user_id=$2 AND operation=$3 AND request_id=$4 AND expires_at>now()`,
		workspaceID, userID, operation, requestID).Scan(&existingHash, &resourceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if existingHash != payloadHash {
		return nil, apiErr(409, "agent_request_conflict", "请求编号已用于不同内容，请刷新后重新操作")
	}
	if resourceID == "" {
		return nil, apiErr(409, "agent_request_conflict", "相同请求仍在处理中，请先查询当前状态")
	}
	parsed, err := uuid.Parse(resourceID)
	if err != nil {
		return nil, fmt.Errorf("invalid agent request resource id: %w", err)
	}
	return &parsed, nil
}

func completeAgentRequest(ctx context.Context, tx pgx.Tx, workspaceID, userID uuid.UUID,
	operation string, requestID, resourceID uuid.UUID) error {
	tag, err := tx.Exec(ctx, `UPDATE agent_request SET resource_id=$5
		WHERE workspace_id=$1 AND user_id=$2 AND operation=$3 AND request_id=$4`,
		workspaceID, userID, operation, requestID, resourceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("agent request reservation disappeared")
	}
	return nil
}
