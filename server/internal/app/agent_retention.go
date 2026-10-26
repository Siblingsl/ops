package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

// 智能体数据的保留与清理（16 文档第 9.7 节）。挂入 jobs.go 的每日循环，每批最多 5000 行（D-111）。

type agentCleanupStats struct {
	ExpiredActions   int
	Attachments      int
	ExpiredEvents    int
	OldConversations int
	Abandoned        int
}

func (s *Server) runAgentCleanup(ctx context.Context) {
	key := "agent-cleanup:" + s.today().Format("2006-01-02")
	var done bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM job_marker WHERE key=$1)`, key).Scan(&done); err != nil {
		slog.Error("读取智能体清理标记失败", "err", err)
		return
	}
	if done {
		return
	}
	stats, err := s.purgeAgentData(ctx)
	if err != nil {
		slog.Error("清理智能体数据失败", "err", err)
		return
	}
	if !s.markOnce(ctx, key) {
		slog.Warn("记录智能体清理标记失败")
		return
	}
	if stats.ExpiredActions+stats.Attachments+stats.ExpiredEvents+stats.OldConversations+stats.Abandoned > 0 {
		slog.Info("智能体数据清理完成", "expired_actions", stats.ExpiredActions,
			"attachments", stats.Attachments, "expired_event_deltas", stats.ExpiredEvents, "old_conversations", stats.OldConversations,
			"abandoned_conversations", stats.Abandoned)
	}
}

func (s *Server) purgeAgentData(ctx context.Context) (agentCleanupStats, error) {
	stats := agentCleanupStats{}
	// 1. pending / needs_input 卡片超过 24 小时改为 expired（第 5.9 节第 2 项）。
	n, err := s.execAgentBatch(ctx, agentExpireActions)
	if err != nil {
		return stats, err
	}
	stats.ExpiredActions = n

	// 2. 未被引用的附件超过 24 小时删除（含磁盘文件）。
	n, err = s.purgeAgentAttachments(ctx)
	if err != nil {
		return stats, err
	}
	stats.Attachments = n

	// 3. 高频文字增量只保留 7 天；事件序号水位随删除一起推进，旧游标会收到410。
	stats.ExpiredEvents, err = s.purgeExpiredAgentDeltaEvents(ctx)
	if err != nil {
		return stats, err
	}

	// 4. last_message_at 超过 365 天的对话删除（级联删除消息、运行、卡片与附件记录）。
	n, err = s.deleteAgentConversations(ctx, agentDeleteOldConversations, s.now().AddDate(0, 0, -365))
	if err != nil {
		return stats, err
	}
	stats.OldConversations = n

	// 5. 用户已不是该工作区成员超过 30 天的对话删除。成员移除不记录时间戳，用对话的最后消息时间代理。
	n, err = s.deleteAgentConversations(ctx, agentDeleteAbandonedConversations, s.now().AddDate(0, 0, -30))
	if err != nil {
		return stats, err
	}
	stats.Abandoned = n
	return stats, nil
}

func (s *Server) purgeExpiredAgentDeltaEvents(ctx context.Context) (int, error) {
	total := 0
	for {
		tx, err := s.db.Begin(ctx)
		if err != nil {
			return total, err
		}
		rows, err := tx.Query(ctx, `WITH expired AS (
			SELECT conversation_id,event_seq FROM agent_event
			WHERE type='message.delta' AND expires_at<=now()
			ORDER BY expires_at,conversation_id,event_seq LIMIT 5000 FOR UPDATE SKIP LOCKED
		)
		DELETE FROM agent_event e USING expired x
		WHERE e.conversation_id=x.conversation_id AND e.event_seq=x.event_seq
		RETURNING e.conversation_id,e.event_seq`)
		if err != nil {
			tx.Rollback(ctx)
			return total, err
		}
		floors := map[uuid.UUID]int64{}
		batch := 0
		for rows.Next() {
			var conversationID uuid.UUID
			var seq int64
			if err := rows.Scan(&conversationID, &seq); err != nil {
				rows.Close()
				tx.Rollback(ctx)
				return total, err
			}
			if seq > floors[conversationID] {
				floors[conversationID] = seq
			}
			batch++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			tx.Rollback(ctx)
			return total, err
		}
		rows.Close()
		for conversationID, floor := range floors {
			if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET event_retention_floor=greatest(event_retention_floor,$2)
				WHERE id=$1`, conversationID, floor); err != nil {
				tx.Rollback(ctx)
				return total, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return total, err
		}
		total += batch
		if batch < 5000 {
			return total, nil
		}
	}
}

