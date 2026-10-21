package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// DEV-PS22 补充：指标读取的模块边界静态检查（20 文档 §8.4）。
//
// §8.4 要求"新增静态检查禁止指标模块外直接查 `metric_snapshot`/`work_metric_d7`"。
// 目的不是消灭所有直接查询——写入/修订/CAS 路径必须直查——而是防止**新的消费读取**
// 绕过统一投影入口 `metric_node_public`，那样会漏掉 held/superseded 过滤和单位字段。
//
// 边界按"文件职责"划分：下列文件属于指标存储/投影/导出层，允许直查；
// 其余文件若出现只读消费式查询，需要先登记到 metricReadAllowlist 并说明理由。

// metricStorageFiles 是指标存储、投影、质量状态与导出层——它们**必须**直查底层表。
var metricStorageFiles = map[string]string{
	"metric_projection.go":  "统一投影入口与来源排序的实现处",
	"metric_quality.go":     "质量状态机（held/approved/superseded）的 upsert 与 CAS",
	"review.go":             "指标录入/更正/删除的写入与回读（含 FOR UPDATE）",
	"publish_correction.go": "发布更正时按作品回读全部指标",
	"r4.go":                 "Markdown 导出，需要全部历史而不能只取每来源一条",
	"platform_gray.go":      "诊断计数（自动采用率），统计而非取值",
	"insights.go":           "节点覆盖判断与提醒（已按 §8.4 只计 approved）",
}

// metricD7LegacyConsumers 是仍在用 `work_metric_d7` 的旧消费点。
//
// **这些是真实遗留，不是已核准的例外。** §8.4 要求把清单内文件迁到 `metric_node_public`，
// 迁移完成前它们用 `work_metric_d7` 属于过渡状态。之所以允许它们通过静态检查：
// 该视图自 00050 起**已含** `quality_state='approved'` 过滤与 `read_unit`/`share_unit`，
// 因此不会漏掉质量过滤或单位字段——缺的只是"按节点参数化"的能力。
//
// 每迁走一个就从这里删掉；删空即表示 §8.4 的消费点迁移完成。
// 新增条目必须写明理由，且不能是为了绕过检查而把消费逻辑挪进新文件。
var metricD7LegacyConsumers = map[string]string{
	"brief.go":           "账号区间汇总（sum(reads)）；需按节点取数，待迁移",
	"daily_candidates.go": "候选池统计；待迁移",
	"daily_stats.go":     "账号日均表现（avg reads/likes）；待迁移",
	"perf_context.go":    "绩效样本上下文；待迁移",
	"review_loop.go":     "复盘循环筛选；待迁移",
	"smart.go":           "智能建议的表现排序；待迁移",
	"strategy.go":        "策略生成的表现依据；待迁移",
}

// metricReadAllowlist 是额外的已审核例外：文件 → 理由。
// 新增条目必须在这里写明为什么不能走 metric_node_public。
var metricReadAllowlist = map[string]string{}

// TestMetricReadsStayInsideStorageLayer 检查指标底层表只被存储/投影层与已登记旧消费点直查。
//
// 检测的是"消费式读取"：`FROM metric_snapshot` / `JOIN metric_snapshot` / `work_metric_d7`。
// 写入语句（INSERT/UPDATE/DELETE）不在本检查范围。
func TestMetricReadsStayInsideStorageLayer(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var violations []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		if _, ok := metricStorageFiles[name]; ok {
			continue
		}
		if _, ok := metricD7LegacyConsumers[name]; ok {
			continue
		}
		if _, ok := metricReadAllowlist[name]; ok {
			continue
		}
		src, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatal(err)
		}
		text := string(src)
		for _, marker := range []string{"FROM metric_snapshot", "JOIN metric_snapshot", "work_metric_d7"} {
			if strings.Contains(text, marker) {
				violations = append(violations, name+" 出现 "+marker)
			}
		}
	}
	if len(violations) > 0 {
		t.Fatalf("指标底层表只允许在存储/投影层与已登记旧消费点直查（20 文档 §8.4），以下文件越界：\n  %s\n"+
			"若确属必要，请加入 metricReadAllowlist 并写明不能走 metric_node_public 的理由。",
			strings.Join(violations, "\n  "))
	}
}

// TestMetricStorageFilesExist 防止清单与源码脱节：
// 文件被改名/删除后，清单里的条目必须同步清理，否则会悄悄放出越界。
func TestMetricStorageFilesExist(t *testing.T) {
	for name := range metricStorageFiles {
		if _, err := os.Stat(name); err != nil {
			t.Errorf("metricStorageFiles 里的 %s 已不存在，请同步清理清单", name)
		}
	}
	for name := range metricReadAllowlist {
		if _, err := os.Stat(name); err != nil {
			t.Errorf("metricReadAllowlist 里的 %s 已不存在，请同步清理清单", name)
		}
	}
	for name := range metricD7LegacyConsumers {
		if _, err := os.Stat(name); err != nil {
			t.Errorf("metricD7LegacyConsumers 里的 %s 已不存在，请同步清理清单", name)
		}
	}
}

// TestMetricD7LegacyConsumersActuallyUseIt 防止清单变成"永久豁免"：
// 登记为旧消费点的文件必须真的还在用 work_metric_d7；迁走后条目要删掉，
// 否则清单会一直膨胀、掩盖真实进度。
func TestMetricD7LegacyConsumersActuallyUseIt(t *testing.T) {
	for name, reason := range metricD7LegacyConsumers {
		if strings.TrimSpace(reason) == "" {
			t.Errorf("%s 必须写明未迁移的理由", name)
		}
		src, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(src), "work_metric_d7") {
			t.Errorf("%s 已不再使用 work_metric_d7，请从 metricD7LegacyConsumers 删除该条目", name)
		}
	}
}
