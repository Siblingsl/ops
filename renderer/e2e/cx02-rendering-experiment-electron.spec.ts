import { _electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Q-CX-02 真实 Electron 验证两套模板、三种比例、透明图、中文与 DPR', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', 'Q-CX-02 需要锁定的 Windows Electron 44')
  test.skip(process.env.OPS_E2E_PROD === '1', '该实验加载本地 html-to-image 候选与模拟页面')
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'ops-qcx02-raster-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let probeServer: ReturnType<typeof createServer> | undefined
  let probeRequests = 0
  try {
    app = await _electron.launch({
      executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! },
      timeout: 60_000,
    })
    const page = await app.firstWindow()
    const origin = baseURL ?? 'http://127.0.0.1:5287'
    await page.goto(`${origin}/login`)
    await app.evaluate(async ({ BrowserWindow }, businessOrigin: string) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith(businessOrigin))
      if (!window) throw new Error('business window was not found')
      const contents = window.webContents
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
      await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 2, mobile: true, scale: 1,
        screenWidth: 390, screenHeight: 844,
      })
    }, origin)
    console.log(`Q-CX-02 Electron viewport: ${JSON.stringify(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screen: [screen.width, screen.height], visual: [visualViewport?.width, visualViewport?.height, visualViewport?.scale] })))}`)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390)
    expect(await page.evaluate(() => devicePixelRatio)).toBeCloseTo(2, 5)

    const matrix = await page.evaluate(async () => {
      const load = new Function('return import("/node_modules/html-to-image/es/index.js")') as () => Promise<{ toBlob: (node: HTMLElement, options?: Record<string, unknown>) => Promise<Blob | null> }>
      const { toBlob } = await load()
      const transparentCanvas = document.createElement('canvas')
      transparentCanvas.width = 96
      transparentCanvas.height = 96
      const transparentContext = transparentCanvas.getContext('2d')!
      transparentContext.fillStyle = 'rgba(180, 32, 64, 0.65)'
      transparentContext.beginPath()
      transparentContext.arc(48, 48, 24, 0, Math.PI * 2)
      transparentContext.fill()
      const transparentPNG = transparentCanvas.toDataURL('image/png')
      const ratios = [
        { name: '1:1', width: 360, height: 360 },
        { name: '3:4', width: 360, height: 480 },
        { name: '9:16', width: 360, height: 640 },
      ]
      const templates = ['editorial', 'swiss'] as const
      const cases: Array<{ template: string; ratio: string; cssWidth: number; cssHeight: number; pngWidth: number; pngHeight: number; bytes: number; elapsedMs: number; transparentSample: number[] }> = []

      document.documentElement.style.cssText = 'margin:0;width:390px;overflow-x:hidden;background:#fff'
      document.body.replaceChildren()
      Object.assign(document.body.style, { margin: '0', width: '390px', overflowX: 'hidden', fontFamily: 'Arial, Microsoft YaHei, sans-serif' })
      await document.fonts.ready

      for (const template of templates) {
        for (const ratio of ratios) {
          const card = document.createElement('article')
          card.dataset.template = template
          Object.assign(card.style, {
            boxSizing: 'border-box', width: `${ratio.width}px`, height: `${ratio.height}px`, padding: '24px',
            overflow: 'hidden', color: '#202a36', background: template === 'editorial' ? '#ffffff' : '#f7f8fa',
            fontFamily: 'Arial, Microsoft YaHei, sans-serif',
          })
          if (template === 'editorial') {
            card.style.borderTop = '6px solid #b7791f'
          } else {
            card.style.borderTop = '6px solid #2f5d62'
            card.style.backgroundImage = 'linear-gradient(135deg, #f7f8fa 0%, #eef4f4 100%)'
          }
          const eyebrow = document.createElement('small')
          eyebrow.textContent = template === 'editorial' ? '深度手记 · 读者方法' : '01 / 03 · KNOWLEDGE NOTE'
          Object.assign(eyebrow.style, { display: 'block', fontSize: '12px', letterSpacing: '1px', color: template === 'editorial' ? '#b7791f' : '#2f5d62' })
          const title = document.createElement('h1')
          title.textContent = '真正有效的内容，需要给读者一个清楚的下一步'
          Object.assign(title.style, { margin: '18px 0 12px', fontSize: '28px', lineHeight: '1.28', fontWeight: '700' })
          const body = document.createElement('p')
          body.textContent = '先说清楚问题，再用可信的材料解释原因。不要承诺没有证据支持的结果，也不要把未知数据当成零。'
          Object.assign(body.style, { margin: '0', fontSize: '17px', lineHeight: '1.65', color: '#475569' })
          const imageSurface = document.createElement('div')
          Object.assign(imageSurface.style, { width: '144px', height: '144px', marginTop: '18px', padding: '24px', boxSizing: 'border-box', background: '#eef4f4' })
          const image = document.createElement('img')
          image.src = transparentPNG
          Object.assign(image.style, { width: '96px', height: '96px', display: 'block' })
          imageSurface.append(image)
          card.append(eyebrow, title, body, imageSurface)
          if (template === 'swiss') {
            const footer = document.createElement('p')
            footer.textContent = '结论 · 让每张卡片只表达一个重点。'
            Object.assign(footer.style, { marginTop: '18px', paddingTop: '12px', borderTop: '1px solid #2f5d62', fontSize: '14px' })
            card.append(footer)
          }
          document.body.append(card)
          await Promise.all(Array.from(card.querySelectorAll('img')).map(item => item.decode()))
          const start = performance.now()
          const blob = await toBlob(card, { width: ratio.width, height: ratio.height, pixelRatio: 3, skipAutoScale: true, cacheBust: false })
          const elapsedMs = performance.now() - start
          if (!blob) throw new Error(`${template}/${ratio.name}: toBlob returned null`)
          const bitmap = await createImageBitmap(blob)
          const sampleCanvas = document.createElement('canvas')
          sampleCanvas.width = 1
          sampleCanvas.height = 1
          const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true })!
          const imageBounds = image.getBoundingClientRect()
          sampleContext.drawImage(bitmap, Math.round((imageBounds.left + 4) * 3), Math.round((imageBounds.top + 4) * 3), 1, 1, 0, 0, 1, 1)
          const transparentSample = Array.from(sampleContext.getImageData(0, 0, 1, 1).data)
          cases.push({ template, ratio: ratio.name, cssWidth: ratio.width, cssHeight: ratio.height, pngWidth: bitmap.width, pngHeight: bitmap.height,
            bytes: blob.size, elapsedMs: Math.round(elapsedMs), transparentSample })
          bitmap.close()
          card.remove()
        }
      }
      return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, documentWidth: document.documentElement.scrollWidth }, cases }
    })

    expect(matrix.viewport.width).toBe(390)
    expect(matrix.viewport.documentWidth).toBe(390)
    expect(matrix.viewport.dpr).toBeCloseTo(2, 5)
    expect(matrix.cases).toHaveLength(6)
    for (const item of matrix.cases) {
      const expected = item.ratio === '1:1' ? [1080, 1080] : item.ratio === '3:4' ? [1080, 1440] : [1080, 1920]
      expect([item.pngWidth, item.pngHeight], `${item.template}/${item.ratio}`).toEqual(expected)
      expect(item.transparentSample, `${item.template}/${item.ratio} transparent image compositing`).toEqual([238, 244, 244, 255])
      expect(item.elapsedMs, `${item.template}/${item.ratio} render budget`).toBeLessThan(30_000)
    }

    const captured = await app.evaluate(async ({ BrowserWindow, nativeImage }, businessOrigin: string) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith(businessOrigin))
      if (!window) throw new Error('business window was not found')
      const nativeCapture = await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 }, { stayHidden: true })
      const nativeSize = nativeCapture.getSize()
      const screenshot = await window.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: 390, height: 844, scale: 1 },
      }) as { data: string }
      const cdpSize = nativeImage.createFromBuffer(Buffer.from(screenshot.data, 'base64')).getSize()
      return { nativeCapture: nativeSize, cdpCapture: cdpSize, debuggerAttached: window.webContents.debugger.isAttached() }
    }, origin)
    console.log(`Q-CX-02 raster experiment: ${JSON.stringify({ matrix, electronCapture: captured })}`)
    expect(captured.cdpCapture).toEqual({ width: 780, height: 1688 })
    expect(captured.nativeCapture.width).toBeGreaterThan(0)
    expect(captured.nativeCapture.height).toBeGreaterThan(0)
    expect(captured.debuggerAttached).toBe(true)

    await page.evaluate(async () => {
      document.documentElement.style.cssText = 'margin:0;width:390px;overflow-x:hidden;background:#ffffff'
      document.body.replaceChildren()
      Object.assign(document.body.style, { margin: '0', width: '390px', overflowX: 'hidden' })
      const content = document.createElement('main')
      Object.assign(content.style, {
        width: '390px', height: '2530px', position: 'relative', overflow: 'hidden',
        background: 'repeating-linear-gradient(180deg,#17324d 0px,#17324d 31px,#e6f4f1 31px,#e6f4f1 62px)',
      })
      for (let index = 0; index < 11; index += 1) {
        const label = document.createElement('p')
        label.textContent = `接缝验证段落 ${index + 1}：依据完整，分段捕获。`
        Object.assign(label.style, { position: 'absolute', top: `${index * 230 + 12}px`, left: '18px', color: '#ffffff', fontSize: '16px' })
        content.append(label)
      }
      document.body.append(content)
      await document.fonts.ready
      await Promise.all(Array.from(document.images).map(item => item.decode()))
    })

    const segments = await app.evaluate(async ({ BrowserWindow, nativeImage }, businessOrigin: string) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith(businessOrigin))
      if (!window) throw new Error('business window was not found')
      const contents = window.webContents
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
      const offsets = [0, 843, 1686]
      const segmentRecords: Array<{ x: number; y: number; width: number; height: number; pngBytes: number; rawBytes: number; elapsedMs: number }> = []
      let previousPixels: Buffer | null = null
      let seamsMatch = true
      for (const y of offsets) {
        const startedAt = Date.now()
        const screenshot = await contents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: true,
          clip: { x: 0, y, width: 390, height: 844, scale: 1 },
        }) as { data: string }
        const encoded = Buffer.from(screenshot.data, 'base64')
        const bitmap = nativeImage.createFromBuffer(encoded)
        const size = bitmap.getSize()
        const pixels = bitmap.getBitmap()
        const rawBytes = pixels.byteLength
        if (previousPixels) {
          const rowBytes = size.width * 4
          seamsMatch = seamsMatch
            && previousPixels.subarray(previousPixels.byteLength - 2 * rowBytes).equals(pixels.subarray(0, 2 * rowBytes))
        }
        segmentRecords.push({ x: 0, y, width: size.width, height: size.height, pngBytes: encoded.byteLength, rawBytes, elapsedMs: Date.now() - startedAt })
        previousPixels = pixels
      }
      if (contents.debugger.isAttached()) contents.debugger.detach()
      return { segments: segmentRecords, seamsMatch, debuggerDetached: !contents.debugger.isAttached() }
    }, origin)
    const segmentPixels = segments.segments.reduce((sum, segment) => sum + segment.width * segment.height, 0)
    const totalPixels = 780 * 5060
    const segmentWorkingSetBytes = segments.segments[0].rawBytes * 2
    console.log(`Q-CX-02 segmented screenshot experiment: ${JSON.stringify({ ...segments, segmentPixels, totalPixels, segmentWorkingSetBytes })}`)
    expect(segments.segments).toHaveLength(3)
    for (const segment of segments.segments) {
      expect([segment.width, segment.height]).toEqual([780, 1688])
      expect(segment.height).toBeLessThanOrEqual(16_000)
      expect(segment.rawBytes).toBeLessThanOrEqual(32 * 1024 * 1024)
    }
    expect(segmentPixels).toBeLessThanOrEqual(46_800_000)
    expect(totalPixels).toBeLessThanOrEqual(46_800_000)
    expect(segments.seamsMatch).toBe(true)
    expect(segments.debuggerDetached).toBe(true)

    const buildId = '00000008-1111-4111-8111-111111111111'
    const sourceHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const fixtureImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 4
      canvas.height = 4
      const context = canvas.getContext('2d')!
      context.fillStyle = '#1c4e80'
      context.fillRect(0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png')
    })
    const captureHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Electron 长图接缝</title><style>
      html,body{margin:0;width:390px}main{position:relative;width:390px;height:8002px;background:#fff}
      p{position:absolute;top:12px;left:12px;color:#111;font:16px Arial,sans-serif}
      img{position:absolute;top:100px;left:20px;width:32px;height:32px;object-fit:cover}
      .band{position:absolute;left:0;width:390px;height:1px}
      #before{top:7999px;background:#e02020}#edge{top:8000px;background:#20a040}#after{top:8001px;background:#2040e0}
    </style></head><body><main><p>中文正文与分段边界</p><img src="${fixtureImage}"><i id="before" class="band"></i><i id="edge" class="band"></i><i id="after" class="band"></i></main></body></html>`
    await page.evaluate(({ buildId: id, sourceHash: hash, html }) => {
      const source = document.createElement('textarea')
      source.id = 'ops-cx-long-image-source'
      source.dataset.buildId = id
      source.dataset.sourceHash = hash
      source.hidden = true
      source.value = html
      document.body.append(source)
    }, { buildId, sourceHash, html: captureHTML })
    const windowCountBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    const capturedImage = await page.evaluate(async (id) => {
      const [result, duplicate, concurrentBuild] = await Promise.all([
        window.opsDesktopUI!.captureLongImage(id),
        window.opsDesktopUI!.captureLongImage(id),
        window.opsDesktopUI!.captureLongImage('00000011-1111-4111-8111-111111111111'),
      ])
      if (!result.ok) return result
      const bitmap = await createImageBitmap(new Blob([result.png], { type: 'image/png' }))
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(bitmap, 0, 0)
      const read = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data)
      const resultInfo = {
        buildId: result.buildId,
        sourceHash: result.sourceHash,
        width: bitmap.width,
        height: bitmap.height,
        heightCss: result.heightCss,
        dpr: result.dpr,
        viewportWidth: result.viewportWidth,
        viewportHeight: result.viewportHeight,
        segments: result.segments,
        duplicateCode: duplicate.ok ? 'unexpected_success' : duplicate.code,
        concurrentBuildCode: concurrentBuild.ok ? 'unexpected_success' : concurrentBuild.code,
        captureEngine: result.captureEngine,
        engineVersion: result.captureEngineVersion,
        capturedAt: result.capturedAt,
        image: read(50, 220),
        before: read(10, 15_998),
        edge: read(10, 16_000),
        after: read(10, 16_002),
      }
      bitmap.close()
      return resultInfo
    }, buildId)
    expect(capturedImage).toMatchObject({
      buildId, sourceHash, width: 780, height: 16_004, heightCss: 8_002, dpr: 2,
      viewportWidth: 390, viewportHeight: 844, segments: 3, captureEngine: 'chromium-cdp',
      duplicateCode: 'capture_busy',
      concurrentBuildCode: 'capture_busy',
      image: [28, 78, 128, 255],
      before: [224, 32, 32, 255], edge: [32, 160, 64, 255], after: [32, 64, 224, 255],
    })
    expect(Date.parse((capturedImage as { capturedAt: string }).capturedAt)).not.toBeNaN()
    expect((capturedImage as { engineVersion: string }).engineVersion).not.toBe('')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowCountBefore)

    const shortBuildId = '00000009-1111-4111-8111-111111111111'
    const shortHash = '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const shortHTML = `<!doctype html><html><head><meta charset="utf-8"><title>短稿</title></head><body><main style="width:390px;height:120px;background:#fff">短稿与内嵌图片<img src="${fixtureImage}" style="width:24px;height:24px"></main></body></html>`
    await page.evaluate(({ buildId: id, sourceHash: hash, html }) => {
      document.getElementById('ops-cx-long-image-source')?.remove()
      const source = document.createElement('textarea')
      source.id = 'ops-cx-long-image-source'
      source.dataset.buildId = id
      source.dataset.sourceHash = hash
      source.hidden = true
      source.value = html
      document.body.append(source)
    }, { buildId: shortBuildId, sourceHash: shortHash, html: shortHTML })
    const shortImage = await page.evaluate(async (id) => {
      const result = await window.opsDesktopUI!.captureLongImage(id)
      if (!result.ok) return result
      const bitmap = await createImageBitmap(new Blob([result.png], { type: 'image/png' }))
      const dimensions = { width: bitmap.width, height: bitmap.height, heightCss: result.heightCss, dpr: result.dpr, segments: result.segments }
      bitmap.close()
      return dimensions
    }, shortBuildId)
    expect(shortImage).toEqual({ width: 780, height: 240, heightCss: 120, dpr: 2, segments: 1 })
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowCountBefore)

    const maxBuildId = '00000010-1111-4111-8111-111111111111'
    const maxHash = '2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const maxHTML = `<!doctype html><html><head><meta charset="utf-8"><title>预算上限</title><style>
      html,body{margin:0;width:390px}main{position:relative;width:390px;height:30000px;background:#fff}
      p{position:absolute;top:12px;left:12px;color:#111;font:16px Arial,sans-serif}
      i{position:absolute;top:29999px;left:0;width:390px;height:1px;background:#1c4e80}
    </style></head><body><main><p>最大预算长图</p><i></i></main></body></html>`
    await page.evaluate(({ buildId: id, sourceHash: hash, html }) => {
      document.getElementById('ops-cx-long-image-source')?.remove()
      const source = document.createElement('textarea')
      source.id = 'ops-cx-long-image-source'
      source.dataset.buildId = id
      source.dataset.sourceHash = hash
      source.hidden = true
      source.value = html
      document.body.append(source)
    }, { buildId: maxBuildId, sourceHash: maxHash, html: maxHTML })
    const maxImage = await page.evaluate(async (id) => {
      const result = await window.opsDesktopUI!.captureLongImage(id)
      if (!result.ok) return result
      const bytes = new Uint8Array(result.png)
      const png = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return {
        sourceHash: result.sourceHash,
        width: png.getUint32(16),
        height: png.getUint32(20),
        heightCss: result.heightCss,
        dpr: result.dpr,
        segments: result.segments,
        pngBytes: bytes.byteLength,
      }
    }, maxBuildId)
    expect(maxImage).toMatchObject({ sourceHash: maxHash, width: 780, height: 60_000, heightCss: 30_000, dpr: 2, segments: 8 })
    expect((maxImage as { pngBytes: number }).pngBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowCountBefore)

    probeServer = createServer((_request, response) => {
      probeRequests += 1
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(Buffer.from('not-an-image'))
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      probeServer!.once('error', rejectListen)
      probeServer!.listen(0, '127.0.0.1', resolveListen)
    })
    const address = probeServer.address()
    if (!address || typeof address === 'string') throw new Error('network probe server did not bind')
    const blockedHTML = captureHTML.replace('</main>', `<img src="http://127.0.0.1:${address.port}/probe.png"></main>`)
    await page.evaluate(({ buildId: id, sourceHash: hash, html }) => {
      document.getElementById('ops-cx-long-image-source')?.remove()
      const source = document.createElement('textarea')
      source.id = 'ops-cx-long-image-source'
      source.dataset.buildId = id
      source.dataset.sourceHash = hash
      source.hidden = true
      source.value = html
      document.body.append(source)
    }, { buildId, sourceHash, html: blockedHTML })
    const blockedResult = await page.evaluate(async (id) => window.opsDesktopUI!.captureLongImage(id), buildId)
    expect(blockedResult).toMatchObject({ ok: false, code: 'render_not_ready' })
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    expect(probeRequests).toBe(0)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowCountBefore)

    const preloadPath = resolve(process.cwd(), '../desktop/.build/business-ui-preload.js')
    const secondaryId = await app.evaluate(({ BrowserWindow }, args: { preloadPath: string; origin: string }) => {
      const secondary = new BrowserWindow({ show: false, webPreferences: {
        preload: args.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true,
      } })
      void secondary.loadURL(args.origin)
      return secondary.id
    }, { preloadPath, origin })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }, args: { id: number; origin: string }) => {
      const secondary = BrowserWindow.fromId(args.id)
      return Boolean(secondary && secondary.webContents.getURL().startsWith(args.origin))
    }, { id: secondaryId, origin })).toBe(true)
    const denied = await app.evaluate(async ({ BrowserWindow }, args: { id: number; buildId: string }) => {
      const secondary = BrowserWindow.fromId(args.id)
      if (!secondary) return { denied: false, message: 'secondary window was not found' }
      try {
        await secondary.webContents.executeJavaScript(`window.opsDesktopUI.captureLongImage(${JSON.stringify(args.buildId)})`, true)
        return { denied: false, message: 'capture unexpectedly succeeded' }
      } catch (error) {
        return { denied: true, message: String(error) }
      }
    }, { id: secondaryId, buildId })
    expect(denied).toMatchObject({ denied: true })
    expect(denied.message).toContain('不允许此窗口发起长图构建')
    await app.evaluate(({ BrowserWindow }, id: number) => BrowserWindow.fromId(id)?.destroy(), secondaryId)
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowCountBefore)
  } finally {
    if (probeServer?.listening) await new Promise<void>(resolveClose => probeServer!.close(() => resolveClose()))
    await app?.evaluate(({ BrowserWindow }, businessOrigin: string) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith(businessOrigin))
      if (window?.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    }, baseURL ?? 'http://127.0.0.1:5287').catch(() => undefined)
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(userData, { recursive: true, force: true })
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= 5) throw error
        await new Promise(resolveWait => setTimeout(resolveWait, 100 * (attempt + 1)))
      }
    }
  }
  await expect(access(userData)).rejects.toMatchObject({ code: 'ENOENT' })
})