// execAgentBatch 反复执行一条「每批最多 5000 行、返回删除/更新行数」的语句，直到没有命中行。
func (s *Server) execAgentBatch(ctx context.Context, query string) (int, error) {
	total := 0
	for {
		var n int
		if err := s.db.QueryRow(ctx, query).Scan(&n); err != nil {
			return total, err
		}
		if n == 0 {
			return total, nil
		}
		total += n
	}
}

func (s *Server) purgeAgentAttachments(ctx context.Context) (int, error) {
	total := 0
	for {
		var (
			n     int
			paths []string
		)
		if err := s.db.QueryRow(ctx, agentDeleteOrphanAttachments).Scan(&n, &paths); err != nil {
			return total, err
		}
		s.removeAgentFiles(paths)
		total += n
		if n == 0 {
			return total, nil
		}
	}
}

func (s *Server) deleteAgentConversations(ctx context.Context, query string, cutoff time.Time) (int, error) {
	total := 0
	for {
		var (
			n     int
			paths []string
		)
		if err := s.db.QueryRow(ctx, query, cutoff).Scan(&n, &paths); err != nil {
			return total, err
		}
		s.removeAgentFiles(paths)
		total += n
		if n == 0 {
			return total, nil
		}
	}
}

const agentExpireActions = `
WITH batch AS MATERIALIZED (
	SELECT id FROM agent_action
	WHERE status IN ('pending','needs_input') AND expires_at < now()
	ORDER BY expires_at, id LIMIT 5000 FOR UPDATE SKIP LOCKED
), updated AS (
	UPDATE agent_action a SET status='expired' FROM batch b WHERE a.id=b.id RETURNING 1
)
SELECT count(*) FROM updated`

const agentDeleteOrphanAttachments = `
WITH batch AS MATERIALIZED (
	SELECT id FROM agent_attachment
	WHERE referenced = false AND created_at < now() - interval '24 hours'
	ORDER BY created_at, id LIMIT 5000 FOR UPDATE SKIP LOCKED
), deleted AS (
	DELETE FROM agent_attachment a USING batch b WHERE a.id=b.id RETURNING a.storage_path
)
SELECT count(*), coalesce(array_agg(storage_path), '{}') FROM deleted`

const agentDeleteOldConversations = `
WITH batch AS MATERIALIZED (
	SELECT id FROM agent_conversation
	WHERE last_message_at < $1
	ORDER BY last_message_at, id LIMIT 5000 FOR UPDATE SKIP LOCKED
), files AS MATERIALIZED (
	SELECT a.storage_path FROM agent_attachment a WHERE a.conversation_id IN (SELECT id FROM batch)
), deleted AS (
	DELETE FROM agent_conversation c USING batch b WHERE c.id=b.id AND (SELECT count(*) FROM files) >= 0 RETURNING 1
)
SELECT (SELECT count(*) FROM deleted), coalesce((SELECT array_agg(storage_path) FROM files), '{}')`

const agentDeleteAbandonedConversations = `
WITH batch AS MATERIALIZED (
	SELECT c.id FROM agent_conversation c
	WHERE c.last_message_at < $1 AND NOT EXISTS (
		SELECT 1 FROM workspace_member m
		WHERE m.workspace_id = c.workspace_id AND m.user_id = c.user_id AND m.status = 'active')
	ORDER BY c.last_message_at, c.id LIMIT 5000 FOR UPDATE OF c SKIP LOCKED
), files AS MATERIALIZED (
	SELECT a.storage_path FROM agent_attachment a WHERE a.conversation_id IN (SELECT id FROM batch)
), deleted AS (
	DELETE FROM agent_conversation c USING batch b WHERE c.id=b.id AND (SELECT count(*) FROM files) >= 0 RETURNING 1
)
SELECT (SELECT count(*) FROM deleted), coalesce((SELECT array_agg(storage_path) FROM files), '{}')`
