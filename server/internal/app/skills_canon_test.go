package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// T-SK-35：C/H 规范向量覆盖键序、中文、emoji、控制转义、HTML 字符、LF。
func TestSkillCanonVector(t *testing.T) {
	c, err := canonJSON(map[string]any{"b": "<>&/\n", "a": "中😀"})
	if err != nil {
		t.Fatal(err)
	}
	if c != `{"a":"中😀","b":"<>&/\u000a"}` {
		t.Fatalf("C(v) = %q", c)
	}
	if h := mustCanonHash(t, map[string]any{"b": "<>&/\n", "a": "中😀"}); h != "32ef59ea492c258f2f5ba065bebbccab8aa775accc46aa804dbe55431e270abf" {
		t.Fatalf("H(v) = %s", h)
	}
	// 双引号与反斜杠转义；HTML 字符与 / 不转义。
	c2, err := canonJSON(map[string]any{"s": "a\"\\<>&/"})
	if err != nil {
		t.Fatal(err)
	}
	if c2 != `{"s":"a\"\\<>&/"}` {
		t.Fatalf("C2 = %q", c2)
	}
	// 键序按 UTF-8 字节序，递归生效。
	c3, err := canonJSON(map[string]any{"Z": 1, "a": 2, "中": 3, "B": map[string]any{"y": 1, "X": 2}})
	if err != nil {
		t.Fatal(err)
	}
	if c3 != `{"B":{"X":2,"y":1},"Z":1,"a":2,"中":3}` {
		t.Fatalf("C3 = %q", c3)
	}
	// 浮点数拒绝。
	if _, err := canonJSON(map[string]any{"f": 1.5}); err == nil {
		t.Fatal("float should be rejected")
	}
	// 非规范输入（键序不同）不产生不同指纹（T-SK-35）。
	h1 := mustCanonHash(t, map[string]any{"x": "a", "y": "b"})
	h2 := mustCanonHash(t, map[string]any{"y": "b", "x": "a"})
	if h1 != h2 {
		t.Fatal("key order changed fingerprint")
	}
}

