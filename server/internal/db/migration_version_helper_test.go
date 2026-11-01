package db

import (
	"path"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// latestMigrationVersion 返回嵌入 migrations 目录的最高版本号，
// 避免迁移测试硬编码版本号在每次新增迁移后过期（如 00085 引入时 79 断言失败）。
func latestMigrationVersion(t *testing.T) int64 {
	t.Helper()
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		entries, err = migrations.ReadDir(".")
	}
	if err != nil {
		t.Fatal(err)
	}
	versions := []int64{}
	for _, entry := range entries {
		base := path.Base(entry.Name())
		if !strings.HasSuffix(base, ".sql") {
			continue
		}
		num := strings.SplitN(base, "_", 2)[0]
		v, err := strconv.ParseInt(num, 10, 64)
		if err != nil {
			continue
		}
		versions = append(versions, v)
	}
	if len(versions) == 0 {
		t.Fatal("no migrations found")
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] > versions[j] })
	return versions[0]
}

