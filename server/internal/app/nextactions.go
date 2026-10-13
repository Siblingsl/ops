package app

import (
	"fmt"
	"sort"
	"strings"
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
	ContentFormat     string
	HasSections       bool
	ImagesReady       bool
	OpenTodos         int
	PushedOrPacked    bool
	PendingCheckItems int
	// DueNode is the day-1/3/7/30 data node this published work is in and still lacks (same rule as DR04 reminders).
	DueNode *int
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
	// DEV-UX02: workspace-level items for the dashboard main line.
	AIMissing    bool
	IsOwner      bool
	Unmatched    int
	DraftPending int
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
			} else if w.HasSections && w.ContentFormat != "comic" && w.ContentFormat != "card_post" {
				action := NextAction{Kind: "layout", Score: naProgress - float64(min(idle, 30))*2,
					Text: titleOr(w.Title) + "正文已写好，下一步排版检查", Action: "去排版检查", Link: link + "/preview?next=check"}
				if in.Platform == "xhs" {
					action.Link = link + "/check?start=1"
				}
				if strings.TrimSpace(w.Title) == "" {
					action.Kind, action.Text, action.Action, action.Link = "title", titleOr(w.Title)+"正文已写好，还没有标题", "去拟标题", link+"#step-title"
				} else if !w.ImagesReady {
					action.Kind, action.Text, action.Action, action.Link = "cover", titleOr(w.Title)+"正文已写好，还缺封面或图片", "去配封面", link+"#step-images"
					if in.Platform == "xhs" {
						action.Action = "去配图"
					}
				}
				offer(w.ID, action)
			}
		}
		if w.PlannedDate != nil && (w.Status == "drafting" || w.Status == "checking") {
			left := int(w.PlannedDate.Sub(truncDay(in.Now)).Hours() / 24)
			if left <= 1 {
				plannedLink := link
				if next, ok := best[w.ID]; ok && (next.Kind == "title" || next.Kind == "cover" || next.Kind == "layout") {
					plannedLink = next.Link
				}
				when := "明天"
				switch {
				case left < 0:
					when = fmt.Sprintf("%d 天前", -left)
				case left == 0:
					when = "今天"
				}
				offer(w.ID, NextAction{Kind: "planned", Score: naTimely + 50 - float64(left)*10,
					Text: fmt.Sprintf("%s计划%s发布，还在创作中", titleOr(w.Title), when), Action: "继续写", Link: plannedLink})
			}
		}
		if w.DueNode != nil {
			n := *w.DueNode
			offer(w.ID, NextAction{Kind: "metrics", Score: naTimely + float64(min(n, 7)),
				Text: fmt.Sprintf("%s发布已满 %d 天，录入第 %d 天数据可以让复盘更准", titleOr(w.Title), n, n), Action: "去录入",
				Link: fmt.Sprintf("%s/review?work=%s&node=%d", acc, w.ID, n)})
		}
		if (w.Status == "pushed" || w.Status == "packed") && idle >= 1 {
			where := "已写入草稿箱"
			if w.Status == "packed" {
				where = "已生成发布包"
			}
			offer(w.ID, NextAction{Kind: "publish", Score: naTimely - 30 + float64(min(idle, 10)),
				Text: fmt.Sprintf("%s%s %d 天，在平台发布后回来标记已发布", titleOr(w.Title), where, idle), Action: "去回填", Link: link + publish})
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
		extra = append(extra, NextAction{Kind: "memory", Score: naNew - 10, Text: fmt.Sprintf("AI 学到了 %d 条新偏好，等你确认（确认前不影响生成）", in.PendingMemories), Action: "去确认", Link: acc + "/profile?tab=memory"})
	}
	if in.AIMissing {
		a := NextAction{Kind: "setup", Score: naBlocking + 200, Text: "还没有配置模型，AI 功能暂时不能用（写作、检查和推送不受影响）", Action: "快速配置", Link: "/settings/models"}
		if !in.IsOwner {
			a.Text, a.Action = "工作区还没有配置模型，请所有者在「设置 → 模型配置」里配置", "查看"
		}
		extra = append(extra, a)
	}
	if in.Unmatched > 0 {
		extra = append(extra, NextAction{Kind: "unmatched", Score: naTimely - 40, Text: fmt.Sprintf("公众号数据里有 %d 篇文章没对上作品，逐条指定后才计入复盘", in.Unmatched), Action: "去指定", Link: acc + "/review"})
	}
	if in.DraftPending > 0 {
		extra = append(extra, NextAction{Kind: "report", Score: naNew + 5, Text: fmt.Sprintf("每周复盘草稿里还有 %d 条选题建议没处理", in.DraftPending), Action: "去看看", Link: acc + "/review"})
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

func truncDay(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}
