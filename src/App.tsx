import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type AppSettings,
  DEFAULT_COURSE_URL,
  type LearningRequiredAction,
  type LearningSessionState,
  type RecorderState
} from '@shared/contracts'

const EMPTY_STATE: RecorderState = {
  status: 'idle',
  baseUrl: DEFAULT_COURSE_URL,
  isBrowserOpen: false,
  isRecording: false,
  sessionDataPath: '',
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

const DEFAULT_MESSAGE =
  '点击“开始学习”后，系统会打开独立学习窗口，检查登录、进入课程，并尽量自动继续学习。'

export default function App() {
  const [state, setState] = useState<RecorderState>(EMPTY_STATE)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [message, setMessage] = useState(DEFAULT_MESSAGE)
  const [requiredAction, setRequiredAction] = useState<LearningRequiredAction>('none')
  const shellRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    void loadInitialState()

    const offState = window.recorder.onState((nextState) => {
      setState(nextState)
      const nextSession = nextState.session ?? EMPTY_SESSION
      setRequiredAction(inferRequiredAction(nextSession))
      setMessage((current) =>
        reconcileMessage(current, nextSession, nextState.lastError, nextState.isBrowserOpen)
      )
    })

    return () => {
      offState()
    }
  }, [])

  useEffect(() => {
    const node = shellRef.current
    if (!node) {
      return
    }

    let frame = 0
    let lastHeight = 0

    const publishHeight = () => {
      cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const currentNode = shellRef.current
        if (!currentNode) {
          return
        }

        const measured = Math.ceil(Math.max(currentNode.scrollHeight, currentNode.clientHeight) + 20)
        if (Math.abs(measured - lastHeight) < 4) {
          return
        }

        lastHeight = measured
        void window.recorder.setPreferredWindowHeight(measured)
      })
    }

    const observer = new ResizeObserver(() => {
      publishHeight()
    })

    observer.observe(node)
    window.addEventListener('resize', publishHeight)
    publishHeight()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', publishHeight)
    }
  }, [detailsOpen, settingsOpen, busyAction, message, state.session])

  const session = state.session ?? EMPTY_SESSION
  const hints = useMemo(() => buildHints(requiredAction, session), [requiredAction, session])
  const summary = useMemo(() => buildSummary(session, state.isBrowserOpen), [session, state.isBrowserOpen])
  const mainButtonLabel = useMemo(() => {
    if (busyAction === 'start-learning' || busyAction === 'resume-learning') {
      return '正在处理中...'
    }
    if (session.routeKind === 'video-play' && session.video.playing) {
      if (busyAction === 'pause-learning') {
        return '正在停止...'
      }
      return '停止学习'
    }
    if (session.routeKind === 'video-play' && session.video.exists) {
      return '继续学习'
    }
    return '开始学习'
  }, [busyAction, session])
  const noticeText = useMemo(
    () => buildNoticeText(message, summary.detail, state.lastError, busyAction, requiredAction, session),
    [message, summary.detail, state.lastError, busyAction, requiredAction, session]
  )
  const taskCard = useMemo(() => buildTaskCard(summary, hints, noticeText), [summary, hints, noticeText])

  async function loadInitialState() {
    const [nextState, loadedSettings] = await Promise.all([
      window.recorder.getState(),
      window.recorder.loadSettings()
    ])
    setState(nextState)
    setSettings(loadedSettings)
    setRequiredAction(inferRequiredAction(nextState.session ?? EMPTY_SESSION))
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
    setMessage('正在唤起独立学习窗口，并检查当前登录状态...')
    const result = await runAction('start-learning', () => window.recorder.startLearning())
    if (!result) {
      return
    }

    setState(result.state)
    setRequiredAction(result.requiredAction)
    setMessage(result.summary)
  }

  async function handlePauseLearning() {
    const result = await runAction('pause-learning', () => window.recorder.pauseLearning())
    if (!result) {
      return
    }

    setState(result.state)
    setRequiredAction(result.requiredAction)
    setMessage(result.summary)
  }

  async function handleResumeLearning() {
    const result = await runAction('resume-learning', () => window.recorder.resumeLearning())
    if (!result) {
      return
    }

    setState(result.state)
    setRequiredAction(result.requiredAction)
    setMessage(result.summary)
  }

  async function handleMainAction() {
    if (session.routeKind === 'video-play' && session.video.playing) {
      await handlePauseLearning()
      return
    }

    if (session.routeKind === 'video-play' && session.video.exists) {
      await handleResumeLearning()
      return
    }

    await handleStartLearning()
  }

  async function handleSettingUpdate(patch: Partial<AppSettings>, successMessage: string) {
    const next = await runAction('update-settings', () => window.recorder.updateSettings(patch))
    if (next) {
      setSettings(next)
      setMessage(successMessage)
    }
  }

  return (
    <main className="control-shell" ref={shellRef}>
      <section className="control-panel">
        <section className="panel-card hero-card">
          <p className="eyebrow">Watching Assistant</p>
          <h1>GCP学习辅助工具</h1>
          <p className="subtitle">
            自动唤起学习窗口、跟踪课程状态、辅助续播与播放控制，让课程学习流程更顺畅。
          </p>
          <p className="hero-note">
            本软件仅用于辅助课程播放与操作管理，请以认真学习课程内容为前提，合理使用，避免滥用。
          </p>
        </section>

        <section className="panel-card detail-card">
          <button
            className="detail-toggle"
            type="button"
            onClick={() => setDetailsOpen((current) => !current)}
            aria-expanded={detailsOpen}
          >
            <div className="detail-toggle-copy">
              <div className="detail-toggle-headline">
                <strong>{taskCard.title}</strong>
              </div>
              <p>{taskCard.detail}</p>
            </div>
            <span className="detail-toggle-meta">
              {detailsOpen ? '收起' : '展开'}
              <span className={`settings-chevron ${detailsOpen ? 'settings-chevron-open' : ''}`} aria-hidden="true">
                ▾
              </span>
            </span>
          </button>

          {detailsOpen ? (
            <div className="detail-body">
              <div className="detail-grid">
                <DetailItem label="状态" value={taskCard.statusLabel} />
                <DetailItem label="课程" value={session.currentCourseTitle || '未进入'} />
                <DetailItem label="章节" value={session.currentChapterTitle || '未进入'} />
                <DetailItem label="页面" value={routeLabel(session.routeKind)} />
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
            </div>
          ) : null}
        </section>

        <section className="panel-card action-card">
          <section className="settings-drawer">
            <button
              className="settings-toggle"
              type="button"
              onClick={() => setSettingsOpen((current) => !current)}
              aria-expanded={settingsOpen}
            >
              <span className="settings-toggle-copy">
                <strong>播放设置</strong>
              </span>
              <span className="settings-toggle-meta">
                {settingsOpen ? '收起' : '展开'}
                <span
                  className={`settings-chevron ${settingsOpen ? 'settings-chevron-open' : ''}`}
                  aria-hidden="true"
                >
                  ▾
                </span>
              </span>
            </button>

            {settingsOpen ? (
              <div className="settings-stack settings-drawer-body">
                <SettingRow
                  title="播放页自动静音"
                  detail="进入课程播放页时，自动把学习窗口静音。"
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
            ) : null}
          </section>

          <button
            className="button button-primary button-main"
            disabled={busyAction !== null}
            onClick={handleMainAction}
          >
            {mainButtonLabel}
          </button>
        </section>
      </section>
    </main>
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
    <div className="setting-row">
      <div className="setting-copy">
        <div className="setting-titleline">
          <strong>{props.title}</strong>
          <span className="setting-help" tabIndex={0}>
            <span className="setting-help-badge" aria-hidden="true">
              i
            </span>
            <span className="setting-tooltip" role="tooltip">
              {props.detail}
            </span>
          </span>
        </div>
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
    </div>
  )
}

