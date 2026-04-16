import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BrowserWindow,
  session,
  shell,
  type WebContents
} from 'electron'
import {
  type AppSettings,
  DEFAULT_COURSE_URL,
  DEFAULT_MY_CLASSES_URL,
  type ExportTraceResult,
  type LearningRequiredAction,
  type LearningRunResult,
  type LearningSessionState,
  type RecordedElement,
  type RecordedEvent,
  type RecordedTraceBundle,
  type RecorderEventType,
  type RecorderState,
  type SelectorCandidate
} from '@shared/contracts'
import { deriveSuggestedFlowSteps } from '@shared/traceAnalysis'

const MANAGED_PARTITION = 'persist:course-automation-managed'
const PAGE_ID = 'page_managed'

interface BrowserRecorderServiceOptions {
  sessionDataDir: string
  tracesDir: string
  settingsFile: string
  baseUrl?: string
  onStateChange?: (state: RecorderState) => void
  onEvent?: (event: RecordedEvent) => void
}

interface AppendEventInput {
  type: RecorderEventType
  description: string
  selectors?: SelectorCandidate[]
  element?: RecordedElement
  data?: Record<string, unknown>
  captureArtifacts?: boolean
  overrideUrl?: string
  overrideTitle?: string
}

interface PlaybackObservation {
  chapterKey: string
  currentTime: number
  duration: number
  progressPercent: number
  nearEndSeen: boolean
  stagnantTicks: number
}

interface ClickPoint {
  x: number
  y: number
}

interface PopupExpectation {
  until: number
  reason: string
}

export class BrowserRecorderService {
  private controlWindow: BrowserWindow | null = null
  private learningWindow: BrowserWindow | null = null
  private readonly managedSession = session.fromPartition(MANAGED_PARTITION)
  private readonly auxiliaryWindows = new Set<BrowserWindow>()
  private readonly sessionStateFile: string
  private readonly settingsFile: string
  private readonly onStateChange?: (state: RecorderState) => void
  private readonly onEvent?: (event: RecordedEvent) => void
  private readonly traceEvents: RecordedEvent[] = []
  private readonly requestIds = new Map<number, string>()
  private automationTimer: NodeJS.Timeout | null = null
  private automationBusy = false
  private networkObserversAttached = false
  private networkEventCounter = 0
  private networkLogFile: string | null = null
  private sessionStateLoaded = false
  private sessionPersistTimer: NodeJS.Timeout | null = null
  private lastPlaybackObservation: PlaybackObservation | null = null
  private lastResumeAppliedKey: string | null = null
  private popupExpectation: PopupExpectation | null = null
  private eventCounter = 0
  private runId: string | null = null
  private runDir: string | null = null
  private lastClassDetailUrl: string | null = null
  private settingsLoaded = false
  private state: RecorderState

  constructor(options: BrowserRecorderServiceOptions) {
    this.sessionStateFile = join(options.sessionDataDir, 'session-state.json')
    this.settingsFile = options.settingsFile
    this.onStateChange = options.onStateChange
    this.onEvent = options.onEvent
    this.state = {
      status: 'idle',
      baseUrl: options.baseUrl ?? DEFAULT_COURSE_URL,
      isBrowserOpen: false,
      isRecording: false,
      sessionDataPath: options.sessionDataDir,
      recordingsPath: options.tracesDir,
      eventCount: 0,
      networkCaptureEnabled: true,
      networkEventCount: 0,
      networkPurposeCounts: {},
      settings: defaultAppSettings(),
      siteHints: [
        '学习页会在单独的 Electron 学习窗口中打开，不再挤在主控界面里。',
        '登录状态会保存在应用的持久化会话分区里，下次打开会优先复用。',
        '课程播放、继续学习提示和下一节推进，都会只绑定在应用托管的学习页上。'
      ]
    }

    this.attachSessionPersistence()
  }

  attachHostWindow(window: BrowserWindow): void {
    if (this.controlWindow === window) {
      return
    }

    if (this.controlWindow && !this.controlWindow.isDestroyed()) {
      this.controlWindow.removeListener('closed', this.handleControlClosed)
    }

    this.controlWindow = window
    window.on('closed', this.handleControlClosed)
  }

  getState(): RecorderState {
    return {
      ...this.state,
      siteHints: [...this.state.siteHints]
    }
  }

  async getLatestTrace(): Promise<RecordedTraceBundle | null> {
    await mkdir(this.state.recordingsPath, { recursive: true })
    const traceDir = this.runDir ?? (await this.findLatestTraceDir())
    if (!traceDir) {
      return null
    }

    const bundle = await this.readTraceBundle(traceDir)
    if (bundle) {
      this.setState({
        lastTraceDir: traceDir
      })
    }
    return bundle
  }

  async loadSettings(): Promise<AppSettings> {
    return this.ensureSettingsLoaded()
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.ensureSettingsLoaded()
    const next = {
      ...current,
      ...patch
    }
    await this.persistSettings(next)
    return next
  }

  async startLearning(): Promise<LearningRunResult> {
    await this.ensureSettingsLoaded()
    await this.openBrowser(this.state.baseUrl)
    let session = await this.inspectHomeLoginState()

    if (session.continuePromptVisible && session.routeKind === 'video-play') {
      session = await this.acknowledgeContinuePrompt()
    }

    if (session.routeKind === 'video-play' && session.loginStatus === 'logged-in') {
      this.startAutomationLoop()
      return this.createLearningResult(session, '当前已经在播放页，已切到继续学习状态。', 'none')
    }

    session = await this.ensureLoggedInForLearning(session)
    if (session.loginStatus !== 'logged-in') {
      return this.resolveLoginFailureResult(session)
    }

    if (
      session.routeKind !== 'my-classes' &&
      session.routeKind !== 'course-detail' &&
      session.routeKind !== 'video-play'
    ) {
      session = await this.openMyClasses()
      session = await this.ensureLoggedInForLearning(session)
      if (session.loginStatus !== 'logged-in') {
        return this.resolveLoginFailureResult(session)
      }
    }

    if (session.routeKind !== 'video-play') {
      session = await this.enterCurrentCourse()
    }

    if (session.continuePromptVisible && session.routeKind === 'video-play') {
      session = await this.acknowledgeContinuePrompt()
    }

    session = await this.stabilizeLearningSession(session, 3_500)
    this.startAutomationLoop()

    if (session.routeKind === 'video-play') {
      return this.createLearningResult(
        session,
        session.video.exists
          ? '已进入课程播放页，客户端会持续监控播放进度和继续学习提示。'
          : '已进入课程播放页。当前播放器还在初始化。',
        'none'
      )
    }

    return this.createLearningResult(
      session,
      '已经推进到课程相关页面，但还没完全稳定进入播放页。当前需要人工关注一次。',
      'manual-attention'
    )
  }

  async pauseLearning(): Promise<LearningRunResult> {
    await this.ensureManagedWebContents(this.state.baseUrl)
    this.stopAutomationLoop()

    let session = await this.inspectSession()
    if (session.routeKind === 'video-play' && session.video.exists) {
      await this.pauseVideoPlayback()
      await sleep(300)
      session = await this.inspectSession()
      return this.createLearningResult(session, '已暂停当前学习。点击“继续学习”后会恢复播放与自动推进。', 'none')
    }

    return this.createLearningResult(session, '当前不在可暂停的播放页，自动推进已停止。', 'none')
  }

  async resumeLearning(): Promise<LearningRunResult> {
    await this.ensureManagedWebContents(this.state.baseUrl)
    let session = await this.inspectSession()

    if (session.continuePromptVisible && session.routeKind === 'video-play') {
      session = await this.acknowledgeContinuePrompt()
    }

    if (session.routeKind === 'video-play') {
      await this.resumeVideoPlayback()
      this.startAutomationLoop()
      session = await this.inspectSession()
      return this.createLearningResult(session, '已恢复当前学习，系统会继续监控播放进度并自动推进下一节。', 'none')
    }

    return this.startLearning()
  }

