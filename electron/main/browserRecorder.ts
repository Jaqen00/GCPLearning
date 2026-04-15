import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { chromium, type BrowserContext, type Frame, type Page, type Request, type Response } from 'playwright'
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

interface BrowserRecorderServiceOptions {
  profileDir: string
  tracesDir: string
  settingsFile: string
  baseUrl?: string
  onStateChange?: (state: RecorderState) => void
  onEvent?: (event: RecordedEvent) => void
}

interface BindingPayload {
  type: Extract<
    RecorderEventType,
    'click' | 'change' | 'navigation' | 'log' | 'video-ready' | 'video-playing' | 'video-paused' | 'video-ended'
  >
  url?: string
  title?: string
  selectors?: SelectorCandidate[]
  element?: RecordedElement
  data?: Record<string, unknown>
}

interface AppendEventInput {
  type: RecorderEventType
  page?: Page | null
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

export class BrowserRecorderService {
  private context: BrowserContext | null = null
  private currentPage: Page | null = null
  private managedPage: Page | null = null
  private readonly settingsFile: string
  private readonly onStateChange?: (state: RecorderState) => void
  private readonly onEvent?: (event: RecordedEvent) => void
  private readonly pageIds = new WeakMap<Page, string>()
  private readonly attachedPages = new WeakSet<Page>()
  private readonly requestIds = new WeakMap<Request, string>()
  private readonly traceEvents: RecordedEvent[] = []
  private automationTimer: NodeJS.Timeout | null = null
  private automationBusy = false
  private networkEventCounter = 0
  private networkLogFile: string | null = null
  private lastPlaybackObservation: PlaybackObservation | null = null
  private lastResumeAppliedKey: string | null = null
  private pageCounter = 0
  private eventCounter = 0
  private runId: string | null = null
  private runDir: string | null = null
  private lastClassDetailUrl: string | null = null
  private settingsLoaded = false
  private state: RecorderState

  constructor(options: BrowserRecorderServiceOptions) {
    this.settingsFile = options.settingsFile
    this.onStateChange = options.onStateChange
    this.onEvent = options.onEvent
    this.state = {
      status: 'idle',
      baseUrl: options.baseUrl ?? DEFAULT_COURSE_URL,
      isBrowserOpen: false,
      isRecording: false,
      profilePath: options.profileDir,
      recordingsPath: options.tracesDir,
      eventCount: 0,
      networkCaptureEnabled: true,
      networkEventCount: 0,
      networkPurposeCounts: {},
      settings: defaultAppSettings(),
      siteHints: [
        '入口页是 Vite 单页应用，路由切换会走 hash 或前端导航。',
        '站点使用阿里播放器，后续可以专门监听播放器状态。',
        '已在前端 bundle 里看到 course_play、assess_list、course_exam 等路由关键词。'
      ]
    }
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

    if (session.routeKind === 'video-play') {
      this.startAutomationLoop()
      return this.createLearningResult(
        session,
        session.video.exists
          ? '已进入课程播放页，客户端会持续监控播放进度和继续学习提示。'
          : '已进入课程播放页。当前播放器还在初始化。'
        ,
        'none'
      )
    }

    this.startAutomationLoop()
    return this.createLearningResult(
      session,
      '已经推进到课程相关页面，但还没完全稳定进入播放页。当前需要人工关注一次。',
      'manual-attention'
    )
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
    const page = await this.ensurePage(this.state.baseUrl)
    const session = await this.readLearningSession(page)
    this.setState({
      session
    })
    return session
  }

  async submitLoginAfterCaptcha(): Promise<LearningSessionState> {
    const page = await this.ensurePage(this.state.baseUrl)
    await this.clickVisibleText(page, /^登录$/)
    await page.waitForTimeout(1_800)
    await this.refreshActivePage(page)
    return this.inspectSession()
  }

  async openMyClasses(): Promise<LearningSessionState> {
    const page = await this.ensurePage(DEFAULT_MY_CLASSES_URL)
    await page.goto(DEFAULT_MY_CLASSES_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1_000)
    await this.refreshActivePage(page)
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

    const page = await this.ensurePage(DEFAULT_MY_CLASSES_URL)
    if (session.routeKind === 'my-classes') {
      const selected = await this.openPreferredClassFromMyClasses(page)
      if (!selected) {
        return this.inspectSession()
      }
      await page.waitForTimeout(800)
      this.lastClassDetailUrl = page.url()
      session = await this.inspectSession()
    }

    if (session.routeKind === 'course-detail') {
      this.lastClassDetailUrl = page.url()
      const started = await this.startNextLessonFromDetail()
      if (!started) {
        return this.inspectSession()
      }
    }

    const popup = await this.waitForPageMatching('/video_play', 8_000)
    if (popup) {
      this.currentPage = popup
      await popup.bringToFront().catch(() => undefined)
      await popup.waitForTimeout(800)
      await this.refreshActivePage(popup)
    } else {
      await this.refreshActivePage(page)
    }

    return this.inspectSession()
  }

  async acknowledgeContinuePrompt(): Promise<LearningSessionState> {
    const page = await this.ensurePage(this.state.baseUrl)
    const clicked =
      (await this.clickDialogButtonWithLocator(page, /是否继续学习/, /确\s*定/)) ||
      (await this.clickVisibleDialogAction(page, /是否继续学习/, /^确\s*定$/))
    if (clicked) {
      await page.waitForTimeout(800)
      await this.resumeVideoPlayback()
    }
    await this.refreshActivePage(page)
    return this.inspectSession()
  }

