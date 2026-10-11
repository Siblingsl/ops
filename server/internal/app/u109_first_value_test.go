package app

import "testing"

// 首条推荐依赖模型和方案，不把风格样本、素材或完整档案变成前置门槛。
func TestU109FirstValueWithoutCompleteness(t *testing.T) {
	_, path := v4Account(t, "首次推荐最短路径")
	env.expectErr(t, "POST", path+"/daily/regenerate", nil, "state_invalid")
	opts, _ := positioningOptions(t, path)
	f := opts[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "off"}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	var daily Daily
	env.mustJSON(t, "POST", path+"/daily/regenerate", nil, &daily)
	if len(daily.Items) == 0 {
		t.Fatal("没有素材和样本时最短路径无法生成推荐")
	}
	for _, item := range daily.Items {
		if item.Format != "image_note" || len(item.Basis) == 0 {
			t.Fatalf("类型或依据无效: %+v", item)
		}
	}
}