  async resumeManagedSession(): Promise<RecorderState> {
    await this.openBrowser(this.state.baseUrl)
    const session = await this.inspectSession()
    this.setState({
      session
    })
    return this.getState()
  }

  async inspectSession(): Promise<LearningSessionState> {
    await this.ensureManagedWebContents(this.state.baseUrl)
    const session = await this.readLearningSession()
    this.setState({
      session
    })
    return session
  }

  async submitLoginAfterCaptcha(): Promise<LearningSessionState> {
    await this.ensureManagedWebContents(this.state.baseUrl)
    await this.clickVisibleText(/^登录$/)
    await sleep(1_800)
    await this.refreshActivePage()
    return this.inspectSession()
  }

  async openMyClasses(): Promise<LearningSessionState> {
    const webContents = await this.ensureManagedWebContents(DEFAULT_MY_CLASSES_URL)
    await webContents.loadURL(DEFAULT_MY_CLASSES_URL)
    await sleep(1_000)
    await this.refreshActivePage()
    return this.inspectSession()
  }

  async enterCurrentCourse(): Promise<LearningSessionState> {
    let session = await this.inspectSession()

    if (session.routeKind !== 'my-classes' && session.routeKind !== 'course-detail') {
      session = await this.openMyClasses()
    }

    if (session.loginStatus !== 'logged-in') {
      return session
    }

    if (session.routeKind === 'my-classes') {
      const selected = await this.openPreferredClassFromMyClasses()
      if (!selected) {
        return this.inspectSession()
      }

      await sleep(900)
      session = await this.inspectSession()
      if (session.routeKind === 'course-detail') {
        this.lastClassDetailUrl = session.currentUrl
      }
    }

    if (session.routeKind === 'course-detail') {
      this.lastClassDetailUrl = session.currentUrl
      const started = await this.startNextLessonFromDetail()
      if (!started) {
        return this.inspectSession()
      }
    }

    const reachedPlayback = await this.waitForManagedUrlMatch('/video_play', 8_000)
    if (reachedPlayback) {
      await sleep(800)
      await this.refreshActivePage()
    } else {
      await this.refreshActivePage()
    }

    return this.inspectSession()
  }

  async acknowledgeContinuePrompt(): Promise<LearningSessionState> {
    await this.ensureManagedWebContents(this.state.baseUrl)
    const clicked = await this.clickDialogAction(/是否继续学习/, /确\s*定/)
    if (clicked) {
      await sleep(800)
      await this.resumeVideoPlayback()
    }

    await this.refreshActivePage()
    return this.inspectSession()
  }

  async openBrowser(targetUrl?: string): Promise<RecorderState> {
    const requestedUrl = targetUrl?.trim()
    const nextUrl = requestedUrl || this.state.baseUrl || DEFAULT_COURSE_URL
    await mkdir(this.state.recordingsPath, { recursive: true })
    await this.restoreManagedSessionStateIfNeeded()
    this.networkLogFile = join(this.state.recordingsPath, 'live-network-log.jsonl')
    this.setState({
      status: 'launching',
      baseUrl: nextUrl,
      networkLogPath: this.networkLogFile,
      lastError: undefined
    })

    try {
      const learningWindow = await this.ensureLearningWindow({ reveal: true })
      const webContents = learningWindow.webContents

      const currentUrl = webContents.getURL()
      const shouldLoad =
        Boolean(requestedUrl) || !currentUrl || currentUrl === 'about:blank'

      if (shouldLoad) {
        await webContents.loadURL(nextUrl)
      }

      if (learningWindow.isMinimized()) {
        learningWindow.restore()
      }
      learningWindow.show()
      learningWindow.focus()
      learningWindow.moveTop()
      webContents.focus()
      await sleep(500)
      await this.refreshActivePage()
      this.setState({
        isBrowserOpen: true,
        status: this.state.isRecording ? 'recording' : 'ready',
        baseUrl: nextUrl
      })
      return this.getState()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({
        status: 'error',
        lastError: message
      })
      throw new Error(message)
    }
  }

  async startRecording(label?: string): Promise<RecorderState> {
    await this.ensureManagedWebContents(this.state.baseUrl)

    this.traceEvents.splice(0, this.traceEvents.length)
    this.eventCounter = 0
    const labelPart = slugify(label || 'managed-browser-pass')
    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    this.runId = `${timestamp}-${labelPart}`
    this.runDir = join(this.state.recordingsPath, this.runId)
    await mkdir(join(this.runDir, 'screenshots'), { recursive: true })
    await mkdir(join(this.runDir, 'snapshots'), { recursive: true })

    this.setState({
      isRecording: true,
      status: 'recording',
      currentRunId: this.runId,
      startedAt: new Date().toISOString(),
      lastTraceDir: this.runDir,
      lastError: undefined,
      eventCount: 0
    })

    await this.appendEvent({
      type: 'recording-started',
      description: label
        ? `Started recording run: ${label}`
        : 'Started recording the managed Electron browser flow',
      captureArtifacts: false
    })

    return this.getState()
  }

  async stopRecording(): Promise<RecorderState> {
    if (!this.state.isRecording) {
      return this.getState()
    }

    await this.appendEvent({
      type: 'recording-stopped',
      description: 'Stopped recording and prepared the trace bundle',
      captureArtifacts: false
    })

    this.setState({
      isRecording: false,
      status: this.learningWindow ? 'ready' : 'idle'
    })
    await this.persistTrace()
    return this.getState()
  }

  async exportTrace(): Promise<ExportTraceResult> {
    await this.persistTrace()
    return {
      traceDir: this.runDir ?? this.state.lastTraceDir ?? null,
      eventCount: this.traceEvents.length
    }
  }

  async dispose(): Promise<void> {
    this.stopAutomationLoop()
    await this.persistManagedSessionState().catch(() => undefined)
    if (this.sessionPersistTimer) {
      clearTimeout(this.sessionPersistTimer)
      this.sessionPersistTimer = null
    }

    for (const auxiliaryWindow of this.auxiliaryWindows) {
      auxiliaryWindow.destroy()
    }
    this.auxiliaryWindows.clear()

    if (this.learningWindow && !this.learningWindow.isDestroyed()) {
      this.learningWindow.close()
    }

    this.learningWindow = null
  }

  private readonly handleControlClosed = () => {
    this.controlWindow = null
  };

  private setState(partial: Partial<RecorderState>): void {
    this.state = {
      ...this.state,
      ...partial
    }
    this.onStateChange?.(this.getState())
  }

  private attachSessionPersistence(): void {
    this.managedSession.cookies.on('changed', () => {
      this.schedulePersistManagedSessionState()
    })
  }

  private schedulePersistManagedSessionState(): void {
    if (this.sessionPersistTimer) {
      clearTimeout(this.sessionPersistTimer)
    }

    this.sessionPersistTimer = setTimeout(() => {
      this.sessionPersistTimer = null
      void this.persistManagedSessionState()
    }, 500)
  }

  private async restoreManagedSessionStateIfNeeded(): Promise<void> {
    if (this.sessionStateLoaded) {
      return
    }

    this.sessionStateLoaded = true
    await mkdir(dirname(this.sessionStateFile), { recursive: true }).catch(() => undefined)

    const stored = await readFile(this.sessionStateFile, 'utf8')
      .then((content) => JSON.parse(content) as { cookies?: Electron.Cookie[] } | null)
      .catch(() => null)

    const cookies = stored?.cookies ?? []
    for (const cookie of cookies) {
      const details = toCookieSetDetails(cookie)
      if (!details) {
        continue
      }

      await this.managedSession.cookies.set(details).catch(() => undefined)
    }

    await this.managedSession.cookies.flushStore().catch(() => undefined)
  }

  private async persistManagedSessionState(): Promise<void> {
    await mkdir(dirname(this.sessionStateFile), { recursive: true }).catch(() => undefined)
    const cookies = await this.managedSession.cookies.get({}).catch(() => [])
    const payload = {
      savedAt: new Date().toISOString(),
      cookies
    }

    await writeFile(this.sessionStateFile, JSON.stringify(payload, null, 2), 'utf8').catch(() => undefined)
    await this.managedSession.cookies.flushStore().catch(() => undefined)
  }