  async openBrowser(targetUrl?: string): Promise<RecorderState> {
    const nextUrl = targetUrl?.trim() || this.state.baseUrl || DEFAULT_COURSE_URL
    await mkdir(this.state.profilePath, { recursive: true })
    await mkdir(this.state.recordingsPath, { recursive: true })
    this.networkLogFile = join(this.state.recordingsPath, 'live-network-log.jsonl')
    this.setState({
      status: 'launching',
      baseUrl: nextUrl,
      networkLogPath: this.networkLogFile,
      lastError: undefined
    })

    try {
      if (!this.context) {
        this.context = await chromium.launchPersistentContext(this.state.profilePath, {
          headless: false,
          viewport: null,
          args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
        })
        await this.installBindings(this.context)
        this.attachNetworkObservers(this.context)
        this.context.on('page', (page) => {
          void this.attachPage(page, 'page')
        })
        this.context.on('close', () => {
          this.context = null
          this.currentPage = null
          this.setState({
            isBrowserOpen: false,
            isRecording: false,
            status: 'idle',
            activePageTitle: undefined,
            activePageUrl: undefined
          })
        })
      }

      let page = this.currentPage
      if (!page || page.isClosed()) {
        page = this.context.pages()[0] ?? (await this.context.newPage())
      }

      await this.attachPage(page, 'initial')
      this.currentPage = page
      await page.bringToFront().catch(() => undefined)
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded' })
      await this.refreshActivePage(page)
      this.setState({
        isBrowserOpen: true,
        status: this.state.isRecording ? 'recording' : 'ready',
        baseUrl: nextUrl
      })
      return this.getState()
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = /ProcessSingleton|SingletonLock|profile directory/i.test(rawMessage)
        ? '学习浏览器的用户资料正在被另一个窗口占用。请先关闭旧的学习浏览器，再重新尝试。'
        : rawMessage
      this.setState({
        status: 'error',
        lastError: message
      })
      throw new Error(message)
    }
  }

  async startRecording(label?: string): Promise<RecorderState> {
    if (!this.context || !this.currentPage) {
      await this.openBrowser(this.state.baseUrl)
    }

    this.traceEvents.splice(0, this.traceEvents.length)
    this.eventCounter = 0
    const labelPart = slugify(label || 'manual-pass')
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
      page: this.currentPage,
      description: label
        ? `Started recording run: ${label}`
        : 'Started recording a manual course walk-through'
    })

