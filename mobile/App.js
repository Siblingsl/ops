import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { Button, Linking, SafeAreaView, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native'

/**
 * FR-M10-08 伴侣：系统分享到小红书（或任意 App）。
 * 深链：ops-xhs://import?title=&body=&topics=（主站发布包页可复制）
 * 接入官方分享 SDK 前，用系统 Share Sheet 完成「人在小红书里点发布」。
 */
function parseImportURL(url) {
  if (!url || typeof url !== 'string') return null
  try {
    const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
    if (!q) return null
    const params = {}
    for (const part of q.split('&')) {
      const i = part.indexOf('=')
      if (i < 0) continue
      const k = decodeURIComponent(part.slice(0, i))
      const v = decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '))
      params[k] = v
    }
    if (!params.title && !params.body && !params.topics) return null
    return {
      title: params.title || '',
      body: params.body || '',
      topics: params.topics || '',
    }
  } catch {
    return null
  }
}

export default function App() {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [topics, setTopics] = useState('')
  const [fromLink, setFromLink] = useState(false)

  const applyImport = (data) => {
    if (!data) return
    setTitle(data.title)
    setBody(data.body)
    setTopics(data.topics)
    setFromLink(true)
  }

  useEffect(() => {
    const onUrl = ({ url }) => applyImport(parseImportURL(url))
    Linking.getInitialURL().then((url) => applyImport(parseImportURL(url)))
    const sub = Linking.addEventListener('url', onUrl)
    return () => sub.remove()
  }, [])

  const share = async () => {
    const message = [title.trim(), body.trim(), topics.trim()].filter(Boolean).join('\n\n')
    if (!message) return
    await Share.share({ message, title: title.trim() || '小红书笔记' })
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.pad}>
        <Text style={styles.h1}>OPS 分享伴侣</Text>
        <Text style={styles.sub}>
          移动分享伴侣仅支持小红书文案整理与系统分享，不会代发或回写发布记录；公众号和头条请在主站使用复制/分享功能。
        </Text>
        {fromLink ? <Text style={styles.badge}>已从深链填入</Text> : null}
        <Text style={styles.label}>标题</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="笔记标题" />
        <Text style={styles.label}>正文</Text>
        <TextInput style={[styles.input, styles.area]} value={body} onChangeText={setBody} multiline placeholder="正文" />
        <Text style={styles.label}>话题</Text>
        <TextInput style={styles.input} value={topics} onChangeText={setTopics} placeholder="#话题A #话题B" />
        <View style={styles.btn}>
          <Button title="系统分享（选小红书）" onPress={share} />
        </View>
        <Text style={styles.note}>图片请在主站下载 zip 后导入相册，再在小红书按编号选择。</Text>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f7f5f2' },
  pad: { padding: 20, gap: 8 },
  h1: { fontSize: 22, fontWeight: '700', color: '#1c1917', marginBottom: 4 },
  sub: { fontSize: 13, color: '#78716c', marginBottom: 12, lineHeight: 20 },
  badge: { alignSelf: 'flex-start', backgroundColor: '#ecfdf5', color: '#047857', fontSize: 12, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, overflow: 'hidden', marginBottom: 4 },
  label: { fontSize: 12, fontWeight: '600', color: '#57534e', marginTop: 8 },
  input: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e7e5e4', padding: 12, fontSize: 15 },
  area: { minHeight: 160, textAlignVertical: 'top' },
  btn: { marginTop: 16 },
  note: { marginTop: 16, fontSize: 12, color: '#a8a29e', lineHeight: 18 },
})