  private async ensureLearningWindow(options?: { reveal?: boolean }): Promise<BrowserWindow> {
    const reveal = options?.reveal === true

    if (this.learningWindow && !this.learningWindow.isDestroyed()) {
      if (reveal) {
        if (this.learningWindow.isMinimized()) {
          this.learningWindow.restore()
        }
        this.learningWindow.show()
        this.learningWindow.focus()
        this.learningWindow.moveTop()
      }
      return this.learningWindow
    }

    const window = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 1080,
      minHeight: 720,
      title: '观看助手 · 学习页',
      backgroundColor: '#091019',
      autoHideMenuBar: true,
      show: true,
      webPreferences: {
        partition: MANAGED_PARTITION,
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })

    if (reveal) {
      window.show()
      window.focus()
      window.moveTop()
    }

    window.on('closed', () => {
      if (this.learningWindow === window) {
        this.learningWindow = null
        this.popupExpectation = null
        this.lastPlaybackObservation = null
        this.lastResumeAppliedKey = null
        this.setState({
          isBrowserOpen: false,
          status: this.state.isRecording ? 'recording' : 'idle',
          activePageTitle: undefined,
          activePageUrl: undefined
        })
      }
    })

    this.learningWindow = window
    this.attachManagedWebContents(window.webContents)
    this.attachNetworkObservers()

