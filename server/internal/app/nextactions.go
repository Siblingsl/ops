package app

import (
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
)

// 智能下一步（EX-B-01）：纯规则，不用 AI。排序：阻塞发布 > 时效性 > 进行中 > 新任务；同一作品只出现一条。

type NextAction struct {
	Kind   string     `json:"kind"`
	Text   string     `json:"text"`
	Action string     `json:"action"`
	Link   string     `json:"link"`
	WorkID *uuid.UUID `json:"work_id,omitempty"`
	Score  float64    `json:"score"`
}

type naWork struct {
	ID                uuid.UUID
	Title             string
	Status            string
	UpdatedAt         time.Time
	PublishedAt       *time.Time
	PlannedDate       *time.Time
	OutlineConfirmed  bool
	Viewpoint         bool
	EmptySections     []uuid.UUID
	MetricCount       int
	OpenTodos         int
	ReviewPending     bool
	PushedOrPacked    bool
	PendingCheckItems int
}

type naInput struct {
	Now               time.Time
	AccountID         uuid.UUID
	Platform          string
	Works             []naWork
	AdoptedNotStarted int
	FirstAdoptedTopic *uuid.UUID
	PendingDaily      int
	PendingMemories   int
	WriteEndingFirst  bool
}

const (
	naBlocking = 400.0
	naTimely   = 300.0
	naProgress = 200.0
	naNew      = 100.0
)

func days(now, t time.Time) int { return int(now.Sub(t).Hours() / 24) }

func titleOr(t string) string { return "《" + nz(t, "未命名作品") + "》" }

// nextActions ranks candidate actions and returns at most limit, one per work.
func nextActions(in naInput, limit int) []NextAction {
	best := map[uuid.UUID]NextAction{}
	var extra []NextAction
	offer := func(id uuid.UUID, a NextAction) {
		wid := id
		a.WorkID = &wid
		if cur, ok := best[id]; !ok || a.Score > cur.Score {
			best[id] = a
		}
	}
	acc := "/a/" + in.AccountID.String()
	publish := "/push"
	if in.Platform == "xhs" {
		publish = "/pack"
	}
	for _, w := range in.Works {
		link := "/works/" + w.ID.String()
		idle := days(in.Now, w.UpdatedAt)
		switch w.Status {
		case "ready":
			d := idle
			offer(w.ID, NextAction{Kind: "push", Score: naBlocking + float64(min(d, 10))*5,
				Text: fmt.Sprintf("%s已检查通过 %d 天，还没写入草稿或生成发布包", titleOr(w.Title), d), Action: "去推送", Link: link + publish})
		case "reviewing":
			offer(w.ID, NextAction{Kind: "review", Score: naBlocking - 10, Text: titleOr(w.Title) + "等待审阅", Action: "去审阅", Link: link + "/check"})
		case "checking":
			offer(w.ID, NextAction{Kind: "check", Score: naProgress + 20, Text: fmt.Sprintf("%s检查中，还有 %d 项待处理", titleOr(w.Title), w.PendingCheckItems),
				Action: "去处理", Link: link + "/check"})
		case "drafting":
			if len(w.EmptySections) > 0 && w.OutlineConfirmed {
				target := w.EmptySections[0]
				if in.WriteEndingFirst {
					target = w.EmptySections[len(w.EmptySections)-1]
				}
				offer(w.ID, NextAction{Kind: "draft", Score: naProgress - float64(min(idle, 30))*2,
					Text: fmt.Sprintf("%s还差 %d 段没起草", titleOr(w.Title), len(w.EmptySections)), Action: "继续写", Link: link + "#section-" + target.String()})
			} else if !w.Viewpoint || !w.OutlineConfirmed {
				offer(w.ID, NextAction{Kind: "draft", Score: naProgress - 20 - float64(min(idle, 30))*2,
					Text: titleOr(w.Title) + "还没确认观点和大纲", Action: "继续写", Link: link})
			}
		}
		if w.PlannedDate != nil && (w.Status == "drafting" || w.Status == "checking") {
			left := int(w.PlannedDate.Sub(truncDay(in.Now)).Hours() / 24)
			if left <= 1 {
				when := "明天"
				switch {
				case left < 0:
					when = fmt.Sprintf("%d 天前", -left)
				case left == 0:
					when = "今天"
				}
				offer(w.ID, NextAction{Kind: "planned", Score: naTimely + 50 - float64(left)*10,
					Text: fmt.Sprintf("%s计划%s发布，还在创作中", titleOr(w.Title), when), Action: "继续写", Link: link})
			}
		}
		if w.PushedOrPacked && w.PublishedAt != nil {
			d := days(in.Now, *w.PublishedAt)
			for _, mark := range []int{7, 3, 1} {
				if d >= mark && w.MetricCount < metricExpected(mark) {
					offer(w.ID, NextAction{Kind: "metrics", Score: naTimely + float64(mark),
						Text: fmt.Sprintf("%s发布已满 %d 天，录入数据可以让复盘更准", titleOr(w.Title), mark), Action: "去录入", Link: acc + "/review?work=" + w.ID.String()})
					break
				}
			}
		}
		// Open back-office todos stay listed alongside the work's other action until every item is ticked (EX-I-01).
		if w.PushedOrPacked && w.OpenTodos > 0 {
			wid := w.ID
			extra = append(extra, NextAction{Kind: "todos", WorkID: &wid, Score: naTimely - 20,
				Text: fmt.Sprintf("%s后台待办还剩 %d 项", titleOr(w.Title), w.OpenTodos), Action: "去勾选", Link: link + publish})
		}
	}
	if in.AdoptedNotStarted > 0 {
		a := NextAction{Kind: "topic", Score: naNew, Text: fmt.Sprintf("选题池里有 %d 个已采用的选题还没开始写", in.AdoptedNotStarted), Action: "开始写第一个", Link: acc + "/topics"}
		if in.FirstAdoptedTopic != nil {
			a.Link = acc + "/topics?start=" + in.FirstAdoptedTopic.String()
		}
		extra = append(extra, a)
	}
	if in.PendingDaily > 0 {
		extra = append(extra, NextAction{Kind: "daily", Score: naNew + 10, Text: fmt.Sprintf("今天还有 %d 条推荐未处理", in.PendingDaily), Action: "选择今天写什么", Link: acc + "/ops"})
	}
	if in.PendingMemories > 0 {
		extra = append(extra, NextAction{Kind: "memory", Score: naNew - 10, Text: fmt.Sprintf("AI 学到了 %d 条新偏好，等你确认", in.PendingMemories), Action: "去确认", Link: acc + "/profile?tab=memory"})
	}
	list := extra
	for _, a := range best {
		list = append(list, a)
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Score != list[j].Score {
			return list[i].Score > list[j].Score
		}
		return list[i].Text < list[j].Text
	})
	if len(list) > limit {
		list = list[:limit]
	}
	return list
}

// metricExpected is how many data entries are expected by day 1 / 3 / 7 (EX-J-01).
func metricExpected(day int) int {
	switch day {
	case 1:
		return 1
	case 3:
		return 2
	default:
		return 3
	}
}

func truncDay(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}
