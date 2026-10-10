package app

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// CheckFormats 运行 D-048 第 6 节要求的只读对账：检查账号、方案、大纲槽位、选题、
// 每日推荐与作品之间的类型不一致。只查询、不修改任何数据；不一致项按界面行为给出
// 处理建议（待采用/待开写项会被拦截提示，旧作品按自身快照保留可访问）。
func CheckFormats(ctx context.Context, pool *pgxpool.Pool) error {
	printRows := func(title, emptyHint, layout string, query string) error {
		fmt.Println("== " + title + " ==")
		rows, err := pool.Query(ctx, query)
		if err != nil {
			return err
		}
		defer rows.Close()
		n := 0
		for rows.Next() {
			vals, err := rows.Values()
			if err != nil {
				return err
			}
			args := make([]any, len(vals))
			for i, v := range vals {
				args[i] = v
			}
			fmt.Printf("  "+layout+"\n", args...)
			n++
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if n == 0 {
			fmt.Println("  " + emptyHint)
		}
		return nil
	}

	if err := printRows("运营方案", "全部方案的作品形态与账号类型一致",
		"账号 %s（%s）版本 v%d [%s]：方案形态 %s ≠ 账号类型 %s —— 请在运营页调整方案后重新启用",
		`SELECT a.name, a.platform, s.version, s.status, s.cadence->>'format', a.content_format
		FROM account_strategy s JOIN platform_account a ON a.id=s.account_id
		WHERE s.status <> 'archived' AND coalesce(s.cadence->>'format','') <> '' AND s.cadence->>'format' <> a.content_format
		ORDER BY a.name, s.version`); err != nil {
		return err
	}

	if err := printRows("内容大纲槽位", "全部槽位与账号类型一致",
		"账号 %s 槽位 %s [%s]：形态 %s ≠ 账号类型 %s —— 采用会被拦截，请重新启用方案重建大纲",
		`SELECT a.name, to_char(sl.date,'YYYY-MM-DD'), sl.status, sl.format, a.content_format
		FROM account_plan_slot sl JOIN platform_account a ON a.id=sl.account_id
		WHERE sl.format <> '' AND sl.format <> a.content_format ORDER BY sl.date LIMIT 50`); err != nil {
		return err
	}

	if err := printRows("选题", "全部选题与账号类型一致",
		"账号 %s 选题「%s」[%s]：预计形态 %s ≠ 账号类型 %s —— 开写会被拦截，请编辑选题卡或放弃",
		`SELECT a.name, t.title, t.status, t.format, a.content_format
		FROM topic t JOIN platform_account a ON a.id=t.account_id
		WHERE t.deleted_at IS NULL AND coalesce(t.format,'') <> '' AND t.format <> a.content_format
		ORDER BY t.status, t.created_at DESC LIMIT 50`); err != nil {
		return err
	}

	if err := printRows("每日推荐", "全部推荐条目与账号类型一致",
		"账号 %s 推荐 %s v%d：有 %d 条跨类型条目 —— 采用/开写会被拦截，请换一个或重新生成",
		`SELECT a.name, to_char(d.date,'YYYY-MM-DD'), d.version,
		(SELECT count(*) FROM jsonb_array_elements(d.items) it WHERE coalesce(it->>'format','') <> '' AND it->>'format' <> a.content_format)
		FROM daily_recommendation d JOIN platform_account a ON a.id=d.account_id
		WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(d.items) it WHERE coalesce(it->>'format','') <> '' AND it->>'format' <> a.content_format)
		ORDER BY d.date DESC LIMIT 20`); err != nil {
		return err
	}

	if err := printRows("历史作品（仅提示，按快照保留可访问）", "没有与账号当前类型不同的历史作品",
		"账号 %s：%d 篇历史作品形态（%s–%s）与账号当前类型不同",
		`SELECT a.name, count(*), min(w.content_format), max(w.content_format)
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.deleted_at IS NULL AND w.content_format <> a.content_format GROUP BY a.name ORDER BY a.name`); err != nil {
		return err
	}

	fmt.Println("对账完成：以上为只读报告，未修改任何数据。")
	return nil
}
