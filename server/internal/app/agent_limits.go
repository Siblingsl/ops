package app

import "time"

// 智能体运行限额（16 文档第 6.5 节）。上限集中在这里，并由 GET /agent/bootstrap 返回给前端显示；
// 修改上限需要在 90 文档登记。
const (
	// agentMaxRounds 每次运行的模型轮次上限，超出时运行以 reason=round_limit 结束。
	agentMaxRounds = 12
	// agentMaxReads 每次运行 R 工具调用上限（不含 get_context、load_tool_domain、make_link 与卡片预览读取）。
	agentMaxReads = 30
	// agentMaxGenerates 每次运行 G 工具调用上限。
	agentMaxGenerates = 3
	// agentMaxCards 每次运行提出的卡片上限。
	agentMaxCards = 5
	// agentRunSeconds 每次运行的总时长上限，当前轮结束后运行停止，reason=deadline。
	agentRunSeconds = 300
	// agentMaxContinuations 连续自动续跑上限，达到后返回 429 agent_limit_reached。
	agentMaxContinuations = 10
	// agentMessageChars 单条用户消息的字数上限。
	agentMessageChars = 8000
	// agentAttachmentsPerMessage 每条消息的附件数上限（其中最多 4 张图片发送给模型）。
	agentAttachmentsPerMessage = 6
	// agentImageBytes 单张图片附件的字节上限（20 MB）。
	agentImageBytes = 20971520
	// agentTextBytes 单个文本附件的字节上限（1 MB）。
	agentTextBytes = 1048576
	// agentGenerateTimeout 单个 G 工具调用的超时，超时返回工具错误 timeout。
	agentGenerateTimeout = 90 * time.Second
	// agentMaxInvalidCalls 连续无效工具调用（未知工具、参数无效、角色不可见）上限，超出时运行失败。
	agentMaxInvalidCalls = 3
	// agentMaxRunsPerUser 每个用户同时运行数上限（跨对话），超出返回 429 agent_limit_reached。
	agentMaxRunsPerUser = 2
	// agentMaxOutputTokens 单轮模型输出上限，超出截断并记录 finish_reason。
	agentMaxOutputTokens = 4096
	// agentMaxImagesToModel 每条消息中发送给模型的图片数上限。
	agentMaxImagesToModel = 4
	// agentSummaryLimit 对话摘要的字数上限（第 6.8 节第 3 项）。
	agentSummaryLimit = 2000
	// agentWindowChars 窗口外历史消息超过该长度时才触发摘要压缩（第 6.8 节第 3 项）。
	agentWindowChars = 40000
	// agentTitleChars 新对话自动标题的取字上限（第 6.8 节第 4 项）。
	agentTitleChars = 30
	// agentMessagePage 对话详情一次返回的消息条数。
	agentMessagePage = 50
	// agentMaxDomains 同时加载的工具领域数上限（第 3.3 节第 1 项）。
	agentMaxDomains = 3
)

// agentLimits 是 GET /agent/bootstrap 返回给前端的限额（16 文档第 11.2 节）。
type agentLimits struct {
	MaxRounds             int   `json:"max_rounds"`
	MaxReads              int   `json:"max_reads"`
	MaxGenerates          int   `json:"max_generates"`
	MaxCards              int   `json:"max_cards"`
	RunSeconds            int   `json:"run_seconds"`
	MaxContinuations      int   `json:"max_continuations"`
	MessageChars          int   `json:"message_chars"`
	AttachmentsPerMessage int   `json:"attachments_per_message"`
	ImageBytes            int64 `json:"image_bytes"`
	TextBytes             int64 `json:"text_bytes"`
}

func agentLimitsPayload() agentLimits {
	return agentLimits{
		MaxRounds:             agentMaxRounds,
		MaxReads:              agentMaxReads,
		MaxGenerates:          agentMaxGenerates,
		MaxCards:              agentMaxCards,
		RunSeconds:            agentRunSeconds,
		MaxContinuations:      agentMaxContinuations,
		MessageChars:          agentMessageChars,
		AttachmentsPerMessage: agentAttachmentsPerMessage,
		ImageBytes:            agentImageBytes,
		TextBytes:             agentTextBytes,
	}
}