    return window
  }

  private async ensureManagedWebContents(targetUrl?: string): Promise<WebContents> {
    const window = await this.ensureLearningWindow()
    const webContents = window.webContents
    const currentUrl = webContents.getURL()

    if ((!currentUrl || currentUrl === 'about:blank') && targetUrl) {
      await webContents.loadURL(targetUrl)
      await sleep(300)
    }

    return webContents
  }

  private attachManagedWebContents(webContents: WebContents): void {
    webContents.setWindowOpenHandler(({ url }) => {
      if (this.shouldOpenInManagedView(url)) {
        void this.loadUrlInManagedView(url)
        return { action: 'deny' }
      }

      if (isCourseAppUrl(url)) {
        void this.openAuxiliaryWindow(url)
        return { action: 'deny' }
      }

      void shell.openExternal(url)
      return { action: 'deny' }
    })

    webContents.on('dom-ready', () => {
      void this.refreshActivePage()
    })

    webContents.on('did-finish-load', () => {
      void this.refreshActivePage()
    })

    webContents.on('did-navigate', (_event, url) => {
      this.handleManagedNavigation(url, 'did-navigate')
    })

    webContents.on('did-navigate-in-page', (_event, url) => {
      this.handleManagedNavigation(url, 'did-navigate-in-page')
    })

    webContents.on('page-title-updated', (_event, title) => {
      this.setState({
        activePageTitle: title
      })
    })

    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) {
        return
      }

      this.setState({
        status: 'error',
        lastError: `页面加载失败：${errorDescription} (${errorCode})`,
        activePageUrl: validatedURL || this.state.activePageUrl
      })
    })

    webContents.on('render-process-gone', (_event, details) => {
      this.setState({
        status: 'error',
        lastError: `学习页面进程异常退出：${details.reason}`
      })
    })
  }

  private handleManagedNavigation(url: string, reason: 'did-navigate' | 'did-navigate-in-page'): void {
    if (isVideoPlayUrl(url)) {
      this.popupExpectation = null
    }

    this.setState({
      activePageUrl: url,
      isBrowserOpen: true,
      status: this.state.isRecording ? 'recording' : 'ready'
    })

    if (this.state.isRecording) {
      void this.appendEvent({
        type: 'navigation',
        description: 'Main frame navigated to a new page state',
        data: {
          reason
        },
        captureArtifacts: false,
        overrideUrl: url
      })
    }

    void this.refreshActivePage()
  }

  private attachNetworkObservers(): void {
    if (this.networkObserversAttached) {
      return
    }

    this.networkObserversAttached = true

    this.managedSession.webRequest.onBeforeRequest((details, callback) => {
      void this.captureRequest(details)
      callback({})
    })

    this.managedSession.webRequest.onCompleted((details) => {
      void this.captureCompletedResponse(details)
    })

    this.managedSession.webRequest.onErrorOccurred((details) => {
      void this.captureErroredResponse(details)
    })
  }

  private async captureRequest(details: Electron.OnBeforeRequestListenerDetails): Promise<void> {
    const id = `net_${Date.now()}_${++this.networkEventCounter}`
    this.requestIds.set(details.id, id)

    const purpose = classifyNetworkPurpose(details.url, details.method, details.resourceType)
    const postDataPreview = sanitizePayloadPreview(extractUploadData(details))

    await this.appendNetworkRecord({
      id,
      phase: 'request',
      timestamp: new Date().toISOString(),
      method: details.method,
      resourceType: details.resourceType,
      url: details.url,
      purpose: purpose.key,
      purposeLabel: purpose.label,
      purposeReason: purpose.reason,
      postDataPreview: postDataPreview || undefined
    })
  }

  private async captureCompletedResponse(details: Electron.OnCompletedListenerDetails): Promise<void> {
    const id = this.requestIds.get(details.id) ?? `net_${Date.now()}_${++this.networkEventCounter}`
    const purpose = classifyNetworkPurpose(details.url, details.method, details.resourceType)

    await this.appendNetworkRecord({
      id,
      phase: 'response',
      timestamp: new Date().toISOString(),
      method: details.method,
      resourceType: details.resourceType,
      url: details.url,
      purpose: purpose.key,
      purposeLabel: purpose.label,
      purposeReason: purpose.reason,
      status: details.statusCode,
      contentType: headerValue(details.responseHeaders, 'content-type')
    })
  }

  private async captureErroredResponse(details: Electron.OnErrorOccurredListenerDetails): Promise<void> {
    const id = this.requestIds.get(details.id) ?? `net_${Date.now()}_${++this.networkEventCounter}`
    const purpose = classifyNetworkPurpose(details.url, details.method, details.resourceType)

    await this.appendNetworkRecord({
      id,
      phase: 'response-error',
      timestamp: new Date().toISOString(),
      method: details.method,
      resourceType: details.resourceType,
      url: details.url,
      purpose: purpose.key,
      purposeLabel: purpose.label,
      purposeReason: purpose.reason,
      error: details.error
    })
  }

  private async appendNetworkRecord(record: Record<string, unknown>): Promise<void> {
    if (!this.networkLogFile) {
      return
    }

    await appendFile(this.networkLogFile, `${JSON.stringify(record)}\n`, 'utf8').catch(() => undefined)

    const purpose = typeof record.purpose === 'string' ? record.purpose : 'other'
    const nextCounts = {
      ...(this.state.networkPurposeCounts ?? {}),
      [purpose]: (this.state.networkPurposeCounts?.[purpose] ?? 0) + 1
    }

    this.setState({
      networkLogPath: this.networkLogFile,
      networkEventCount: (this.state.networkEventCount ?? 0) + 1,
      networkPurposeCounts: nextCounts
    })
  }

  private async appendEvent(input: AppendEventInput): Promise<void> {
    const eventId = `evt_${Date.now()}_${++this.eventCounter}`
    const event: RecordedEvent = {
      id: eventId,
      runId: this.runId ?? undefined,
      type: input.type,
      timestamp: new Date().toISOString(),
      pageId: PAGE_ID,
      pageUrl: input.overrideUrl ?? this.state.activePageUrl ?? this.state.baseUrl,
      pageTitle: input.overrideTitle ?? this.state.activePageTitle,
      description: input.description,
      selectors: input.selectors?.slice(0, 6),
      element: input.element,
      data: input.data
    }

    if (this.runDir && input.captureArtifacts === true) {
      const artifacts = await this.captureArtifacts(eventId)
      if (artifacts.screenshotPath) {
        event.screenshotPath = artifacts.screenshotPath
      }
      if (artifacts.snapshotPath) {
        event.snapshotPath = artifacts.snapshotPath
      }
    }

    this.traceEvents.push(event)
    this.setState({
      eventCount: this.traceEvents.length,
      lastTraceDir: this.runDir ?? this.state.lastTraceDir
    })
    await this.persistTrace()
    this.onEvent?.(event)
  }

  private async captureArtifacts(eventId: string): Promise<{ screenshotPath?: string; snapshotPath?: string }> {
    if (!this.runDir || !this.learningWindow || this.learningWindow.webContents.isDestroyed()) {
      return {}
    }

    const screenshotPath = join('screenshots', `${eventId}.png`)
    const snapshotPath = join('snapshots', `${eventId}.html`)
    let html: string | undefined

    const image = await this.learningWindow.webContents.capturePage().catch(() => null)
    if (image) {
      await writeFile(join(this.runDir, screenshotPath), image.toPNG()).catch(() => undefined)
    }

    html = await this.evaluateInManagedView<string>(() => document.documentElement.outerHTML).catch(() => '')
    if (html) {
      await writeFile(join(this.runDir, snapshotPath), html, 'utf8').catch(() => undefined)
    }

    return {
      screenshotPath: image ? screenshotPath : undefined,
      snapshotPath: html ? snapshotPath : undefined
    }
  }

  private async persistTrace(): Promise<void> {
    if (!this.runDir) {
      return
    }

    const manifest = {
      runId: this.runId,
      generatedAt: new Date().toISOString(),
      baseUrl: this.state.baseUrl,
      sessionDataPath: this.state.sessionDataPath,
      activePageUrl: this.state.activePageUrl,
      activePageTitle: this.state.activePageTitle,
      eventCount: this.traceEvents.length,
      hints: this.state.siteHints
    }

    await writeFile(join(this.runDir, 'events.json'), JSON.stringify(this.traceEvents, null, 2), 'utf8')
    await writeFile(join(this.runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }

  private async findLatestTraceDir(): Promise<string | null> {
    const entries = await readdir(this.state.recordingsPath, { withFileTypes: true }).catch(() => [])
    const latestDir = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))[0]

    return latestDir ? join(this.state.recordingsPath, latestDir) : null
  }

  private async readTraceBundle(traceDir: string): Promise<RecordedTraceBundle | null> {
    const events = await readFile(join(traceDir, 'events.json'), 'utf8')
      .then((content) => JSON.parse(content) as RecordedEvent[])
      .catch(() => null)

    if (!events) {
      return null
    }

    const manifest = await readFile(join(traceDir, 'manifest.json'), 'utf8')
      .then((content) => JSON.parse(content) as Record<string, unknown>)
      .catch(() => undefined)

    return {
      traceDir,
      events,
      suggestedSteps: deriveSuggestedFlowSteps(events),
      manifest
    }
  }

  private createLearningResult(
    session: LearningSessionState,
    summary: string,
    requiredAction: LearningRequiredAction
  ): LearningRunResult {
    const nextState = this.getState()
    return {
      state: nextState,
      session,
      summary,
      requiredAction
    }
  }

  private async ensureSettingsLoaded(): Promise<AppSettings> {
    if (this.settingsLoaded) {
      return this.state.settings ?? defaultAppSettings()
    }

    const loaded = await readFile(this.settingsFile, 'utf8')
      .then((content) => JSON.parse(content) as Partial<AppSettings>)
      .catch(() => null)

    const next = {
      ...defaultAppSettings(),
      ...(loaded ?? {})
    }

    this.settingsLoaded = true
    this.setState({
      settings: next
    })
    return next
  }

  private async persistSettings(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.settingsFile), { recursive: true }).catch(() => undefined)
    await writeFile(this.settingsFile, JSON.stringify(settings, null, 2), 'utf8')
    this.settingsLoaded = true
    this.setState({
      settings
    })
  }

  private async ensureLoggedInForLearning(session: LearningSessionState): Promise<LearningSessionState> {
    return session
  }

  private resolveLoginFailureResult(session: LearningSessionState): LearningRunResult {
    this.startAutomationLoop()

    if (session.loginStatus === 'logged-out' || session.loginFormVisible) {
      return this.createLearningResult(
        session,
        '当前尚未登录。请在独立学习窗口里手动完成登录，系统会持续检测，一旦登录成功会自动继续进入学习。',
        'manual-attention'
      )
    }

    return this.createLearningResult(
      session,
      '系统暂时无法确认登录状态，会继续轮询检查并在确认后自动进入学习。',
      'manual-attention'
    )
  }

  private startAutomationLoop(): void {
    if (this.automationTimer) {
      return
    }

    this.automationTimer = setInterval(() => {
      void this.runAutomationTick()
    }, 3_000)
  }

  private stopAutomationLoop(): void {
    if (this.automationTimer) {
      clearInterval(this.automationTimer)
      this.automationTimer = null
    }
  }

  private async runAutomationTick(): Promise<void> {
    if (
      this.state.isRecording ||
      this.automationBusy ||
      !this.learningWindow ||
      this.learningWindow.webContents.isDestroyed()
    ) {
      return
    }

    this.automationBusy = true

    try {
      const session = await this.inspectSession()

      if (session.loginStatus !== 'logged-in') {
        if (
          session.routeKind === 'other' ||
          (session.routeKind === 'home' && session.loginStatus === 'unknown')
        ) {
          await this.inspectHomeLoginState()
        }
        return
      }

      if (session.continuePromptVisible && session.routeKind === 'video-play') {
        await this.acknowledgeContinuePrompt()
        return
      }

      if (session.routeKind === 'video-play') {
        const playback = await this.observePlaybackState()
        const shouldAdvance = this.shouldAdvanceFromPlayback(playback)

        if (shouldAdvance) {
          await this.advanceFromVideoPage()
          return
        }

        if (playback?.exists && playback.paused && !playback.ended) {
          await this.resumeVideoPlayback()
        }
        return
      }

      if (session.routeKind === 'course-detail') {
        await this.startNextLessonFromDetail()
        return
      }

      if (session.routeKind === 'my-classes') {
        await this.enterCurrentCourse()
        return
      }

      if (session.routeKind === 'home' || session.routeKind === 'my-course' || session.routeKind === 'other') {
        await this.openMyClasses()
      }
    } catch {
      // Keep the automation loop resilient; the UI state already carries the last visible error.
    } finally {
      this.automationBusy = false
    }
  }

  private async inspectHomeLoginState(): Promise<LearningSessionState> {
    const webContents = await this.ensureManagedWebContents(this.state.baseUrl)
    const currentUrl = webContents.getURL()

    if (!isHomeLikeUrl(currentUrl, this.state.baseUrl)) {
      await webContents.loadURL(this.state.baseUrl).catch(() => undefined)
      await sleep(900)
    }

    let session = await this.inspectSession()
    if (session.loginStatus === 'unknown') {
      await sleep(1_200)
      session = await this.inspectSession()
    }

    return session
  }

  private async stabilizeLearningSession(
    initial: LearningSessionState,
    timeoutMs: number
  ): Promise<LearningSessionState> {
    let session = initial
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (session.routeKind === 'video-play' || session.video.exists) {
        return session
      }

      if (session.loginStatus !== 'logged-in') {
        return session
      }

      await sleep(350)
      session = await this.inspectSession()
    }

    return session
  }

  private async observePlaybackState(): Promise<LearningSessionState['video'] | null> {
    const webContents = await this.ensureManagedWebContents(this.state.baseUrl)
    const currentUrl = webContents.getURL()
    const sessionBefore = this.state.session

    if (sessionBefore?.routeKind !== 'video-play' && !currentUrl.includes('/video_play')) {
      return null
    }

    await this.refreshPlayerTelemetry()
    const session = await this.inspectSession()
    return session.video
  }

  private shouldAdvanceFromPlayback(video: LearningSessionState['video'] | null): boolean {
    if (!video || !video.exists) {
      this.lastPlaybackObservation = null
      return false
    }

    const currentTime = video.currentTime ?? 0
    const duration = video.duration ?? 0
    const progressPercent = video.progressPercent ?? (duration > 0 ? (currentTime / duration) * 100 : 0)
    const chapterKey =
      `${this.state.session?.currentCourseTitle ?? ''}::${this.state.session?.currentChapterTitle ?? ''}` ||
      this.state.activePageUrl ||
      'video'

    const previous = this.lastPlaybackObservation
    const sameChapter = previous?.chapterKey === chapterKey
    const nearEnd = video.ended || progressPercent >= 99 || (duration > 0 && currentTime >= duration - 2)
    const loopedAfterNearEnd =
      Boolean(previous && sameChapter && previous.nearEndSeen && currentTime <= 5 && previous.currentTime - currentTime > 20)
    const stagnantTicks =
      previous && sameChapter && Math.abs(currentTime - previous.currentTime) < 1
        ? previous.stagnantTicks + 1
        : 0

    this.lastPlaybackObservation = {
      chapterKey,
      currentTime,
      duration,
      progressPercent,
      nearEndSeen: previous?.nearEndSeen || nearEnd,
      stagnantTicks
    }

    if (nearEnd || loopedAfterNearEnd) {
      this.lastPlaybackObservation = null
      return true
    }

    if (stagnantTicks >= 4 && progressPercent >= 98) {
      this.lastPlaybackObservation = null
      return true
    }

    return false
  }

  private async refreshPlayerTelemetry(): Promise<void> {
    const point = await this.evaluateInManagedView<ClickPoint | null>(resolveManagedPointForAction, ['player-hover', null]).catch(() => null)
    if (!point) {
      return
    }

    await this.dispatchManagedMouseMove(point)
    await sleep(120)
  }

  private async applyPlaybackSettings(): Promise<void> {
    const settings = await this.ensureSettingsLoaded()
    if (!settings.mutePlaybackOnOpen) {
      return
    }

    await this.evaluateInManagedView(muteVideosOnPage).catch(() => undefined)
  }

  private async applyTrackedResumeIfNeeded(session: LearningSessionState): Promise<void> {
    const settings = await this.ensureSettingsLoaded()
    if (!settings.resumeFromTrackedProgressOnOpen || session.routeKind !== 'video-play') {
      return
    }

    const resumeKey =
      `${session.currentCourseTitle ?? ''}::${session.currentChapterTitle ?? ''}` ||
      session.currentUrl

    if (resumeKey === this.lastResumeAppliedKey) {
      return
    }

    const result = await this.evaluateInManagedView<{ applied?: boolean } | null>(applyTrackedResumeOnPage, [10]).catch(() => null)
    if (result?.applied) {
      this.lastResumeAppliedKey = resumeKey
      await sleep(400)
    }
  }

  private async readLearningSession(): Promise<LearningSessionState> {
    const webContents = await this.ensureManagedWebContents(this.state.baseUrl)
    const fallbackUrl = webContents.getURL() || this.state.baseUrl
    const fallbackTitle = this.state.activePageTitle

    const session = await this.evaluateInManagedView<LearningSessionState | null>(readLearningSessionFromPage).catch(() => null)

    return (
      session ?? {
        loginStatus: 'unknown',
        routeKind: 'other',
        loginFormVisible: false,
        requiresCaptcha: false,
        loginPromptVisible: false,
        continuePromptVisible: false,
        currentUrl: fallbackUrl,
        title: fallbackTitle ?? undefined,
        visibleActions: [],
        video: {
          exists: false,
          ready: false,
          playing: false,
          paused: false,
          ended: false
        }
      }
    )
  }

  private async clickVisibleText(pattern: RegExp, scopeSelector?: string): Promise<boolean> {
    return this.clickManagedAction('visible-text', {
      patternSource: pattern.source,
      scopeSelector: scopeSelector ?? ''
    })
  }

  private async clickDialogAction(dialogPattern: RegExp, actionPattern: RegExp): Promise<boolean> {
    return this.clickManagedAction('dialog-action', {
      dialogSource: dialogPattern.source,
      actionSource: actionPattern.source
    })
  }

  private async openPreferredClassFromMyClasses(): Promise<boolean> {
    return this.clickManagedAction('preferred-class')
  }

  private async startNextLessonFromDetail(): Promise<boolean> {
    this.expectManagedPopup('start-next-lesson')
    const started = await this.clickManagedAction('next-lesson')
    if (!started) {
      this.popupExpectation = null
      return false
    }

    await sleep(500)
    await this.clickDialogAction(/姓名：|手机号：|剩余学习天数：|入班时间：/, /^确\s*定$/)
    await sleep(300)
    return true
  }

  private async advanceFromVideoPage(): Promise<void> {
    const movedToNextChapter = await this.clickManagedAction('next-chapter')
    if (movedToNextChapter) {
      await sleep(1_000)
      await this.resumeVideoPlayback()
      return
    }

    const webContents = await this.ensureManagedWebContents(this.state.baseUrl)
    if (this.lastClassDetailUrl) {
      await webContents.loadURL(this.lastClassDetailUrl).catch(() => undefined)
      await sleep(900)
      const started = await this.startNextLessonFromDetail()
      if (started) {
        const popupLoaded = await this.waitForManagedUrlMatch('/video_play', 8_000)
        if (popupLoaded) {
          await sleep(800)
          await this.refreshActivePage()
          await this.resumeVideoPlayback()
          return
        }
      }
    }

    const session = await this.openMyClasses()
    if (session.loginStatus === 'logged-in') {
      await this.enterCurrentCourse()
    }
  }

  private async resumeVideoPlayback(): Promise<void> {
    const clicked = await this.clickManagedAction('video-play-button')
    if (!clicked) {
      await this.evaluateInManagedView(forceResumePlaybackOnPage, [], true).catch(() => undefined)
    }

    await sleep(500)
  }

  private async pauseVideoPlayback(): Promise<void> {
    const clicked = await this.clickManagedAction('video-play-button')
    if (!clicked) {
      await this.evaluateInManagedView(forcePausePlaybackOnPage).catch(() => undefined)
    }

    await sleep(300)
  }

  private async waitForManagedUrlMatch(fragment: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const currentUrl = this.learningWindow?.webContents.getURL() ?? ''
      if (currentUrl.includes(fragment)) {
        return true
      }
      await sleep(250)
    }

    return false
  }

  private async refreshActivePage(): Promise<void> {
    if (!this.learningWindow || this.learningWindow.webContents.isDestroyed()) {
      return
    }

    await this.ensureSettingsLoaded()
    const session = await this.readLearningSession()

    if (session.routeKind === 'video-play') {
      await this.applyPlaybackSettings()
      await this.applyTrackedResumeIfNeeded(session)
    } else {
      this.lastResumeAppliedKey = null
    }

    this.setState({
      activePageTitle: session.title ?? this.state.activePageTitle,
      activePageUrl: session.currentUrl,
      isBrowserOpen: true,
      status: this.state.isRecording ? 'recording' : 'ready',
      session
    })
  }

  private shouldOpenInManagedView(url: string): boolean {
    if (!isCourseAppUrl(url)) {
      return false
    }

    if (isVideoPlayUrl(url)) {
      return true
    }

    return Boolean(this.popupExpectation && this.popupExpectation.until > Date.now())
  }

  private expectManagedPopup(reason: string, ttlMs = 10_000): void {
    this.popupExpectation = {
      reason,
      until: Date.now() + ttlMs
    }
  }

  private async loadUrlInManagedView(url: string): Promise<void> {
    const webContents = await this.ensureManagedWebContents()
    this.popupExpectation = null

    if (webContents.getURL() !== url) {
      await webContents.loadURL(url).catch(() => undefined)
      await sleep(600)
    }

    await this.refreshActivePage()
  }

  private async openAuxiliaryWindow(url: string): Promise<void> {
    const auxiliaryWindow = new BrowserWindow({
      width: 1180,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      parent: this.learningWindow ?? this.controlWindow ?? undefined,
      title: '辅助页面',
      backgroundColor: '#091019',
      webPreferences: {
        partition: MANAGED_PARTITION,
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false
      }
    })

    auxiliaryWindow.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
      if (isCourseAppUrl(nextUrl)) {
        void auxiliaryWindow.loadURL(nextUrl)
        return { action: 'deny' }
      }

      void shell.openExternal(nextUrl)
      return { action: 'deny' }
    })

    auxiliaryWindow.on('closed', () => {
      this.auxiliaryWindows.delete(auxiliaryWindow)
    })

    this.auxiliaryWindows.add(auxiliaryWindow)
    await auxiliaryWindow.loadURL(url).catch(() => undefined)
  }

  private async clickManagedAction(
    action: string,
    payload: Record<string, string> | null = null
  ): Promise<boolean> {
    const point = await this.evaluateInManagedView<ClickPoint | null>(resolveManagedPointForAction, [action, payload]).catch(() => null)
    if (!point) {
      return false
    }

    return this.dispatchManagedClick(point)
  }

  private async dispatchManagedClick(point: ClickPoint): Promise<boolean> {
    if (!this.learningWindow || this.learningWindow.webContents.isDestroyed()) {
      return false
    }

    try {
      const webContents = this.learningWindow.webContents
      const x = Math.round(point.x)
      const y = Math.round(point.y)
      webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 })
      await sleep(40)
      webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      await sleep(35)
      webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await sleep(260)
      return true
    } catch {
      return false
    }
  }

  private async dispatchManagedMouseMove(point: ClickPoint): Promise<void> {
    if (!this.learningWindow || this.learningWindow.webContents.isDestroyed()) {
      return
    }

    const webContents = this.learningWindow.webContents
    webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(point.x),
      y: Math.round(point.y),
      movementX: 0,
      movementY: 0
    })
  }

  private async evaluateInManagedView<T>(
    fn: (...args: any[]) => T,
    args: unknown[] = [],
    userGesture = false
  ): Promise<T> {
    const webContents = await this.ensureManagedWebContents()
    const serializedArgs = JSON.stringify(args)
    const source = `(${fn.toString()})(...${serializedArgs})`
    return webContents.executeJavaScript(source, userGesture) as Promise<T>
  }
}

