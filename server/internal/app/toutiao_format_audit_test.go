package app

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestToutiaoFormatAuditPreservesMixedSourcesAndOldPlatformWarnings(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		platform, format string
		warnings         int
	}{{"toutiao", "micro_post", 0}, {"toutiao", "comic", 3}, {"xhs", "long_article", 3}} {
		a := drAccount(t, tc.platform, "audit-"+tc.platform+"-"+uuid.NewString())
		// 对账是有界的全库报告，夹具排在窗口前，避免被其他回归数据挤出。
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO topic(account_id,title,format,status,created_at) VALUES($1,'待开写',$2,'adopted',now()+interval '1 day')`, a.ID, tc.format); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO account_plan_slot(account_id,date,pillar,format) VALUES($1,'1900-01-01','观察',$2)`, a.ID, tc.format); err != nil {
			t.Fatal(err)
		}
		items, _ := json.Marshal([]map[string]string{{"title": "旧推荐", "format": tc.format}})
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO daily_recommendation(account_id,date,items,trigger) VALUES($1,current_date+1,$2,'manual')`, a.ID, items); err != nil {
			t.Fatal(err)
		}
		if tc.warnings == 0 {
			env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"content_format": tc.format}, nil)
		}
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		original := os.Stdout
		os.Stdout = writer
		output := make(chan string, 1)
		go func() {
			data, _ := io.ReadAll(reader)
			output <- string(data)
		}()
		err = CheckFormats(ctx, env.srv.db)
		os.Stdout = original
		_ = writer.Close()
		report := <-output
		_ = reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		reported := strings.Count(report, "账号 "+a.Name)
		if reported != tc.warnings {
			t.Fatalf("%s/%s 对账预期 %d 项告警，得到 %d：\n%s", tc.platform, tc.format, tc.warnings, reported, report)
		}
	}
}