    return this.getState()
  }

  async stopRecording(): Promise<RecorderState> {
    if (!this.state.isRecording) {
      return this.getState()
    }

    await this.appendEvent({
      type: 'recording-stopped',
      page: this.currentPage,
      description: 'Stopped recording and prepared the trace bundle'
    })

    this.setState({
      isRecording: false,
      status: this.context ? 'ready' : 'idle'
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
    if (this.context) {
      await this.context.close().catch(() => undefined)
    }
    this.context = null
    this.currentPage = null
  }

  private setState(partial: Partial<RecorderState>): void {
    this.state = {
      ...this.state,
      ...partial
    }
    this.onStateChange?.(this.getState())
  }

  private async installBindings(context: BrowserContext): Promise<void> {
    await context.exposeBinding('__courseRecorderEvent', async (source, payload) => {
      const page = source.page ?? this.currentPage
      if (!page) {
        return
      }
      await this.handleBindingEvent(page, source.frame, payload as BindingPayload)
    })

    await context.addInitScript(() => {
      const globalScope = window as Window & {
        __courseRecorderInstalled?: boolean
        __courseRecorderEvent?: (payload: unknown) => void
      }

      if (globalScope.__courseRecorderInstalled) {
        return
      }

      globalScope.__courseRecorderInstalled = true

      const INTERACTIVE_SELECTOR = [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        '[type="button"]',
        '[type="submit"]',
        '.el-button',
        '.submit',
        '.menu_item',
        '.hover_active',
        '.login_active',
        '.login_btn'
      ].join(', ')

      const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

      const addSelector = (
        selectors: SelectorCandidate[],
        kind: SelectorCandidate['kind'],
        value: string | undefined
      ) => {
        if (!value || selectors.some((selector) => selector.kind === kind && selector.value === value)) {
          return
        }
        selectors.push({ kind, value })
      }

      const textSnippet = (element: Element | null): string | undefined => {
        const raw = normalizeWhitespace(element?.textContent ?? '')
        if (!raw) {
          return undefined
        }
        return raw.slice(0, 80)
      }

      const currentChapterText = (): string | undefined => {
        const currentChapter = document.querySelector('.menu_item.currentChapter span')
        return normalizeWhitespace(currentChapter?.textContent ?? '') || undefined
      }

      const toHtmlElement = (target: EventTarget | null): HTMLElement | null => {
        if (target instanceof HTMLElement) {
          return target
        }
        if (target instanceof Element) {
          return target.closest('svg, i, img, div, span') as HTMLElement | null
        }
        return null
      }

      const resolveInteractiveTarget = (target: EventTarget | null): HTMLElement | null => {
        const element = toHtmlElement(target)
        if (!element) {
          return null
        }

        const closest = element.closest(INTERACTIVE_SELECTOR)
        if (closest instanceof HTMLElement) {
          return closest
        }

        return element
      }

      const resolveFieldTarget = (
        target: EventTarget | null
      ): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null => {
        const element = toHtmlElement(target)
        if (!element) {
          return null
        }

        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) {
          return element
        }

        const field = element.closest('input, textarea, select')
        if (
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement ||
          field instanceof HTMLSelectElement
        ) {
          return field
        }

        return null
      }

      const selectPath = (element: Element | null): string | undefined => {
        if (!element || !(element instanceof Element)) {
          return undefined
        }

        const segments: string[] = []
        let current: Element | null = element

        while (current && current.nodeType === Node.ELEMENT_NODE && segments.length < 5) {
          const tag = current.tagName.toLowerCase()
          if ((current as HTMLElement).id) {
            segments.unshift(`${tag}#${(current as HTMLElement).id}`)
            break
          }

          let selector = tag
          const stableClasses = [...current.classList]
            .filter((name) => /^el-|^menu_|^hover_|^login_|^submit$|^currentChapter$/.test(name))
            .slice(0, 2)
          if (stableClasses.length > 0) {
            selector += stableClasses.map((name) => `.${name}`).join('')
            segments.unshift(selector)
            current = current.parentElement
            continue
          }

          const parent = current.parentElement
          if (parent) {
            const siblings = Array.from(parent.children).filter((node) => node.tagName === current?.tagName)
            if (siblings.length > 1) {
              selector += `:nth-of-type(${siblings.indexOf(current) + 1})`
            }
          }

          segments.unshift(selector)
          current = current.parentElement
        }

        return segments.join(' > ')
      }

      const classifySensitivity = (
        field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      ): 'plain' | 'phone' | 'account' | 'captcha' | 'password' => {
        const marker = `${field.getAttribute('type') || ''} ${field.getAttribute('name') || ''} ${
          field.getAttribute('id') || ''
        } ${field.getAttribute('placeholder') || ''} ${field.getAttribute('aria-label') || ''}`

        if (/password|pass|pwd|密码/i.test(marker)) {
          return 'password'
        }
        if (/captcha|auth.?code|验证码|校验码/i.test(marker)) {
          return 'captcha'
        }
        if (/mobile|phone|手机号/i.test(marker)) {
          return 'phone'
        }
        if (/account|username|user.?name|账号|用户名/i.test(marker)) {
          return 'account'
        }
        return 'plain'
      }

      const maskValuePreview = (
        value: string,
        sensitivity: 'plain' | 'phone' | 'account' | 'captcha' | 'password'
      ): string => {
        if (sensitivity === 'password' || sensitivity === 'captcha') {
          return '[redacted]'
        }
        if (sensitivity === 'phone') {
          return value.length >= 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : '[redacted]'
        }
        if (sensitivity === 'account') {
          return value.length > 4 ? `${value.slice(0, 2)}****${value.slice(-1)}` : '[redacted]'
        }
        return value.slice(0, 80)
      }

      const serializeElement = (target: EventTarget | null) => {
        const element = resolveInteractiveTarget(target)
        if (!element) {
          return undefined
        }

        const selectors: SelectorCandidate[] = []
        const text = textSnippet(element)
        const ariaLabel = element.getAttribute('aria-label') || undefined
        const placeholder =
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
            ? element.getAttribute('placeholder') || undefined
            : undefined
        const role = element.getAttribute('role') || undefined
        const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') || undefined : undefined
        const cssPath = selectPath(element)

        addSelector(selectors, 'id', element.id ? `#${element.id}` : undefined)
        addSelector(selectors, 'placeholder', placeholder)
        addSelector(selectors, 'href', href)
        addSelector(selectors, 'role', role)
        addSelector(selectors, 'attr', ariaLabel ? `[aria-label="${ariaLabel}"]` : undefined)

        if (element.getAttribute('name')) {
          addSelector(selectors, 'attr', `[name="${element.getAttribute('name')}"]`)
        }

        if (element.classList.length > 0) {
          addSelector(
            selectors,
            'class',
            [...element.classList]
              .filter((name) => /^el-|^menu_|^hover_|^login_|^submit$|^currentChapter$/.test(name))
              .slice(0, 3)
              .map((name) => `.${name}`)
              .join('')
          )
        }

        addSelector(selectors, 'text', text)
        addSelector(selectors, 'css', cssPath)

        return {
          element: {
            tagName: element.tagName.toLowerCase(),
            text,
            id: element.id || undefined,
            name: element.getAttribute('name') || undefined,
            classes: [...element.classList].slice(0, 6),
            ariaLabel,
            placeholder,
            role,
            href
          },
          selectors
        }
      }

      const send = (payload: Record<string, unknown>) => {
        try {
          globalScope.__courseRecorderEvent?.({
            ...payload,
            url: window.location.href,
            title: document.title
          })
        } catch {
          // Ignore recorder transport failures inside the page.
        }
      }

      document.addEventListener(
        'click',
        (event) => {
          const meta = serializeElement(event.target)
          send({
            type: 'click',
            ...meta,
            data: {
              clientX: event.clientX,
              clientY: event.clientY
            }
          })
        },
        true
      )

      document.addEventListener(
        'change',
        (event) => {
          const field = resolveFieldTarget(event.target)
          const meta = serializeElement(field)
          const sensitivity = field ? classifySensitivity(field) : 'plain'
          const rawValue = field ? String(field.value) : ''
          const valuePreview = rawValue ? maskValuePreview(rawValue, sensitivity) : undefined

          send({
            type: 'change',
            ...meta,
            data: {
              valuePreview,
              valueLength: rawValue.length || undefined,
              sensitivity,
              sensitive: sensitivity !== 'plain',
              fieldLabel:
                field?.getAttribute('placeholder') ||
                field?.getAttribute('aria-label') ||
                field?.getAttribute('name') ||
                field?.getAttribute('id') ||
                undefined
            }
          })
        },
        true
      )

      window.addEventListener('hashchange', () => {
        send({
          type: 'navigation',
          data: {
            reason: 'hashchange'
          }
        })
      })

      const sendVideoState = (
        video: HTMLVideoElement,
        type: 'video-ready' | 'video-playing' | 'video-paused' | 'video-ended'
      ) => {
        send({
          type,
          element: {
            tagName: 'video',
            text: currentChapterText()
          },
          data: {
            currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(1)) : undefined,
            duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(1)) : undefined,
            currentChapter: currentChapterText(),
            src: video.currentSrc || video.getAttribute('src') || undefined
          }
        })
      }

      const instrumentVideo = (video: HTMLVideoElement) => {
        if (video.dataset.courseRecorderVideoBound === '1') {
          return
        }

        video.dataset.courseRecorderVideoBound = '1'
        video.addEventListener('loadedmetadata', () => sendVideoState(video, 'video-ready'))
        video.addEventListener('play', () => sendVideoState(video, 'video-playing'))
        video.addEventListener('pause', () => {
          if (!video.ended) {
            sendVideoState(video, 'video-paused')
          }
        })
        video.addEventListener('ended', () => sendVideoState(video, 'video-ended'))

        if (video.readyState >= 1) {
          sendVideoState(video, 'video-ready')
        }
      }

      const scanVideos = () => {
        document.querySelectorAll('video').forEach((node) => {
          if (node instanceof HTMLVideoElement) {
            instrumentVideo(node)
          }
        })
      }

      let lastDialogSignature = ''
      let lastDialogSentAt = 0

      const maybeSendDialog = (modalNode: HTMLElement) => {
        const text = textSnippet(modalNode)
        const signature = `${window.location.href}::${text || modalNode.className}`
        const now = Date.now()

        if (signature === lastDialogSignature && now - lastDialogSentAt < 1_500) {
          return
        }

        lastDialogSignature = signature
        lastDialogSentAt = now

        send({
          type: 'log',
          element: {
            tagName: modalNode.tagName.toLowerCase(),
            text
          },
          data: {
            note: 'Possible dialog or popup became visible'
          }
        })
      }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) {
              continue
            }

            const marker = [
              node.className,
              node.getAttribute('role'),
              node.id,
              node.getAttribute('aria-modal')
            ]
              .filter(Boolean)
              .join(' ')

            if (/dialog|modal|popup|el-dialog/i.test(marker)) {
              maybeSendDialog(node)
            }

            if (node instanceof HTMLVideoElement) {
              instrumentVideo(node)
            }

            node.querySelectorAll('video').forEach((videoNode) => {
              if (videoNode instanceof HTMLVideoElement) {
                instrumentVideo(videoNode)
              }
            })
          }
        }
      })

      const startObserver = () => {
        scanVideos()
        if (document.body) {
          observer.observe(document.body, {
            subtree: true,
            childList: true
          })
        }
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true })
      } else {
        startObserver()
      }
    })
  }

  private async handleBindingEvent(page: Page, frame: Frame | undefined, payload: BindingPayload) {
    this.currentPage = page
    await this.refreshActivePage(page, payload.url, payload.title)

    if (!this.state.isRecording) {
      return
    }

    const description = describeBindingPayload(payload)
    await this.appendEvent({
      type: payload.type,
      page,
      description,
      selectors: payload.selectors,
      element: payload.element,
      captureArtifacts:
        payload.type !== 'change' &&
        payload.type !== 'video-ready' &&
        payload.type !== 'video-playing' &&
        payload.type !== 'video-paused' &&
        payload.type !== 'video-ended' &&
        payload.data?.sensitive !== true,
      data: {
        ...(payload.data ?? {}),
        frameUrl: frame?.url()
      }
    })
  }

  private attachNetworkObservers(context: BrowserContext): void {
    context.on('request', (request) => {
      void this.captureRequest(request)
    })

    context.on('response', (response) => {
      void this.captureResponse(response)
    })
  }

  private async captureRequest(request: Request): Promise<void> {
    const id = `net_${Date.now()}_${++this.networkEventCounter}`
    this.requestIds.set(request, id)
    const purpose = classifyNetworkPurpose(request.url(), request.method(), request.resourceType())
    const payload = sanitizePayloadPreview(request.postData() ?? '')

    await this.appendNetworkRecord({
      id,
      phase: 'request',
      timestamp: new Date().toISOString(),
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      purpose: purpose.key,
      purposeLabel: purpose.label,
      purposeReason: purpose.reason,
      postDataPreview: payload || undefined
    })
  }

  private async captureResponse(response: Response): Promise<void> {
    const request = response.request()
    const id = this.requestIds.get(request) ?? `net_${Date.now()}_${++this.networkEventCounter}`
    const purpose = classifyNetworkPurpose(request.url(), request.method(), request.resourceType())
    const headers = response.headers()
    const contentType = headers['content-type'] ?? headers['Content-Type']
    const responsePreview =
      shouldCaptureResponsePreview(request.resourceType(), contentType)
        ? sanitizePayloadPreview(await response.text().catch(() => ''))
        : undefined

    await this.appendNetworkRecord({
      id,
      phase: 'response',
      timestamp: new Date().toISOString(),
      method: request.method(),
      resourceType: request.resourceType(),
      url: response.url(),
      purpose: purpose.key,
      purposeLabel: purpose.label,
      purposeReason: purpose.reason,
      status: response.status(),
      contentType,
      responsePreview
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

  private async attachPage(page: Page, reason: 'initial' | 'page'): Promise<void> {
    if (this.attachedPages.has(page)) {
      return
    }

    this.attachedPages.add(page)
    this.pageIds.set(page, `page_${++this.pageCounter}`)
    this.currentPage = page

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) {
        return
      }

      this.currentPage = page
      void this.refreshActivePage(page, frame.url())

      if (this.state.isRecording) {
        void this.appendEvent({
          type: 'navigation',
          page,
          description: 'Main frame navigated to a new page state',
          data: {
            reason: 'framenavigated'
          },
          overrideUrl: frame.url()
        })
      }
    })

    page.on('popup', (popup) => {
      void this.attachPage(popup, 'page')
      if (this.state.isRecording) {
        void this.appendEvent({
          type: 'popup',
          page,
          description: 'Opened a popup or a new browser tab',
          data: {
            popupUrl: popup.url()
          }
        })
      }
    })

    page.on('dialog', (dialog) => {
      if (this.state.isRecording) {
        void this.appendEvent({
          type: 'log',
          page,
          description: `Browser dialog appeared: ${dialog.message().slice(0, 120)}`
        })
      }
    })

    page.on('close', () => {
      if (this.currentPage === page) {
        const remainingPage = this.context?.pages().find((entry) => !entry.isClosed()) ?? null
        this.currentPage = remainingPage
        if (remainingPage) {
          void this.refreshActivePage(remainingPage)
        } else {
          this.setState({
            activePageTitle: undefined,
            activePageUrl: undefined
          })
        }
      }
    })

    await this.refreshActivePage(page)

    if (reason === 'page' && this.state.isRecording) {
      await this.appendEvent({
        type: 'page-opened',
        page,
        description: 'Detected a newly opened page or tab'
      })
    }
  }

  private async appendEvent(input: AppendEventInput): Promise<void> {
    const page = input.page ?? this.currentPage
    const eventId = `evt_${Date.now()}_${++this.eventCounter}`
    const event: RecordedEvent = {
      id: eventId,
      runId: this.runId ?? undefined,
      type: input.type,
      timestamp: new Date().toISOString(),
      pageId: page ? this.getPageId(page) : 'page_unknown',
      pageUrl: input.overrideUrl ?? (page ? page.url() : this.state.activePageUrl ?? this.state.baseUrl),
      pageTitle:
        input.overrideTitle ??
        (page ? await page.title().catch(() => this.state.activePageTitle) : this.state.activePageTitle),
      description: input.description,
      selectors: input.selectors?.slice(0, 6),
      element: input.element,
      data: input.data
    }

    if (this.runDir && page && !page.isClosed() && input.captureArtifacts !== false) {
      const artifacts = await this.captureArtifacts(page, eventId)
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

  private async captureArtifacts(
    page: Page,
    eventId: string
  ): Promise<{ screenshotPath?: string; snapshotPath?: string }> {
    if (!this.runDir) {
      return {}
    }

    const screenshotPath = join('screenshots', `${eventId}.png`)
    const snapshotPath = join('snapshots', `${eventId}.html`)
    let html: string | undefined

    await this.maskSensitiveFieldsForArtifacts(page)

    try {
      await page
        .screenshot({
          path: join(this.runDir, screenshotPath),
          fullPage: true,
          timeout: 5_000
        })
        .catch(() => undefined)

      html = await page.content().catch(() => undefined)
      if (html) {
        await writeFile(join(this.runDir, snapshotPath), html, 'utf8').catch(() => undefined)
      }
    } finally {
      await this.restoreSensitiveFieldsAfterArtifacts(page)
    }

    return {
      screenshotPath,
      snapshotPath: html ? snapshotPath : undefined
    }
  }

  private async maskSensitiveFieldsForArtifacts(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        const globalScope = window as Window & {
          __courseRecorderMaskedInputs?: Array<{ key: string; value: string; type?: string }>
        }

        const classify = (
          field: HTMLInputElement | HTMLTextAreaElement
        ): 'plain' | 'phone' | 'account' | 'captcha' | 'password' => {
          const marker = `${field.getAttribute('type') || ''} ${field.getAttribute('name') || ''} ${
            field.getAttribute('id') || ''
          } ${field.getAttribute('placeholder') || ''} ${field.getAttribute('aria-label') || ''}`

          if (/password|pass|pwd|密码/i.test(marker)) {
            return 'password'
          }
          if (/captcha|auth.?code|验证码|校验码/i.test(marker)) {
            return 'captcha'
          }
          if (/mobile|phone|手机号/i.test(marker)) {
            return 'phone'
          }
          if (/account|username|user.?name|账号|用户名/i.test(marker)) {
            return 'account'
          }
          return 'plain'
        }

        const maskValue = (
          value: string,
          sensitivity: 'plain' | 'phone' | 'account' | 'captcha' | 'password'
        ): string => {
          if (sensitivity === 'password' || sensitivity === 'captcha') {
            return '********'
          }
          if (sensitivity === 'phone') {
            return value.length >= 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : '********'
          }
          if (sensitivity === 'account') {
            return value.length > 4 ? `${value.slice(0, 2)}****${value.slice(-1)}` : '********'
          }
          return value
        }

        const maskedInputs: Array<{ key: string; value: string; type?: string }> = []
        const fields = Array.from(document.querySelectorAll('input, textarea'))

        fields.forEach((field, index) => {
          if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
            return
          }

          const rawValue = field.value
          if (!rawValue) {
            return
          }

          const sensitivity = classify(field)
          if (sensitivity === 'plain') {
            return
          }

          const key = `course-recorder-mask-${index}`
          maskedInputs.push({
            key,
            value: rawValue,
            type: field instanceof HTMLInputElement ? field.type : undefined
          })

          field.setAttribute('data-course-recorder-mask-key', key)
          field.setAttribute('value', maskValue(rawValue, sensitivity))
          field.value = maskValue(rawValue, sensitivity)

          if (field instanceof HTMLInputElement && sensitivity === 'password') {
            field.setAttribute('data-course-recorder-original-type', field.type)
            field.type = 'text'
          }
        })

        globalScope.__courseRecorderMaskedInputs = maskedInputs
      })
      .catch(() => undefined)
  }

  private async restoreSensitiveFieldsAfterArtifacts(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        const globalScope = window as Window & {
          __courseRecorderMaskedInputs?: Array<{ key: string; value: string; type?: string }>
        }

        for (const record of globalScope.__courseRecorderMaskedInputs ?? []) {
          const field = document.querySelector(
            `[data-course-recorder-mask-key="${record.key}"]`
          )

          if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
            continue
          }

          field.value = record.value
          field.setAttribute('value', record.value)
          field.removeAttribute('data-course-recorder-mask-key')

          if (field instanceof HTMLInputElement) {
            const originalType = field.getAttribute('data-course-recorder-original-type')
            if (originalType) {
              field.type = originalType
              field.removeAttribute('data-course-recorder-original-type')
            }
          }
        }

        globalScope.__courseRecorderMaskedInputs = []
      })
      .catch(() => undefined)
  }

  private async persistTrace(): Promise<void> {
    if (!this.runDir) {
      return
    }

    const manifest = {
      runId: this.runId,
      generatedAt: new Date().toISOString(),
      baseUrl: this.state.baseUrl,
      profilePath: this.state.profilePath,
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
      session: session,
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

  private async ensureLoggedInForLearning(
    session: LearningSessionState
  ): Promise<LearningSessionState> {
    if (session.loginStatus === 'logged-in') {
      return session
    }

    return session
  }

  private resolveLoginFailureResult(session: LearningSessionState): LearningRunResult {
    this.startAutomationLoop()

    if (session.loginStatus === 'logged-out' || session.loginFormVisible) {
      return this.createLearningResult(
        session,
        '当前尚未登录。请在学习浏览器里手动完成登录，系统会持续检测，一旦登录成功会自动继续进入学习。',
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
    if (this.state.isRecording || this.automationBusy || !this.context || !this.currentPage || this.currentPage.isClosed()) {
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
    const page = await this.ensurePage(this.state.baseUrl)

    const currentUrl = page.url()
    const isHomeLike =
      currentUrl === this.state.baseUrl ||
      currentUrl.endsWith('/#/') ||
      currentUrl.endsWith('/pc/index.html#/') ||
      currentUrl === 'about:blank'

    if (!isHomeLike) {
      await page.goto(this.state.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
      await page.waitForTimeout(900)
    }

    let session = await this.inspectSession()
    if (session.loginStatus === 'unknown') {
      await page.waitForTimeout(1200)
      session = await this.inspectSession()
    }

    return session
  }

  private async ensurePage(targetUrl?: string): Promise<Page> {
    if (!this.context || !this.currentPage || this.currentPage.isClosed()) {
      await this.openBrowser(targetUrl)
    }

    const page = this.currentPage ?? this.context?.pages()[0]
    if (!page) {
      throw new Error('No active course browser page is available.')
    }

    this.currentPage = page
    return page
  }

  private async observePlaybackState(): Promise<LearningSessionState['video'] | null> {
    const page = await this.ensurePage(this.state.baseUrl)
    const sessionBefore = this.state.session
    if (sessionBefore?.routeKind !== 'video-play' && !page.url().includes('/video_play')) {
      return null
    }

    await this.refreshPlayerTelemetry(page)
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

  private async refreshPlayerTelemetry(page: Page): Promise<void> {
    const player = page.locator('#player').first()
    if ((await player.count()) === 0) {
      return
    }

    const box = await player.boundingBox().catch(() => null)
    if (!box) {
      return
    }

    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 18).catch(() => undefined)
    await page.waitForTimeout(120)
  }

  private async applyPlaybackSettings(page: Page): Promise<void> {
    const settings = await this.ensureSettingsLoaded()
    if (!settings.mutePlaybackOnOpen) {
      return
    }

    await page
      .evaluate(() => {
        document.querySelectorAll('video').forEach((node) => {
          if (node instanceof HTMLVideoElement) {
            node.muted = true
            node.volume = 0
            node.defaultMuted = true
          }
        })
      })
      .catch(() => undefined)
  }

  private async applyTrackedResumeIfNeeded(
    page: Page,
    session: LearningSessionState
  ): Promise<void> {
    const settings = await this.ensureSettingsLoaded()
    if (!settings.resumeFromTrackedProgressOnOpen || session.routeKind !== 'video-play') {
      return
    }

    const resumeKey =
      `${session.currentCourseTitle ?? ''}::${session.currentChapterTitle ?? ''}` ||
      page.url()

    if (resumeKey === this.lastResumeAppliedKey) {
      return
    }

    const result = await page
      .evaluate(async (backtrackSeconds) => {
        const appEl = document.querySelector('#App') as HTMLElement & { __vue__?: any } | null
        const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()

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
        const lessonLocation = Number(playObj?.lesson_location ?? 0)
        const target = Math.max(lessonLocation - backtrackSeconds, 0)
        const video = document.querySelector('video')

        if (!Number.isFinite(lessonLocation) || lessonLocation <= 1 || target <= 0) {
          return {
            applied: false,
            lessonLocation,
            target,
            reason: 'no-valid-progress'
          }
        }

        let applied = false

        if (hostVm?.$refs?.player?.set_currentTime) {
          hostVm.$refs.player.set_currentTime(target)
          applied = true
        }

        if (video instanceof HTMLVideoElement) {
          try {
            video.currentTime = target
            applied = true
          } catch {
            // Ignore direct video seek failures.
          }

          try {
            await video.play()
          } catch {
            // autoplay can be blocked; the page player resume is still attempted below.
          }
        }

        if (hostVm?.$refs?.player?.bindPlay) {
          hostVm.$refs.player.bindPlay()
        }

        return {
          applied,
          lessonLocation,
          target,
          title: normalize(document.querySelector('.video_center .title')?.textContent),
          chapter: normalize(document.querySelector('.menu_item.currentChapter span')?.textContent)
        }
      }, 10)
      .catch(() => null)

    if (result?.applied) {
      this.lastResumeAppliedKey = resumeKey
      await page.waitForTimeout(400)
    }
  }

  private async readLearningSession(page: Page): Promise<LearningSessionState> {
    const fallbackUrl = page.url() || this.state.baseUrl
    const fallbackTitle = await page.title().catch(() => this.state.activePageTitle)

    const session = await page
      .evaluate(() => {
        const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
        const textFrom = (selector: string) => normalize(document.querySelector(selector)?.textContent)
        const currentUrl = window.location.href
        const isVisible = (node: Element | null): boolean => {
          if (!(node instanceof HTMLElement)) {
            return false
          }
          const style = window.getComputedStyle(node)
          return style.display !== 'none' && style.visibility !== 'hidden'
        }

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
        const hasCourseDetail = Boolean(document.querySelector('.detail .detail_top .title')) || Boolean(document.querySelector('.uncomplete_course'))
        const hasVideoPage = Boolean(document.querySelector('.video_center .title')) || Boolean(document.querySelector('#player video'))
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
        const currentCourseTitle = textFrom('.video_center .title') || textFrom('.header_loder .wrapper span:last-child')
        const currentChapterTitle = textFrom('.menu_item.currentChapter span')
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
        } satisfies LearningSessionState
      })
      .catch(() => null)

    return session ?? {
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
  }

  private async clickVisibleText(page: Page, pattern: RegExp, scopeSelector?: string): Promise<boolean> {
    const clicked = await page
      .evaluate(
        ({ source, scopeSelector: scope }) => {
          const regex = new RegExp(source, 'i')
          const scopeRoot =
            typeof scope === 'string' && scope.length > 0
              ? document.querySelector(scope) ?? document
              : document

          const candidates = Array.from(scopeRoot.querySelectorAll('button, span, div.submit, a'))
            .filter((node): node is HTMLElement => node instanceof HTMLElement)
            .filter((node) => {
              const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
              if (!text || !regex.test(text)) {
                return false
              }
              const style = window.getComputedStyle(node)
              return style.display !== 'none' && style.visibility !== 'hidden'
            })

          const target = candidates[0]
          if (!target) {
            return false
          }

          const clickable =
            (target.closest('button, a, [role="button"]') as HTMLElement | null) ?? target
          clickable.click()
          return true
        },
        { source: pattern.source, scopeSelector }
      )
      .catch(() => false)

    return clicked
  }

  private async clickVisibleDialogAction(
    page: Page,
    dialogPattern: RegExp,
    actionPattern: RegExp
  ): Promise<boolean> {
    const clicked = await page
      .evaluate(
        ({ dialogSource, actionSource }) => {
          const dialogRegex = new RegExp(dialogSource, 'i')
          const actionRegex = new RegExp(actionSource, 'i')
          const wrappers = Array.from(document.querySelectorAll('.el-dialog__wrapper'))
            .filter((node): node is HTMLElement => node instanceof HTMLElement)
            .filter((node) => {
              const style = window.getComputedStyle(node)
              if (style.display === 'none' || style.visibility === 'hidden') {
                return false
              }
              const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
              return dialogRegex.test(text)
            })

          const wrapper = wrappers[0]
          if (!wrapper) {
            return false
          }

          const candidates = Array.from(wrapper.querySelectorAll('button, span, a'))
            .filter((node): node is HTMLElement => node instanceof HTMLElement)
            .filter((node) => {
              const style = window.getComputedStyle(node)
              if (style.display === 'none' || style.visibility === 'hidden') {
                return false
              }
              const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
              return actionRegex.test(text)
            })

          const target = candidates[0]
          if (!target) {
            return false
          }

          const clickable =
            (target.closest('button, a, [role="button"]') as HTMLElement | null) ?? target
          clickable.click()
          return true
        },
        { dialogSource: dialogPattern.source, actionSource: actionPattern.source }
      )
      .catch(() => false)

    return clicked
  }

  private async clickDialogButtonWithLocator(
    page: Page,
    dialogPattern: RegExp,
    actionPattern: RegExp
  ): Promise<boolean> {
    try {
      const dialog = page.locator('.el-dialog__wrapper').filter({
        hasText: dialogPattern
      }).first()

      if ((await dialog.count()) === 0) {
        return false
      }

      const button = dialog.locator('button').filter({
        hasText: actionPattern
      }).first()

      if ((await button.count()) === 0) {
        return false
      }

      await button.click({ force: true })
      return true
    } catch {
      return false
    }
  }

  private async openPreferredClassFromMyClasses(page: Page): Promise<boolean> {
    return page
      .evaluate(() => {
        const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
        const items = Array.from(document.querySelectorAll('.train_class_list'))
          .filter((node): node is HTMLElement => node instanceof HTMLElement)
          .map((node, index) => {
            const statusText = normalize(
              Array.from(node.querySelectorAll('.train_close p'))
                .map((entry) => entry.textContent)
                .join(' ')
            )
            const button = Array.from(node.querySelectorAll('button'))
              .find((entry) => /进入学习/.test(normalize(entry.textContent))) as HTMLElement | undefined
            return { node, index, statusText, button }
          })
          .filter((item) => item.button)

        const preferred =
          items.find((item) => /未结业/.test(item.statusText)) ??
          items[0]

        if (!preferred?.button) {
          return false
        }

        preferred.button.click()
        return true
      })
      .catch(() => false)
  }

  private async startNextLessonFromDetail(): Promise<boolean> {
    const page = await this.ensurePage(this.lastClassDetailUrl ?? DEFAULT_MY_CLASSES_URL)
    const started = await page
      .evaluate(() => {
        const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
        const items = Array.from(document.querySelectorAll('.uncomplete_course li'))
          .filter((node): node is HTMLElement => node instanceof HTMLElement)
          .map((node, index) => {
            const title = normalize(node.querySelector('.text_title')?.textContent)
            const progressNode = node.querySelector('[role="progressbar"]') as HTMLElement | null
            const progressText = progressNode?.getAttribute('aria-valuenow') ?? '0'
            const progress = Number(progressText)
            const startButton = Array.from(node.querySelectorAll('.SaveButton .Save, .SaveButton .Cancel'))
              .find((entry) => /开始学习|继续学习/.test(normalize(entry.textContent))) as HTMLElement | undefined
            return { node, index, title, progress, startButton }
          })
          .filter((item) => item.startButton)

        if (items.length === 0) {
          return false
        }

        const inProgress = items
          .filter((item) => item.progress > 0 && item.progress < 100)
          .sort((left, right) => right.progress - left.progress)[0]
        const notStarted = items.find((item) => item.progress === 0)
        const preferred = inProgress ?? notStarted ?? items[0]

        preferred.startButton?.click()
        return true
      })
      .catch(() => false)

    if (!started) {
      return false
    }

    await page.waitForTimeout(500)
    await this.clickVisibleDialogAction(page, /姓名：|手机号：|剩余学习天数：|入班时间：/, /^确\s*定$/)
    await page.waitForTimeout(300)
    return true
  }

  private async advanceFromVideoPage(): Promise<void> {
    const page = await this.ensurePage(this.state.baseUrl)
    const movedToNextChapter = await page
      .evaluate(() => {
        const items = Array.from(document.querySelectorAll('.menu_item'))
          .filter((node): node is HTMLElement => node instanceof HTMLElement)
        if (items.length === 0) {
          return false
        }

        const currentIndex = items.findIndex((node) => node.classList.contains('currentChapter'))
        const fallbackIndex = currentIndex >= 0 ? currentIndex : 0
        const nextItem = items[fallbackIndex + 1]
        if (!nextItem) {
          return false
        }

        nextItem.click()
        return true
      })
      .catch(() => false)

    if (movedToNextChapter) {
      await page.waitForTimeout(1_000)
      await this.resumeVideoPlayback()
      return
    }

    if (this.lastClassDetailUrl) {
      await page.goto(this.lastClassDetailUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
      await page.waitForTimeout(900)
      const started = await this.startNextLessonFromDetail()
      if (started) {
        const popup = await this.waitForPageMatching('/video_play', 8_000)
        if (popup) {
          this.currentPage = popup
          await popup.bringToFront().catch(() => undefined)
          await popup.waitForTimeout(800)
          await this.refreshActivePage(popup)
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
    const page = await this.ensurePage(this.state.baseUrl)
    await page
      .evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll('.prism-big-play-btn, .prism-play-btn')
        ).filter((node): node is HTMLElement => node instanceof HTMLElement)

        const target = candidates.find((node) => {
          const style = window.getComputedStyle(node)
          return style.display !== 'none' && style.visibility !== 'hidden'
        })

        target?.click()
      })
      .catch(() => undefined)

    await page.waitForTimeout(500)
  }

  private async waitForPageMatching(fragment: string, timeoutMs: number): Promise<Page | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const page = this.context?.pages().find((entry) => !entry.isClosed() && entry.url().includes(fragment))
      if (page) {
        return page
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    return null
  }

  private async refreshActivePage(
    page: Page,
    overrideUrl?: string,
    overrideTitle?: string
  ): Promise<void> {
    await this.ensureSettingsLoaded()
    const title = overrideTitle ?? (await page.title().catch(() => this.state.activePageTitle))
    const url = overrideUrl ?? page.url()
    const session = await this.readLearningSession(page)

    if (session.routeKind === 'video-play') {
      await this.applyPlaybackSettings(page)
      await this.applyTrackedResumeIfNeeded(page, session)
    } else {
      this.lastResumeAppliedKey = null
    }

    this.setState({
      activePageTitle: title,
      activePageUrl: url,
      isBrowserOpen: true,
      status: this.state.isRecording ? 'recording' : 'ready',
      session
    })
  }

  private getPageId(page: Page): string {
    const pageId = this.pageIds.get(page)
    if (pageId) {
      return pageId
    }

    const nextId = `page_${++this.pageCounter}`
    this.pageIds.set(page, nextId)
    return nextId
  }
}

function slugify(value: string): string {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return compact.replace(/(^-|-$)/g, '') || 'run'
}

function describeBindingPayload(payload: BindingPayload): string {
  const tag = payload.element?.tagName ?? 'element'
  const text = payload.element?.text ? ` "${payload.element.text}"` : ''
  const placeholder = payload.element?.placeholder ? ` "${payload.element.placeholder}"` : ''
  const currentChapter = typeof payload.data?.currentChapter === 'string' ? payload.data.currentChapter : ''

  switch (payload.type) {
    case 'click':
      return `Clicked ${tag}${text || placeholder}`
    case 'change':
      return `Changed ${tag}${placeholder || text}`
    case 'navigation':
      return 'Detected a client-side navigation change'
    case 'log':
      return payload.data?.note ? String(payload.data.note) : 'Observed a notable page mutation'
    case 'video-ready':
      return currentChapter
        ? `Video metadata loaded for "${currentChapter}"`
        : 'Video metadata finished loading'
    case 'video-playing':
      return currentChapter ? `Video started playing "${currentChapter}"` : 'Video playback started'
    case 'video-paused':
      return currentChapter ? `Video paused on "${currentChapter}"` : 'Video playback paused'
    case 'video-ended':
      return currentChapter ? `Video finished "${currentChapter}"` : 'Video playback ended'
    default:
      return `Recorded ${payload.type} on ${tag}${text}`
  }
}

function defaultAppSettings(): AppSettings {
  return {
    mutePlaybackOnOpen: false,
    resumeFromTrackedProgressOnOpen: false
  }
}

function classifyNetworkPurpose(url: string, method: string, resourceType: string) {
  const lower = url.toLowerCase()

  if (/login|logout|captcha|verify|auth/.test(lower)) {
    return {
      key: 'auth',
      label: '鉴权 / 登录',
      reason: '请求路径里包含登录、验证码或鉴权相关关键词。'
    }
  }

  if (/video_play|m3u8|mp4|aliplayer|vod|playlist|stream/.test(lower)) {
    return {
      key: 'player',
      label: '播放器 / 流媒体',
      reason: '请求看起来与视频播放页、流地址或播放器资源有关。'
    }
  }

  if (/locus|progress|record|history|trajectory|watch|learn|study/.test(lower) && /xhr|fetch/i.test(resourceType)) {
    return {
      key: 'progress',
      label: '学习进度上报',
      reason: '请求命中了学习、观看轨迹或进度相关关键词。'
    }
  }

  if (/assess|evaluate|survey|exam|score/.test(lower)) {
    return {
      key: 'evaluation',
      label: '评估 / 考试',
      reason: '请求路径里包含评估、考试或成绩相关关键词。'
    }
  }

  if (/person_center|user_class|class_details|course_list|course_data|class_data|my_class|my_course/.test(lower)) {
    return {
      key: 'course',
      label: '课程数据',
      reason: '请求看起来在拉课程列表、课程详情或个人中心数据。'
    }
  }

  if (
    lower.includes('pageaxios') ||
    lower.includes('/api/') ||
    lower.includes('api-') ||
    lower.endsWith('.json') ||
    /xhr|fetch/i.test(resourceType)
  ) {
    return {
      key: 'api',
      label: '通用接口',
      reason: '请求属于站点接口调用，但暂时未归到更具体的业务类。'
    }
  }

  if (
    /stylesheet|script|image|font|media/i.test(resourceType) ||
    lower.endsWith('.css') ||
    lower.endsWith('.js') ||
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.woff') ||
    lower.endsWith('.ttf')
  ) {
    return {
      key: 'asset',
      label: '静态资源',
      reason: '请求是脚本、样式、图片或字体资源。'
    }
  }

  return {
    key: 'other',
    label: '其他',
    reason: `暂未归类，方法 ${method}，资源类型 ${resourceType}。`
  }
}

function shouldCaptureResponsePreview(resourceType: string, contentType?: string) {
  const lowerType = (contentType ?? '').toLowerCase()
  if (/fetch|xhr/i.test(resourceType)) {
    return true
  }
  return /json|text|javascript/.test(lowerType)
}

function sanitizePayloadPreview(raw: string) {
  if (!raw) {
    return ''
  }

  const limited = raw.slice(0, 500)
  return limited
    .replace(/(\"?(password|pwd|pass)\"?\s*[:=]\s*\")([^\"]+)(\")/gi, '$1[redacted]$4')
    .replace(/(\"?(captcha|code|verifycode|authcode)\"?\s*[:=]\s*\")([^\"]+)(\")/gi, '$1[redacted]$4')
    .replace(/(135\\d{4})\\d{4}/g, '$1****')
}