function defaultAppSettings(): AppSettings {
  return {
    mutePlaybackOnOpen: false,
    resumeFromTrackedProgressOnOpen: false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isCourseAppUrl(url: string): boolean {
  return /https:\/\/www\.nmpaied\.com/i.test(url)
}

function isVideoPlayUrl(url: string): boolean {
  return /\/video_play/i.test(url)
}

function isHomeLikeUrl(currentUrl: string, baseUrl: string): boolean {
  return (
    currentUrl === baseUrl ||
    currentUrl.endsWith('/#/') ||
    currentUrl.endsWith('/pc/index.html#/') ||
    currentUrl === 'about:blank'
  )
}

function slugify(value: string): string {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return compact.replace(/(^-|-$)/g, '') || 'run'
}

function sanitizePayloadPreview(raw: string): string {
  if (!raw) {
    return ''
  }

  return raw
    .replace(/("password"\s*:\s*")[^"]+(")/gi, '$1***$2')
    .replace(/("captcha"\s*:\s*")[^"]+(")/gi, '$1***$2')
    .replace(/("mobile"\s*:\s*")[^"]+(")/gi, '$1***$2')
    .slice(0, 1_200)
}

function extractUploadData(details: Electron.OnBeforeRequestListenerDetails): string {
  if (!Array.isArray(details.uploadData)) {
    return ''
  }

  const chunks = details.uploadData.flatMap((part) => {
    if (typeof part.bytes === 'string') {
      return [part.bytes]
    }

    if (part.bytes) {
      try {
        return [Buffer.from(part.bytes).toString('utf8')]
      } catch {
        return []
      }
    }

    if (part.file) {
      return [`[file:${part.file}]`]
    }

    return []
  })

  return chunks.join('&')
}

function toCookieSetDetails(cookie: Electron.Cookie): Electron.CookiesSetDetails | null {
  const domain = (cookie.domain ?? '').replace(/^\./, '')
  if (!domain || !cookie.name) {
    return null
  }

  const url = `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`
  return {
    url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expirationDate,
    sameSite: cookie.sameSite
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  key: string
): string | undefined {
  if (!headers) {
    return undefined
  }

  const direct = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()]
  if (Array.isArray(direct)) {
    return direct[0]
  }
  if (typeof direct === 'string') {
    return direct
  }

  const matchedKey = Object.keys(headers).find((entry) => entry.toLowerCase() === key.toLowerCase())
  const value = matchedKey ? headers[matchedKey] : undefined

  return Array.isArray(value) ? value[0] : value
}

function classifyNetworkPurpose(url: string, method: string, resourceType: string) {
  const lower = url.toLowerCase()

  if (/login|logout|captcha|verify|auth/.test(lower)) {
    return {
      key: 'auth',
      label: '认证 / 登录状态',
      reason: '和登录、鉴权、验证码或登录态确认有关'
    }
  }

  if (/playauth|aliyun|alicdn|m3u8|mp4|vod|video_play|vid=/.test(lower)) {
    return {
      key: 'player',
      label: '播放器 / 视频资源',
      reason: '和视频鉴权、播放地址或流媒体资源有关'
    }
  }

  if (/progress|sco_progress|lesson_location|startendvos/.test(lower)) {
    return {
      key: 'progress',
      label: '学习进度',
      reason: '和观看轨迹、断点续播或进度上报有关'
    }
  }

  if (/assess|exam|evaluation|paper|score/.test(lower)) {
    return {
      key: 'evaluation',
      label: '评估 / 考核',
      reason: '和课程评估、考试或成绩有关'
    }
  }

  if (/class\/detail|class_course|participated_list|my_class|course\/detail/.test(lower)) {
    return {
      key: 'course',
      label: '课程信息',
      reason: '和课程列表、班级详情或章节数据有关'
    }
  }

  if (/\/api\//.test(lower) || method !== 'GET') {
    return {
      key: 'api',
      label: '通用接口',
      reason: '属于站点通用 API 请求'
    }
  }

  if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'script' || /png|jpg|jpeg|svg|css|js/.test(lower)) {
    return {
      key: 'asset',
      label: '静态资源',
      reason: '和图片、脚本、样式或静态资源有关'
    }
  }

  return {
    key: 'other',
    label: '其他请求',
    reason: '暂时无法归类到更明确的业务类别'
  }
}

function readLearningSessionFromPage(): LearningSessionState {
  const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
  const textFrom = (selector: string) => normalize(document.querySelector(selector)?.textContent)
  const currentUrl = window.location.href
  const appEl = document.querySelector('#App') as (HTMLElement & { __vue__?: any }) | null
  const walkVm = (vm: any, seen = new Set<any>()): any => {
    if (!vm || seen.has(vm)) {
      return null
    }
    seen.add(vm)
    if (vm.$refs?.player) {
      return vm
    }
    for (const child of vm.$children ?? []) {
      const found = walkVm(child, seen)
      if (found) {
        return found
      }
    }
    return null
  }
  const isVisible = (node: Element | null): boolean => {
    if (!(node instanceof HTMLElement)) {
      return false
    }
    const style = window.getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const rootVm = appEl?.__vue__
  const playerHostVm = walkVm(rootVm)
  const playObj = playerHostVm?.$store?.state?.playObj

  const hasProtectedNav = Array.from(document.querySelectorAll('.nav_bar .name'))
    .some((node) => isVisible(node))
  const hasClassList = Boolean(document.querySelector('.train_class_list .train_title'))
  const bodyText = normalize(document.body.innerText)
  const hasMyCourseList =
    (currentUrl.includes('/person_center/my_course') &&
      (/未完成课程|已完成课程|暂无课程信息/.test(bodyText) ||
        Boolean(document.querySelector('.course_list')) ||
        Boolean(document.querySelector('.course_class')) ||
        Boolean(document.querySelector('.my_course'))))
  const hasCourseDetail =
    Boolean(document.querySelector('.detail .detail_top .title')) ||
    Boolean(document.querySelector('.uncomplete_course'))
  const hasVideoPage =
    Boolean(document.querySelector('.video_center .title')) ||
    Boolean(document.querySelector('#player video')) ||
    Boolean(playerHostVm?.$refs?.player) ||
    Boolean(playObj)
  const phoneInput = document.querySelector('input[placeholder*="手机号"]')
  const passwordInput = document.querySelector('input[placeholder*="密码"], input[type="password"]')
  const hasLoginWidget =
    isVisible(document.querySelector('.login_box')) ||
    isVisible(document.querySelector('form.login-box')) ||
    (isVisible(phoneInput) && isVisible(passwordInput))
  const hasLoginButton = Array.from(document.querySelectorAll('button, span'))
    .some((node) => isVisible(node) && /登录/.test(normalize(node.textContent)))
  const hasPersonCenterUrl = currentUrl.includes('/person_center/')
  const hasSignedInHomeMarker =
    /用户已登录|欢迎您|安全退出|最近在学/.test(bodyText) &&
    !hasPersonCenterUrl

  const routeKind = (() => {
    if (hasVideoPage || currentUrl.includes('/video_play')) return 'video-play'
    if (hasCourseDetail || currentUrl.includes('show_details_id=')) return 'course-detail'
    if (hasProtectedNav && hasClassList) return 'my-classes'
    if (hasProtectedNav && hasMyCourseList) return 'my-course'
    if (hasSignedInHomeMarker) return 'home'
    if (hasLoginWidget || (currentUrl.endsWith('/#/') && hasLoginButton)) return 'login'
    if (currentUrl === 'https://www.nmpaied.com/pc/index.html#/' || currentUrl.endsWith('/#/')) return 'home'
    return 'other'
  })()

  const dialogTexts = Array.from(document.querySelectorAll('.el-dialog__wrapper'))
    .map((node) => {
      if (!(node instanceof HTMLElement)) {
        return ''
      }
      const style = window.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') {
        return ''
      }
      return normalize(node.textContent)
    })
    .filter(Boolean)

  const loginPromptVisible = dialogTexts.some((text) => /您还未登录，请登录后访问/.test(text))
  const continuePromptVisible = dialogTexts.some((text) => /是否继续学习/.test(text))
  const loginFormVisible = hasLoginWidget
  const captchaValue = (document.querySelector('input[placeholder*="验证码"]') as HTMLInputElement | null)?.value ?? ''
  const requiresCaptcha = loginFormVisible && captchaValue.trim().length === 0

  const visibleActions = Array.from(document.querySelectorAll('button, .submit, span, .menu_item span'))
    .map((node) => normalize(node.textContent))
    .filter((text) => text.length > 0 && /登录|个人中心|进入学习|开始学习|确 定|确定|继续学习|我的观看轨迹|目录/.test(text))
    .slice(0, 20)

  const videoElement = document.querySelector('video')
  const currentCourseTitle =
    textFrom('.video_center .title') ||
    textFrom('.header_loder .wrapper span:last-child') ||
    normalize(playObj?.course_name) ||
    normalize(playObj?.courseName)
  const currentChapterTitle =
    textFrom('.menu_item.currentChapter span') ||
    normalize(playObj?.sco_name) ||
    normalize(playObj?.chapter_name) ||
    normalize(playObj?.title)

  const parsePlayerTime = (value: string | null | undefined): number | undefined => {
    const raw = normalize(value)
    if (!raw || !/^\d+:\d{2}(?::\d{2})?$/.test(raw)) {
      return undefined
    }

    const parts = raw.split(':').map((item) => Number(item))
    if (parts.some((item) => Number.isNaN(item))) {
      return undefined
    }

    if (parts.length === 2) {
      return parts[0] * 60 + parts[1]
    }

    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2]
    }

    return undefined
  }

  const displayCurrentTime = parsePlayerTime(textFrom('.prism-time-display .current-time'))
  const displayDuration = parsePlayerTime(textFrom('.prism-time-display .duration'))
  const progressPlayed = document.querySelector('.prism-progress-played') as HTMLElement | null
  const progressPercentText = progressPlayed?.style.width?.replace('%', '').trim() ?? ''
  const progressPercent = progressPercentText ? Number(progressPercentText) : undefined
  const resolvedCurrentTime =
    displayCurrentTime ??
    (videoElement instanceof HTMLVideoElement && Number.isFinite(videoElement.currentTime)
      ? Number(videoElement.currentTime.toFixed(1))
      : undefined)
  const resolvedDuration =
    displayDuration ??
    (videoElement instanceof HTMLVideoElement && Number.isFinite(videoElement.duration)
      ? Number(videoElement.duration.toFixed(1))
      : undefined)

  const loginStatus = (() => {
    if (Boolean(playerHostVm?.$refs?.player) || Boolean(playObj)) return 'logged-in'
    if (routeKind === 'video-play' || routeKind === 'course-detail') return 'logged-in'
    if (routeKind === 'my-classes' && hasProtectedNav && hasClassList) return 'logged-in'
    if (routeKind === 'my-course' && hasProtectedNav) return 'logged-in'
    if (routeKind === 'home' && hasSignedInHomeMarker) return 'logged-in'
    if (hasPersonCenterUrl && hasProtectedNav && !hasLoginWidget) return 'logged-in'
    if (loginPromptVisible || routeKind === 'login' || hasLoginWidget) return 'logged-out'
    return 'unknown'
  })()

  return {
    loginStatus,
    routeKind,
    loginFormVisible,
    requiresCaptcha,
    loginPromptVisible,
    continuePromptVisible,
    currentUrl,
    title: document.title,
    currentCourseTitle: currentCourseTitle || undefined,
    currentChapterTitle: currentChapterTitle || undefined,
    visibleActions,
    video: videoElement instanceof HTMLVideoElement
      ? {
          exists: true,
          ready: videoElement.readyState >= 1,
          playing: !videoElement.paused && !videoElement.ended,
          paused: videoElement.paused,
          ended: videoElement.ended,
          currentTime: resolvedCurrentTime,
          duration: resolvedDuration,
          progressPercent: Number.isFinite(progressPercent) ? progressPercent : undefined
        }
      : {
          exists: false,
          ready: false,
          playing: false,
          paused: false,
          ended: false,
          progressPercent: undefined
        }
  }
}

function resolveManagedPointForAction(
  action: string,
  payload: Record<string, string> | null
): ClickPoint | null {
  const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()

  const isVisible = (node: Element | null): node is HTMLElement => {
    if (!(node instanceof HTMLElement)) {
      return false
    }
    const style = window.getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }

  const toPoint = (node: Element | null): ClickPoint | null => {
    if (!isVisible(node)) {
      return null
    }

    node.scrollIntoView({
      block: 'center',
      inline: 'center'
    })

    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return null
    }

    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    }
  }

  if (action === 'visible-text') {
    const regex = new RegExp(payload?.patternSource ?? '', 'i')
    const scopeRoot =
      payload?.scopeSelector && payload.scopeSelector.length > 0
        ? document.querySelector(payload.scopeSelector) ?? document
        : document

    const candidates = Array.from(scopeRoot.querySelectorAll('button, span, div.submit, a, [role="button"]'))
      .filter((node): node is HTMLElement => isVisible(node))
      .filter((node) => regex.test(normalize(node.textContent)))

    const target = candidates[0]
    if (!target) {
      return null
    }

    const clickable = target.closest('button, a, [role="button"]') ?? target
    return toPoint(clickable)
  }

  if (action === 'dialog-action') {
    const dialogRegex = new RegExp(payload?.dialogSource ?? '', 'i')
    const actionRegex = new RegExp(payload?.actionSource ?? '', 'i')

    const wrappers = Array.from(document.querySelectorAll('.el-dialog__wrapper'))
      .filter((node): node is HTMLElement => isVisible(node))
      .filter((node) => dialogRegex.test(normalize(node.textContent)))

    const wrapper = wrappers[0]
    if (!wrapper) {
      return null
    }

    const candidates = Array.from(wrapper.querySelectorAll('button, span, a'))
      .filter((node): node is HTMLElement => isVisible(node))
      .filter((node) => actionRegex.test(normalize(node.textContent)))

    const target = candidates[0]
    if (!target) {
      return null
    }

    const clickable = target.closest('button, a, [role="button"]') ?? target
    return toPoint(clickable)
  }

  if (action === 'preferred-class') {
    const items = Array.from(document.querySelectorAll('.train_class_list'))
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => {
        const statusText = normalize(
          Array.from(node.querySelectorAll('.train_close p'))
            .map((entry) => entry.textContent)
            .join(' ')
        )
        const button = Array.from(node.querySelectorAll('button'))
          .find((entry) => /进入学习/.test(normalize(entry.textContent))) as HTMLElement | undefined
        return { statusText, button }
      })
      .filter((item) => item.button)

    const preferred = items.find((item) => /未结业/.test(item.statusText)) ?? items[0]
    return preferred?.button ? toPoint(preferred.button) : null
  }

  if (action === 'next-lesson') {
    const items = Array.from(document.querySelectorAll('.uncomplete_course li'))
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => {
        const progressNode = node.querySelector('[role="progressbar"]') as HTMLElement | null
        const progressText = progressNode?.getAttribute('aria-valuenow') ?? '0'
        const progress = Number(progressText)
        const startButton = Array.from(node.querySelectorAll('.SaveButton .Save, .SaveButton .Cancel'))
          .find((entry) => /开始学习|继续学习/.test(normalize(entry.textContent))) as HTMLElement | undefined
        return { progress, startButton }
      })
      .filter((item) => item.startButton)

    if (items.length === 0) {
      return null
    }

    const inProgress = items
      .filter((item) => item.progress > 0 && item.progress < 100)
      .sort((left, right) => right.progress - left.progress)[0]
    const notStarted = items.find((item) => item.progress === 0)
    const preferred = inProgress ?? notStarted ?? items[0]

    return preferred?.startButton ? toPoint(preferred.startButton) : null
  }

  if (action === 'next-chapter') {
    const items = Array.from(document.querySelectorAll('.menu_item'))
      .filter((node): node is HTMLElement => isVisible(node))
    if (items.length === 0) {
      return null
    }

    const currentIndex = items.findIndex((node) => node.classList.contains('currentChapter'))
    const fallbackIndex = currentIndex >= 0 ? currentIndex : 0
    const nextItem = items[fallbackIndex + 1]
    return nextItem ? toPoint(nextItem) : null
  }

  if (action === 'video-play-button') {
    const target = Array.from(document.querySelectorAll('.prism-big-play-btn, .prism-play-btn'))
      .find((node) => isVisible(node))
    return target ? toPoint(target) : null
  }

  if (action === 'player-hover') {
    const player = document.querySelector('#player')
    if (!player || !isVisible(player)) {
      return null
    }

    const rect = player.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return null
    }

    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + Math.max(rect.height - 18, rect.height / 2))
    }
  }

  return null
}