func mustCanonHash(t *testing.T, v any) string {
	t.Helper()
	h, err := canonHash(v)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// T-SK-35：数组去重排序。
func TestSkillArrayNormalization(t *testing.T) {
	got := normalizeEnumArray([]string{"section_draft", "hook_suggest", "section_draft"})
	if strings.Join(got, ",") != "hook_suggest,section_draft" {
		t.Fatalf("got %v", got)
	}
	if got := normalizeEnumArray(nil); len(got) != 0 {
		t.Fatalf("nil should normalize to empty, got %v", got)
	}
}

// T-SK-35：跨平台有效组合交集校验（4.1.1 节第 3 项）。
func TestSkillComboValidation(t *testing.T) {
	if err := validateSkillCombos([]string{"wechat_mp", "xhs"}, []string{"long_article", "image_note"}); err != nil {
		t.Fatalf("valid combo rejected: %v", err)
	}
	if err := validateSkillCombos([]string{"xhs"}, []string{"long_article"}); err == nil {
		t.Fatal("[xhs]+[long_article] should be rejected")
	}
	if err := validateSkillCombos([]string{"xhs"}, nil); err != nil {
		t.Fatalf("empty formats with xhs should pass: %v", err)
	}
	if err := validateSkillCombos(nil, []string{"micro_post"}); err != nil {
		t.Fatalf("empty platforms with micro_post should pass: %v", err)
	}
	// 空平台展开为全部平台：image_note 与 xhs 组合有效 → 通过。
	if err := validateSkillCombos(nil, []string{"image_note"}); err != nil {
		t.Fatalf("image_note with expanded platforms should pass: %v", err)
	}
	if !skillMatchesTarget(SkillFields{Platforms: []string{"xhs"}, ContentFormats: []string{"image_note"}}, "xhs", "image_note") {
		t.Fatal("exact match should pass")
	}
	if skillMatchesTarget(SkillFields{Platforms: []string{"xhs"}}, "wechat_mp", "long_article") {
		t.Fatal("platform filter should reject")
	}
	if !skillMatchesTarget(SkillFields{}, "xhs", "image_note") {
		t.Fatal("empty conditions match everything legal")
	}
	if skillMatchesTarget(SkillFields{}, "xhs", "long_article") {
		t.Fatal("illegal platform-format pair must not match")
	}
}

// T-SK-35 / 5.2.1：四个指纹确定性、排序口径与覆盖范围。
func TestSkillFingerprints(t *testing.T) {
	acc := uuid.New()
	aud := uuid.New()
	t1 := mustSkillTime(t, "2026-10-24T08:00:00.123456Z")
	t2 := mustSkillTime(t, "2026-10-24T08:00:05.000001Z")
	b1 := skillBindingFinger{BindingID: uuid.New(), SkillID: uuid.New(), Priority: 100, CreatedAt: t1}
	b2 := skillBindingFinger{BindingID: uuid.New(), SkillID: uuid.New(), Priority: 50, CreatedAt: t2}
	// bindings 按 skill UUID 升序：交换输入顺序指纹不变。
	fpA, err := skillPartitionFingerprint(acc, &aud, []skillBindingFinger{b1, b2})
	if err != nil {
		t.Fatal(err)
	}
	fpB, err := skillPartitionFingerprint(acc, &aud, []skillBindingFinger{b2, b1})
	if err != nil {
		t.Fatal(err)
	}
	if fpA != fpB || !strings.HasPrefix(fpA, "sb1:") || len(fpA) != len("sb1:")+64 {
		t.Fatalf("sb1 order/format: %s vs %s", fpA, fpB)
	}
	// priority 变化改变指纹。
	b1x := b1
	b1x.Priority = 99
	fpC, _ := skillPartitionFingerprint(acc, &aud, []skillBindingFinger{b1x, b2})
	if fpC == fpA {
		t.Fatal("priority must be covered")
	}
	// audience 为 nil（公共分区）与有值产生不同指纹。
	fpPub, _ := skillPartitionFingerprint(acc, nil, nil)
	fpMine, _ := skillPartitionFingerprint(acc, &aud, nil)
	if fpPub == fpMine {
		t.Fatal("nil audience must differ")
	}
	// 纳秒差异被 RFC3339 六位小数口径吸收。
	b1y := b1
	b1y.CreatedAt = t1.Add(100 * time.Nanosecond)
	fpD, _ := skillPartitionFingerprint(acc, &aud, []skillBindingFinger{b1y, b2})
	if fpD != fpA {
		t.Fatal("sub-microsecond jitter must not change fingerprint")
	}

	token, err := skillImpactToken(acc, 3, "update", []skillImpactBinding{
		{BindingID: uuid.New(), AccountID: acc, AudienceUID: nil, Priority: 1, CreatedAt: t1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, "si1:") {
		t.Fatalf("si1 format: %s", token)
	}
	tokenDel, err := skillImpactToken(acc, 3, "delete", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token == tokenDel {
		t.Fatal("action must be covered by the token")
	}

	fields := SkillFields{Name: "名", Summary: "s", Triggers: "t", Instructions: "body",
		Platforms: []string{"xhs"}, ContentFormats: []string{"image_note"}, TaskTypes: []string{"title"},
		TaskEnabled: true, AgentEnabled: false, Status: "active"}
	ch := skillContentHash(fields)
	if !strings.HasPrefix(ch, "sk1:") {
		t.Fatalf("sk1 format: %s", ch)
	}
	if skillContentHash(fields) != ch {
		t.Fatal("content hash unstable")
	}
	// status 变化改变哈希；内容不含归属与修订。
	fields3 := fields
	fields3.Status = "disabled"
	if skillContentHash(fields3) == ch {
		t.Fatal("status must be covered")
	}

	digest, err := skillPublishDigest("create", nil, "workspace", nil, fields)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(digest, "sp1:") {
		t.Fatalf("sp1 format: %s", digest)
	}
	digestUpd, err := skillPublishDigest("update", &acc, "account", &acc, fields)
	if err != nil {
		t.Fatal(err)
	}
	if digest == digestUpd {
		t.Fatal("operation/skill_id must be covered")
	}
	// 字段内容变化改变公开摘要。
	fields4 := fields
	fields4.Summary = "s2"
	d2, _ := skillPublishDigest("create", nil, "workspace", nil, fields4)
	if d2 == digest {
		t.Fatal("digest must cover fields")
	}
}

func mustSkillTime(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatal(err)
	}
	return tm
}

// T-SK-39（SK1 前置）：内置注册表 8 项、key/UUID 唯一、确定性 UUID 全实例一致。
func TestSkillBuiltinRegistry(t *testing.T) {
	if len(builtinSkills) != 8 {
		t.Fatalf("want 8 builtins, got %d", len(builtinSkills))
	}
	seen := map[uuid.UUID]bool{}
	for _, b := range builtinSkills {
		id := skillBuiltinUUID(b.Key)
		if seen[id] {
			t.Fatalf("duplicate builtin uuid %s", b.Key)
		}
		seen[id] = true
		if id != skillBuiltinUUID(b.Key) {
			t.Fatal("uuid must be deterministic")
		}
		def := skillBuiltinByKey(b.Key)
		if def == nil || def.Revision != b.Version || def.Origin != "builtin" || def.SourceKey != b.Key {
			t.Fatalf("registry lookup failed for %s", b.Key)
		}
		if def.Fields.Status != "active" || !def.Fields.TaskEnabled || !def.Fields.AgentEnabled {
			t.Fatalf("builtin %s defaults", b.Key)
		}
		if err := validateSkillFields(&def.Fields); err != nil {
			t.Fatalf("builtin %s fields invalid: %v", b.Key, err)
		}
		if err := checkBuiltinRegistry(); err != nil {
			t.Fatal(err)
		}
	}
	// 未知 key 拒绝解析（退役语义由解析器给 builtin_retired）。
	if skillBuiltinByKey("builtin:retired_demo") != nil {
		t.Fatal("unknown key must not resolve")
	}
	// 第 13.1 节任务配置抽查。
	if got := skillBuiltinByKey("builtin:hook_opening").Fields.TaskTypes; strings.Join(got, ",") != "hook_suggest,section_draft" {
		t.Fatalf("hook_opening tasks: %v", got)
	}
	if got := skillBuiltinByKey("builtin:natural_ending").Fields.TaskTypes; strings.Join(got, ",") != "read_through,section_edit" {
		t.Fatalf("natural_ending tasks: %v", got)
	}
	if got := skillBuiltinByKey("builtin:xhs_note_voice").Fields.Platforms; strings.Join(got, ",") != "xhs" {
		t.Fatalf("xhs_note_voice platforms: %v", got)
	}
	// 内置不入 skill 表（第 13 节）：确定性 UUID 在数据库中不存在任何定义行。
	for _, b := range builtinSkills {
		var n int
		if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM skill WHERE id=$1`, b.UUID()).Scan(&n); err != nil || n != 0 {
			t.Fatalf("builtin %s must not exist in the skill table: %d %v", b.Key, n, err)
		}
	}
	// 默认不绑定（第 13 节）：全新工作区没有任何内置绑定行。
	var bn int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM skill_binding WHERE builtin_key <> ''`).Scan(&bn); err != nil || bn != 0 {
		t.Fatalf("builtins must not be bound by default: %d %v", bn, err)
	}
	// 快照测试只按实际文档修订更新（T-SK-39）：内置正文必须与注册表逐字一致（自一致基线）。
	for _, b := range builtinSkills {
		def := skillBuiltinByKey(b.Key)
		if def.Fields.Instructions != b.Fields.Instructions {
			t.Fatalf("builtin %s body drifted from the registry", b.Key)
		}
		if runeLen(b.Fields.Instructions) > skillInstructionLimit {
			t.Fatalf("builtin %s body exceeds 1200 chars", b.Key)
		}
	}
}
