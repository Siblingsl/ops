package app

import (
	"context"
	"encoding/json"
)

type samplingConfig struct {
	Temperature *float64 `json:"temperature"`
}

func (s *Server) loadSampling(ctx context.Context) samplingConfig {
	var config samplingConfig
	if ident(ctx) == nil {
		return config
	}
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT value FROM app_setting WHERE workspace_id=$1 AND key='ai_sampling'`, ident(ctx).WorkspaceID).Scan(&raw); err == nil {
		_ = json.Unmarshal(raw, &config)
	}
	return config
}

func (s *Server) taskTemperature(ctx context.Context, task string, jsonMode bool) *float64 {
	if override := s.loadSampling(ctx).Temperature; override != nil {
		return override
	}
	value := 0.3
	switch task {
	case "title", "topic_suggest", "topic_hot_suggest", "hook_suggest":
		value = 0.9
	case "section_draft", "section_edit", "section_rewrite", "section_continue", "copilot_chat", "organize_notes":
		value = 0.7
	case "fact_flag":
		value = 0.2
	default:
		if jsonMode {
			value = 0.2
		}
	}
	return &value
}