function muteVideosOnPage(): void {
  document.querySelectorAll('video').forEach((node) => {
    if (node instanceof HTMLVideoElement) {
      node.muted = true
      node.volume = 0
      node.defaultMuted = true
    }
  })
}

function applyTrackedResumeOnPage(backtrackSeconds: number) {
  const appEl = document.querySelector('#App') as (HTMLElement & { __vue__?: any }) | null
  const GAP_TOLERANCE_SECONDS = 3
  const walk = (vm: any, seen = new Set<any>()): any => {
    if (!vm || seen.has(vm)) {
      return null
    }
    seen.add(vm)
    if (vm.$refs?.player && typeof vm.$refs.player.set_currentTime === 'function') {
      return vm
    }
    for (const child of vm.$children ?? []) {
      const found = walk(child, seen)
      if (found) {
        return found
      }
    }
    return null
  }

  const rootVm = appEl?.__vue__
  const hostVm = walk(rootVm)
  const playObj = hostVm?.$store?.state?.playObj
  const rawSegmentsSource =
    playObj?.startEndVos ??
    playObj?.progress?.startEndVos ??
    playObj?.sco_progress?.startEndVos ??
    playObj?.playRecord?.startEndVos ??
    []
  const rawSegments =
    typeof rawSegmentsSource === 'string'
      ? (() => {
          try {
            return JSON.parse(rawSegmentsSource)
          } catch {
            return []
          }
        })()
      : rawSegmentsSource
  const lessonLocation = Number(playObj?.lesson_location ?? 0)
  const duration = Number(playObj?.duration ?? (document.querySelector('video') as HTMLVideoElement | null)?.duration ?? 0)
  const target = Math.max(lessonLocation - backtrackSeconds, 0)
  const video = document.querySelector('video')

  const segments = Array.isArray(rawSegments)
    ? rawSegments
        .map((entry) => ({
          start: Number(entry?.start ?? 0),
          end: Number(entry?.end ?? 0)
        }))
        .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end))
        .map((entry) => ({
          start: Math.max(0, Math.min(entry.start, entry.end)),
          end: Math.max(entry.start, entry.end)
        }))
        .sort((left, right) => left.start - right.start || left.end - right.end)
    : []

  let coveredUntil = 0
  let hasContinuousCoverageFromStart = false

  for (const segment of segments) {
    if (!hasContinuousCoverageFromStart) {
      if (segment.start > GAP_TOLERANCE_SECONDS) {
        break
      }
      coveredUntil = Math.max(coveredUntil, segment.end)
      hasContinuousCoverageFromStart = true
      continue
    }

    if (segment.start <= coveredUntil + GAP_TOLERANCE_SECONDS) {
      coveredUntil = Math.max(coveredUntil, segment.end)
      continue
    }

    break
  }

  const derivedResumePoint = hasContinuousCoverageFromStart ? coveredUntil : lessonLocation
  const targetFromTrack = Math.max(derivedResumePoint - backtrackSeconds, 0)
  const effectiveTarget = Number.isFinite(targetFromTrack) && targetFromTrack > 0 ? targetFromTrack : target

  if (
    (!Number.isFinite(lessonLocation) || lessonLocation <= 1) &&
    (!Number.isFinite(derivedResumePoint) || derivedResumePoint <= 1)
  ) {
    return {
      applied: false,
      lessonLocation,
      target: effectiveTarget,
      derivedResumePoint,
      segments,
      reason: 'no-valid-progress'
    }
  }

  if (Number.isFinite(duration) && duration > 0 && derivedResumePoint >= duration - GAP_TOLERANCE_SECONDS) {
    return {
      applied: false,
      lessonLocation,
      target: effectiveTarget,
      derivedResumePoint,
      segments,
      reason: 'already-near-complete'
    }
  }

  let applied = false

  if (hostVm?.$refs?.player?.set_currentTime) {
    hostVm.$refs.player.set_currentTime(effectiveTarget)
    applied = true
  }

  if (video instanceof HTMLVideoElement) {
    try {
      video.currentTime = effectiveTarget
      applied = true
    } catch {
      // Ignore direct video seek failures.
    }

    void video.play().catch(() => undefined)
  }

  if (hostVm?.$refs?.player?.bindPlay) {
    hostVm.$refs.player.bindPlay()
  }

  return {
    applied,
    lessonLocation,
    target: effectiveTarget,
    derivedResumePoint,
    segments
  }
}

function forceResumePlaybackOnPage(): void {
  const candidates = Array.from(
    document.querySelectorAll('.prism-big-play-btn, .prism-play-btn')
  ).filter((node): node is HTMLElement => node instanceof HTMLElement)

  const target = candidates.find((node) => {
    const style = window.getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })

  target?.click()

  document.querySelectorAll('video').forEach((node) => {
    if (node instanceof HTMLVideoElement) {
      void node.play().catch(() => undefined)
    }
  })
}

function forcePausePlaybackOnPage(): void {
  document.querySelectorAll('video').forEach((node) => {
    if (node instanceof HTMLVideoElement) {
      try {
        node.pause()
      } catch {
        // Ignore pause failures.
      }
    }
  })
}
