import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type AppSettings,
  DEFAULT_COURSE_URL,
  type BrowserViewportBounds,
  type LearningRequiredAction,
  type LearningSessionState,
  type RecorderState
} from '@shared/contracts'

const EMPTY_STATE: RecorderState = {
  status: 'idle',
  baseUrl: DEFAULT_COURSE_URL,
  isBrowserOpen: false,
  isRecording: false,
  profilePath: '',
  recordingsPath: '',
  eventCount: 0,
  siteHints: []
}

const EMPTY_SESSION: LearningSessionState = {
  loginStatus: 'unknown',
  routeKind: 'other',
  loginFormVisible: false,
  requiresCaptcha: false,
  loginPromptVisible: false,
  continuePromptVisible: false,
  currentUrl: DEFAULT_COURSE_URL,
  visibleActions: [],
  video: {
    exists: false,
    ready: false,
    playing: false,
    paused: false,
    ended: false
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  mutePlaybackOnOpen: false,
  resumeFromTrackedProgressOnOpen: false
}

export default function App() {
  const [state, setState] = useState<RecorderState>(EMPTY_STATE)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [message, setMessage] = useState(
    '点一次“开始学习”，系统会在内置学习页里检查登录、进入课程，并尽量自动继续学习。'
  )
  const [requiredAction, setRequiredAction] = useState<LearningRequiredAction>('none')
  const browserViewportRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void loadInitialState()

    const offState = window.recorder.onState((nextState) => {
      setState(nextState)
    })

    return () => {
      offState()
    }
  }, [])

  useEffect(() => {
    const node = browserViewportRef.current
    if (!node) {
      return
    }

    let frame = 0
    let lastSerialized = ''

    const publishBounds = () => {
      cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const currentNode = browserViewportRef.current
        if (!currentNode) {
          return
        }

        const rect = currentNode.getBoundingClientRect()
        const nextBounds: BrowserViewportBounds | null =
          rect.width > 0 && rect.height > 0
            ? {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              }
            : null

        const serialized = JSON.stringify(nextBounds)
        if (serialized === lastSerialized) {
          return
        }

        lastSerialized = serialized
        void window.recorder.setBrowserViewport(nextBounds)
      })
    }

    const observer = new ResizeObserver(() => {
      publishBounds()
    })

    observer.observe(node)
    window.addEventListener('resize', publishBounds)
    publishBounds()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', publishBounds)
      void window.recorder.setBrowserViewport(null)
    }
  }, [])

  const session = state.session ?? EMPTY_SESSION
  const summary = useMemo(() => buildSummary(session, state.isBrowserOpen), [session, state.isBrowserOpen])
  const mainButtonLabel = useMemo(() => {
    if (busyAction === 'start-learning') {
      return '正在处理中...'
    }
    if (session.routeKind === 'video-play' && session.video.playing) {
      return '继续学习'
    }
    return '开始学习'
  }, [busyAction, session])

  async function loadInitialState() {
    const [nextState, loadedSettings] = await Promise.all([
      window.recorder.getState(),
      window.recorder.loadSettings()
    ])
    setState(nextState)
    setSettings(loadedSettings)
    setRequiredAction(inferRequiredAction(nextState.session ?? EMPTY_SESSION))
  }

  async function refreshState() {
    const nextState = await window.recorder.getState()
    setState(nextState)
    return nextState
  }

  async function runAction<T>(actionName: string, action: () => Promise<T>) {
    setBusyAction(actionName)
    try {
      return await action()
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : String(error)
      setMessage(nextMessage)
      setRequiredAction('manual-attention')
      return undefined
    } finally {
      setBusyAction(null)
    }
  }

  async function handleStartLearning() {
    const result = await runAction('start-learning', () => window.recorder.startLearning())
    if (!result) {
      return
    }

    setState(result.state)
    setRequiredAction(result.requiredAction)
    setMessage(result.summary)
  }

  async function handleCheckStatus() {
    const sessionSnapshot = await runAction('inspect-session', () => window.recorder.inspectSession())
    if (sessionSnapshot) {
      const nextState = await refreshState()
      setRequiredAction(inferRequiredAction(sessionSnapshot))
      setMessage(describeSession(nextState.session ?? sessionSnapshot))
    }
  }

  async function handleSettingUpdate(patch: Partial<AppSettings>, successMessage: string) {
    const next = await runAction('update-settings', () => window.recorder.updateSettings(patch))
    if (next) {
      setSettings(next)
      setMessage(successMessage)
    }
  }

  return (
    <main className="app-shell app-shell-embedded">
      <section className="dashboard-grid">
        <section className="title-card hero-card">
          <p className="eyebrow">Watching Assistant</p>
          <div className="title-topline">
            <div>
              <h1>观看助手</h1>
              <p className="subtitle">
                在客户端内直接托管学习页面，自动检查登录、进入课程、恢复播放并推进下一节。
              </p>
            </div>
            <StatusPill status={summary.badge} />
          </div>
        </section>

        <section className="card action-card control-card">
          <div className="section-head no-margin">
            <div>
              <p className="small-label">当前进展</p>
              <h2>{summary.title}</h2>
            </div>
            <span className="muted-note">{humanStatus(session, state.isBrowserOpen)}</span>
          </div>

          <p className="action-copy">{summary.detail}</p>

          <div className="action-buttons">
            <button
              className="button button-primary button-main"
              disabled={busyAction !== null}
              onClick={handleStartLearning}
            >
              {mainButtonLabel}
            </button>

            <button
              className="button button-ghost"
              disabled={busyAction !== null}
              onClick={handleCheckStatus}
            >
              重新检查状态
            </button>
          </div>
        </section>

        <section className="card settings-card compact-card">
          <div className="section-head">
            <h2>设置</h2>
            <span className="muted-note">先设置，再开始学习</span>
          </div>

          <div className="settings-stack">
            <SettingRow
              title="播放页自动静音"
              detail="进入课程播放页时，自动把当前学习页静音。"
              enabled={settings.mutePlaybackOnOpen}
              disabled={busyAction !== null}
              onToggle={() =>
                handleSettingUpdate(
                  { mutePlaybackOnOpen: !settings.mutePlaybackOnOpen },
                  !settings.mutePlaybackOnOpen
                    ? '已开启自动静音。后续进入播放页时会自动静音。'
                    : '已关闭自动静音。后续进入播放页时不再自动静音。'
                )
              }
            />

            <SettingRow
              title="自动定位到历史观看记录"
              detail="进入播放页时，按已记录进度回到上次位置，并回退 10 秒继续播放。"
              enabled={settings.resumeFromTrackedProgressOnOpen}
              disabled={busyAction !== null}
              onToggle={() =>
                handleSettingUpdate(
                  { resumeFromTrackedProgressOnOpen: !settings.resumeFromTrackedProgressOnOpen },
                  !settings.resumeFromTrackedProgressOnOpen
                    ? '已开启历史观看记录恢复。后续进入播放页时会自动回到上次位置并回退 10 秒。'
                    : '已关闭历史观看记录恢复。后续进入播放页时不再自动定位到上次观看位置。'
                )
              }
            />
          </div>
        </section>

        <section className="card status-card compact-card">
          <div className="section-head">
            <h2>状态</h2>
            <span className="muted-note">{routeLabel(session.routeKind)}</span>
          </div>

          <div className="status-grid">
            <StatusItem label="课程" value={session.currentCourseTitle || '未进入'} />
            <StatusItem label="章节" value={session.currentChapterTitle || '未进入'} />
            <StatusItem label="页面" value={routeLabel(session.routeKind)} />
            <StatusItem label="进度" value={progressLabel(session)} />
          </div>

          <div className="mini-progress">
            <div className="mini-progress-topline">
              <span>播放进度</span>
              <strong>{progressLabel(session)}</strong>
            </div>
            <div className="progress-track">
              <div className="progress-bar" style={{ width: `${videoProgressPercent(session)}%` }} />
            </div>
          </div>

          <div className="hint-stack hint-stack-compact">
            {buildHints(requiredAction, session).map((hint) => (
              <HintRow key={hint.title} title={hint.title} detail={hint.detail} />
            ))}
          </div>
        </section>
      </section>

      <section className="message-strip">
        <p>{message}</p>
      </section>

      <section className="card browser-card">
        <div className="section-head">
          <h2>学习页</h2>
          <span className="muted-note">
            {state.isBrowserOpen ? 'Electron 内置浏览器已接管' : '等待打开学习页'}
          </span>
        </div>

        <div className="browser-viewport" ref={browserViewportRef}>
          {!state.isBrowserOpen ? (
            <div className="browser-placeholder">
              <strong>学习页会显示在这里</strong>
              <p>点击“开始学习”后，系统会在客户端内打开首页、检查登录状态并继续推进课程。</p>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  )
}

function StatusPill(props: { status: 'waiting' | 'ready' | 'learning' }) {
  return (
    <span className={`status-pill status-${props.status}`}>
      {props.status === 'waiting' ? '等待处理' : props.status === 'learning' ? '正在学习' : '准备就绪'}
    </span>
  )
}

function SettingRow(props: {
  title: string
  detail: string
  enabled: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <label className="setting-row">
      <div className="setting-copy">
        <strong>{props.title}</strong>
        <p>{props.detail}</p>
      </div>
      <button
        className={`toggle ${props.enabled ? 'toggle-on' : 'toggle-off'}`}
        disabled={props.disabled}
        onClick={props.onToggle}
        type="button"
        aria-pressed={props.enabled}
      >
        <span />
      </button>
    </label>
  )
}

function StatusItem(props: { label: string; value: string }) {
  return (
    <div className="status-item">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function HintRow(props: { title: string; detail: string }) {
  return (
    <article className="hint-row">
      <strong>{props.title}</strong>
      <p>{props.detail}</p>
    </article>
  )
}

function inferRequiredAction(session: LearningSessionState): LearningRequiredAction {
  if (session.loginStatus !== 'logged-in') {
    return 'manual-attention'
  }
  return 'none'
}

function humanStatus(session: LearningSessionState, isBrowserOpen: boolean) {
  if (!isBrowserOpen) {
    return '等待启动'
  }
  if (session.routeKind === 'video-play' && session.video.playing) {
    return '正在学习'
  }
  if (session.routeKind === 'video-play') {
    return '已进入播放页'
  }
  if (session.loginStatus === 'logged-out') {
    return '等待登录'
  }
  if (
    session.routeKind === 'my-classes' ||
    session.routeKind === 'my-course' ||
    session.routeKind === 'course-detail'
  ) {
    return '准备进入课程'
  }
  return '准备就绪'
}

function routeLabel(routeKind: LearningSessionState['routeKind']) {
  switch (routeKind) {
    case 'home':
      return '首页'
    case 'login':
      return '登录页'
    case 'my-classes':
      return '我的专题班'
    case 'my-course':
      return '我的课程'
    case 'course-detail':
      return '课程详情'
    case 'video-play':
      return '播放页'
    default:
      return '未识别页面'
  }
}

function progressLabel(session: LearningSessionState) {
  if (!session.video.exists) {
    return '当前不在播放页'
  }
  const current = typeof session.video.currentTime === 'number' ? formatMediaTime(session.video.currentTime) : '--:--'
  const duration = typeof session.video.duration === 'number' ? formatMediaTime(session.video.duration) : '--:--'
  return `${current} / ${duration}`
}

function formatMediaTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function videoProgressPercent(session: LearningSessionState) {
  if (!session.video.exists) {
    return 0
  }
  if (typeof session.video.progressPercent === 'number') {
    return Math.max(0, Math.min(100, session.video.progressPercent))
  }
  if (!session.video.duration || session.video.duration <= 0) {
    return 0
  }
  const currentTime = session.video.currentTime ?? 0
  return Math.max(0, Math.min(100, (currentTime / session.video.duration) * 100))
}

function buildSummary(session: LearningSessionState, isBrowserOpen: boolean) {
  if (!isBrowserOpen) {
    return {
      badge: 'waiting' as const,
      title: '等待启动',
      detail: '点击开始学习后，系统会在客户端里打开内置学习页并检查当前会话。'
    }
  }

  if (session.loginStatus !== 'logged-in') {
    return {
      badge: 'waiting' as const,
      title: '等待你完成登录',
      detail: '当前只需要在下方学习页里登录。登录成功后，系统会自动继续进入课程。'
    }
  }

  if (session.routeKind === 'video-play' && session.video.playing) {
    return {
      badge: 'learning' as const,
      title: session.currentCourseTitle || '正在学习',
      detail: session.currentChapterTitle
        ? `当前章节：${session.currentChapterTitle}`
        : '系统正在播放并监控当前课程。'
    }
  }

  return {
    badge: 'ready' as const,
    title: '系统正在为你准备课程',
    detail: '已经处于有效登录状态，接下来会自动进入课程并开始学习。'
  }
}

function buildHints(requiredAction: LearningRequiredAction, session: LearningSessionState) {
  if (requiredAction === 'manual-attention' && session.loginStatus !== 'logged-in') {
    return [
      {
        title: '请先完成登录',
        detail: '在下方学习页里完成登录后，系统会自动继续进入课程。'
      }
    ]
  }

  if (session.continuePromptVisible) {
    return [
      {
        title: '检测到继续学习提示',
        detail: '系统会自动尝试确认并继续播放。'
      }
    ]
  }

  if (session.routeKind === 'video-play' && session.video.playing) {
    return [
      {
        title: '正在自动学习',
        detail: '当前已进入播放页，系统会继续监控进度并推进下一节。'
      }
    ]
  }

  return [
    {
      title: '当前无需额外操作',
      detail: '保持客户端开启即可，系统会继续自动处理。'
    }
  ]
}

function describeSession(session: LearningSessionState) {
  if (session.routeKind === 'video-play' && session.video.playing) {
    return '当前已经在播放页并正在学习。'
  }
  if (session.loginStatus === 'logged-out') {
    return '当前还没有有效登录状态，请在下方学习页中登录。'
  }
  if (session.routeKind === 'my-classes') {
    return '当前已经进入我的专题班，系统会继续自动推进到课程播放页。'
  }
  if (session.routeKind === 'my-course') {
    return '当前已经进入我的课程，系统会继续自动推进到课程播放页。'
  }
  return '当前页面状态已经刷新。'
}
