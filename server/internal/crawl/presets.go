package crawl

// PresetSource 是公开、合法的 RSS / Atom 模板。模板只读，不落库、不发起请求；
// 用户在前端一键填入后，仍需自行保存并勾选才会进入采集。
type PresetSource struct {
	Key         string `json:"key"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	Category    string `json:"category"`
	Description string `json:"description"`
}

// PresetRSSSources 返回内置的 5 个中文公开内容源模板。
func PresetRSSSources() []PresetSource {
	return []PresetSource{
		{
			Key:         "preset:rss:36kr",
			Kind:        "rss",
			Name:        "36氪",
			URL:         "https://36kr.com/feed",
			Category:    "商业与科技",
			Description: "创业与科技商业资讯，适合观察行业新动向。",
		},
		{
			Key:         "preset:rss:sspai",
			Kind:        "rss",
			Name:        "少数派",
			URL:         "https://sspai.com/feed",
			Category:    "效率与数字生活",
			Description: "数字工具、效率方法与生活方式选题来源。",
		},
		{
			Key:         "preset:rss:ifanr",
			Kind:        "rss",
			Name:        "爱范儿",
			URL:         "https://www.ifanr.com/feed",
			Category:    "数码与消费趋势",
			Description: "消费电子、数码产品与前沿体验报道。",
		},
		{
			Key:         "preset:rss:ruanyifeng",
			Kind:        "rss",
			Name:        "阮一峰的网络日志",
			URL:         "https://www.ruanyifeng.com/blog/atom.xml",
			Category:    "技术与科技周刊",
			Description: "技术随笔与每周科技动态聚合，适合技术类账号。",
		},
		{
			Key:         "preset:rss:huxiu",
			Kind:        "rss",
			Name:        "虎嗅网",
			URL:         "https://www.huxiu.com/rss/0.xml",
			Category:    "商业观察",
			Description: "商业与公司观察，适合商业分析与观点类内容。",
		},
	}
}
