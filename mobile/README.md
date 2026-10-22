# OPS 小红书分享伴侣（FR-M10-08）

官方「小红书分享开放平台 / 分享 SDK」需要单独申请移动应用与资质（见决策 D-009）。本目录提供 **Expo** 骨架：用系统分享把标题/正文交给小红书 App，图片仍用发布包 zip；拿到 SDK 后可在此替换为官方 Share API。

## 本地运行

```bash
cd mobile
npm install
npx expo start
```

在手机 Expo Go 中打开；主站发布包页可「复制伴侣深链」，用 `ops-xhs://import?...` 填入标题/正文/话题，或手动粘贴后点「系统分享」。

## 与主站衔接

- 主站发布包页：系统分享 / 复制、伴侣深链、zip 下载（发布由用户完成）。
- 深链格式：`ops-xhs://import?title=...&body=...&topics=...`（URL 编码）。
- 移动伴侣当前负责内容带入与系统分享，最终发布由用户完成；采集与逆向的项目文档技术口径见 D-127。

## 接入官方 SDK（后续）

1. 申请小红书开放平台应用与分享能力。
2. 使用官方 SDK 的分享接口替换 `Share.share`。
3. 在 `app.json` 填入 AppID / Universal Link 等配置。