function DetailItem(props: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function inferRequiredAction(session: LearningSessionState): LearningRequiredAction {
  if (session.routeKind === 'video-play' || session.video.exists) {
    return 'none'
  }
  if (session.loginStatus !== 'logged-in') {
    return 'manual-attention'
  }
  return 'none'
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
      statusLabel: '待启动',
      title: '等待启动',
      detail: '点击开始学习后，系统会打开独立学习窗口并检查当前会话。'
    }
  }

  if (session.routeKind === 'video-play' && (session.video.playing || session.video.exists)) {
    return {
      statusLabel: session.video.playing ? '学习中' : '播放页',
      title: session.currentCourseTitle || '正在学习',
      detail: session.currentChapterTitle
        ? `当前章节：${session.currentChapterTitle}`
        : '系统正在播放并监控当前课程。'
    }
  }

  if (session.loginStatus !== 'logged-in') {
    return {
      statusLabel: '待登录',
      title: '请先完成登录',
      detail: '在独立学习窗口里完成登录后，系统会自动继续进入课程。'
    }
  }

  return {
    statusLabel: '准备中',
    title: '系统正在为你准备课程',
    detail: '已经处于有效登录状态，接下来会自动进入课程并开始学习。'
  }
}

function buildHints(requiredAction: LearningRequiredAction, session: LearningSessionState) {
  if (requiredAction === 'manual-attention' && session.loginStatus !== 'logged-in') {
    return [
      {
        title: '请先完成登录',
        detail: '在独立学习窗口里完成登录后，系统会自动继续进入课程。'
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

  return []
}

function buildNoticeText(
  message: string,
  summaryDetail: string,
  lastError: string | undefined,
  busyAction: string | null,
  requiredAction: LearningRequiredAction,
  session: LearningSessionState
) {
  if (lastError) {
    return lastError
  }

  if (session.routeKind === 'video-play' && session.video.playing) {
    return ''
  }

  if (busyAction === 'start-learning') {
    return '正在唤起独立学习窗口，并检查当前登录状态...'
  }

  if (
    /已经推进到课程相关页面|还没完全稳定进入播放页|需要人工关注/i.test(message) &&
    (session.routeKind === 'video-play' || session.video.exists)
  ) {
    return ''
  }

  if (requiredAction === 'manual-attention' || session.continuePromptVisible) {
    return message
  }

  if (message && message !== DEFAULT_MESSAGE && message !== summaryDetail) {
    return message
  }

  return ''
}

function buildTaskCard(
  summary: ReturnType<typeof buildSummary>,
  hints: Array<{ title: string; detail: string }>,
  noticeText: string
) {
  const primaryHint = hints[0]
  if (primaryHint) {
    return {
      statusLabel: summary.statusLabel,
      title: primaryHint.title,
      detail: primaryHint.detail
    }
  }

  if (noticeText) {
    return {
      statusLabel: summary.statusLabel,
      title: summary.title,
      detail: noticeText
    }
  }

  return summary
}

function reconcileMessage(
  current: string,
  session: LearningSessionState,
  lastError: string | undefined,
  isBrowserOpen: boolean
) {
  if (lastError) {
    return current
  }

  if (session.routeKind === 'video-play' && (session.video.playing || session.video.exists)) {
    return '已检测到有效学习状态，系统会继续监控当前课程进度。'
  }

  if (session.loginStatus !== 'logged-in' && (session.loginFormVisible || session.loginPromptVisible)) {
    return '请先在独立学习窗口中完成登录，系统会在登录成功后自动继续进入课程。'
  }

  if (isBrowserOpen && session.loginStatus === 'logged-in' && session.routeKind !== 'other') {
    return '已检测到有效学习状态，系统会继续自动推进当前课程。'
  }

  return current
}
