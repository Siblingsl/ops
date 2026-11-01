package app

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestCXReviewReportContentEditPreservesIndicesAndUsesCAS(t *testing.T) {
	account := cxReviewCreateAccount(t, "xhs", "image_note")
	workRef := "work:" + uuid.NewString() + ":revision:1"
	metricRef := "metric:" + uuid.NewString() + ":revision:1"
	content := ReviewContent{ContentFormat: "image_note", Conclusions: []string{"旧结论"},
		TopicSuggestions: []ReviewTopicSuggestion{{Title: "选题一", Angle: "角度一", Reason: "依据一"},
			{Title: "选题二", Angle: "角度二", Reason: "依据二"}, {Title: "选题三", Angle: "角度三", Reason: "依据三"}},
		WritingInsights: []string{"旧写作经验"}, CXBasis: json.RawMessage(`{"source_refs":["` + workRef + `","` + metricRef + `"]}`),
		AnalysisV2: &CXReviewAnalysisV2{SchemaVersion: 1,
			Observations: []cxReviewObservation{{Finding: "旧事实", SourceRefs: []string{metricRef}}},
			Hypotheses:   []cxReviewHypothesis{{Explanation: "旧解释", SourceRefs: []string{workRef}, Counterevidence: []string{"反例"}, Confounders: []string{"混杂"}}},
			Experiments:  []cxReviewExperimentProposal{{Hypothesis: "旧假设", Variable: "title", MetricKey: "favorite_rate", Window: "T7", SelectionProposal: "后续验证"}},
			Limitations:  []cxReviewLimitation{{Code: "low_sample", Message: "样本较少"}}}}
	contentJSON, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	var reportID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO review_report(account_id,work_ids,content,adopted,origin)
		VALUES($1,$2,$3,$4,'manual') RETURNING id`, account.ID, []uuid.UUID{}, contentJSON, []int32{0}).Scan(&reportID); err != nil {
		t.Fatal(err)
	}
	status, body := env.do("GET", "/api/v1/accounts/"+account.ID.String()+"/reviews", nil)
	if status != 200 {
		t.Fatalf("list report: status=%d body=%s", status, body)
	}
	var reports []ReviewReport
	if err := json.Unmarshal(body, &reports); err != nil || len(reports) != 1 {
		t.Fatalf("decode report: reports=%d err=%v body=%s", len(reports), err, body)
	}
	baseRevision := reports[0].ContentRevision
	if baseRevision == "" {
		t.Fatal("report list must include the edit CAS revision")
	}

	invalidJSON, _ := json.Marshal(reports[0].Content)
	var invalid ReviewContent
	if err := json.Unmarshal(invalidJSON, &invalid); err != nil {
		t.Fatal(err)
	}
	invalid.AnalysisV2.Observations[0].SourceRefs = []string{"work:foreign:revision:1"}
	status, body = env.do("PATCH", "/api/v1/review-reports/"+reportID.String()+"/content", map[string]any{"base_revision": baseRevision, "content": invalid})
	if status != 422 {
		t.Fatalf("foreign source ref must be rejected: status=%d body=%s", status, body)
	}

	edited := reports[0].Content
	edited.Conclusions[0] = "已校订的结论"
	edited.TopicSuggestions[0] = ReviewTopicSuggestion{Title: "已校订的选题", Angle: "明确角度", Reason: "仍需逐项确认"}
	edited.AnalysisV2.Observations[0].Finding = "用户校订后的观察"
	edited.CXBasis = json.RawMessage(`{"source_refs":[]}`)
	status, body = env.do("PATCH", "/api/v1/review-reports/"+reportID.String()+"/content", map[string]any{"base_revision": baseRevision, "content": edited})
	if status != 200 {
		t.Fatalf("edit report: status=%d body=%s", status, body)
	}
	var saved ReviewReport
	if err := json.Unmarshal(body, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.ContentRevision == baseRevision || saved.Content.Conclusions[0] != "已校订的结论" || saved.Content.TopicSuggestions[0].Title != "已校订的选题" ||
		saved.Content.AnalysisV2.Observations[0].Finding != "用户校订后的观察" || !strings.Contains(string(saved.Content.CXBasis), workRef) ||
		len(saved.Adopted) != 1 || saved.Adopted[0] != 0 {
		t.Fatalf("edited content must persist without moving adoption indices: %+v", saved)
	}
	status, body = env.do("PATCH", "/api/v1/review-reports/"+reportID.String()+"/content", map[string]any{"base_revision": baseRevision, "content": edited})
	if status != 409 || !strings.Contains(string(body), "version_conflict") {
		t.Fatalf("stale edit must return 409: status=%d body=%s", status, body)
	}
}
