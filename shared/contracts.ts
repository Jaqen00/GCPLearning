export const DEFAULT_COURSE_URL = 'https://www.nmpaied.com/pc/index.html#/'
export const DEFAULT_MY_CLASSES_URL = 'https://www.nmpaied.com/pc/index.html#/person_center/my_class/user_class?id=2'

export type RecorderStatus = 'idle' | 'launching' | 'ready' | 'recording' | 'error'

export type LoginStatus = 'logged-in' | 'logged-out' | 'unknown'
export type LearningRouteKind = 'home' | 'login' | 'my-classes' | 'my-course' | 'course-detail' | 'video-play' | 'other'
export type LearningRequiredAction = 'none' | 'manual-attention'

export interface AppSettings {
  mutePlaybackOnOpen: boolean
  resumeFromTrackedProgressOnOpen: boolean
}

export type RecorderEventType =
  | 'recording-started'
  | 'recording-stopped'
  | 'page-opened'
  | 'navigation'
  | 'click'
  | 'change'
  | 'popup'
  | 'log'
  | 'video-ready'
  | 'video-playing'
  | 'video-paused'
  | 'video-ended'

export interface SelectorCandidate {
  kind: 'css' | 'text' | 'id' | 'class' | 'attr' | 'placeholder' | 'role' | 'href'
  value: string
}

export interface RecordedElement {
  tagName: string
  text?: string
  id?: string
  name?: string
  classes?: string[]
  ariaLabel?: string
  placeholder?: string
  role?: string
  href?: string
}

export interface RecordedEvent {
  id: string
  runId?: string
  type: RecorderEventType
  timestamp: string
  pageId: string
  pageUrl: string
  pageTitle?: string
  description: string
  selectors?: SelectorCandidate[]
  element?: RecordedElement
  screenshotPath?: string
  snapshotPath?: string
  data?: Record<string, unknown>
}

export interface RecorderState {
  status: RecorderStatus
  baseUrl: string
  isBrowserOpen: boolean
  isRecording: boolean
  sessionDataPath: string
  recordingsPath: string
  activePageUrl?: string
  activePageTitle?: string
  currentRunId?: string
  lastTraceDir?: string
  startedAt?: string
  lastError?: string
  eventCount: number
  siteHints: string[]
  networkCaptureEnabled?: boolean
  networkLogPath?: string
  networkEventCount?: number
  networkPurposeCounts?: Record<string, number>
  settings?: AppSettings
  session?: LearningSessionState
}

export interface ExportTraceResult {
  traceDir: string | null
  eventCount: number
}

export type SuggestedFlowStepKind =
  | 'open-url'
  | 'fill-field'
  | 'click'
  | 'wait-route'
  | 'handle-dialog'
  | 'switch-page'
  | 'wait-video'

export interface SuggestedFlowStep {
  id: string
  kind: SuggestedFlowStepKind
  title: string
  detail: string
  pageUrl?: string
  selector?: string
  confidence: 'high' | 'medium' | 'low'
  eventIds: string[]
}

export interface RecordedTraceBundle {
  traceDir: string
  events: RecordedEvent[]
  suggestedSteps: SuggestedFlowStep[]
  manifest?: Record<string, unknown>
}

export interface LearningVideoState {
  exists: boolean
  ready: boolean
  playing: boolean
  paused: boolean
  ended: boolean
  currentTime?: number
  duration?: number
  progressPercent?: number
}

export interface LearningSessionState {
  loginStatus: LoginStatus
  routeKind: LearningRouteKind
  loginFormVisible: boolean
  requiresCaptcha: boolean
  loginPromptVisible: boolean
  continuePromptVisible: boolean
  currentUrl: string
  title?: string
  currentCourseTitle?: string
  currentChapterTitle?: string
  visibleActions: string[]
  video: LearningVideoState
}

export interface LearningRunResult {
  state: RecorderState
  session: LearningSessionState
  summary: string
  requiredAction: LearningRequiredAction
}

export type FlowSupportLevel = 'supported' | 'assisted' | 'planned'

export interface AutomationFlowItem {
  id: string
  title: string
  detail: string
  support: FlowSupportLevel
}

export interface RecorderApi {
  getState: () => Promise<RecorderState>
  getLatestTrace: () => Promise<RecordedTraceBundle | null>
  loadSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  setPreferredWindowHeight: (height: number) => Promise<void>
  startLearning: () => Promise<LearningRunResult>
  pauseLearning: () => Promise<LearningRunResult>
  resumeLearning: () => Promise<LearningRunResult>
  resumeManagedSession: () => Promise<RecorderState>
  inspectSession: () => Promise<LearningSessionState>
  submitLoginAfterCaptcha: () => Promise<LearningSessionState>
  openMyClasses: () => Promise<LearningSessionState>
  enterCurrentCourse: () => Promise<LearningSessionState>
  acknowledgeContinuePrompt: () => Promise<LearningSessionState>
  openBrowser: (url?: string) => Promise<RecorderState>
  startRecording: (label?: string) => Promise<RecorderState>
  stopRecording: () => Promise<RecorderState>
  exportTrace: () => Promise<ExportTraceResult>
  openPath: (targetPath: string) => Promise<void>
  onState: (callback: (state: RecorderState) => void) => () => void
  onEvent: (callback: (event: RecordedEvent) => void) => () => void
}
