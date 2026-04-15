import type { RecordedEvent, SuggestedFlowStep, SuggestedFlowStepKind } from './contracts'

export function deriveSuggestedFlowSteps(events: RecordedEvent[]): SuggestedFlowStep[] {
  const orderedEvents = [...events].sort(compareEventsByTime)
  const steps: SuggestedFlowStep[] = []

  for (const event of orderedEvents) {
    const candidate = buildStepFromEvent(event)
    if (!candidate) {
      continue
    }

    const previous = steps.at(-1)
    if (
      previous &&
      previous.kind === candidate.kind &&
      previous.title === candidate.title &&
      previous.pageUrl === candidate.pageUrl &&
      previous.selector === candidate.selector
    ) {
      previous.eventIds.push(...candidate.eventIds)
      continue
    }

    steps.push(candidate)
  }

  return steps
}

function buildStepFromEvent(event: RecordedEvent): SuggestedFlowStep | null {
  switch (event.type) {
    case 'recording-started':
      return {
        id: `step-${event.id}`,
        kind: 'open-url',
        title: '打开课程站点',
        detail: `从 ${event.pageUrl} 开始录制本次流程。`,
        pageUrl: event.pageUrl,
        confidence: 'high',
        eventIds: [event.id]
      }
    case 'recording-stopped':
      return null
    case 'change':
      return buildChangeStep(event)
    case 'click':
      return buildClickStep(event)
    case 'navigation':
      return buildNavigationStep(event)
    case 'popup':
    case 'page-opened':
      return buildPopupStep(event)
    case 'log':
      return buildDialogStep(event)
    case 'video-ready':
    case 'video-playing':
    case 'video-paused':
    case 'video-ended':
      return buildVideoStep(event)
    default:
      return null
  }
}

function buildChangeStep(event: RecordedEvent): SuggestedFlowStep | null {
  const fieldLabel =
    readString(event.data?.fieldLabel) ||
    inferLegacyFieldLabel(event) ||
    event.element?.placeholder ||
    event.element?.ariaLabel ||
    event.element?.name ||
    event.element?.id

  if (!fieldLabel) {
    return null
  }

  const normalizedLabel = normalizeFieldLabel(fieldLabel)
  const sensitivity = readString(event.data?.sensitivity)
  const valuePreview = readString(event.data?.valuePreview)
  const valueHint = valuePreview ? `，录制值 ${valuePreview}` : ''
  const sensitivityHint =
    sensitivity && sensitivity !== 'plain' ? '，已自动脱敏保存' : ''

  return createStep(event, 'fill-field', `填写${normalizedLabel}`, `定位到 ${normalizedLabel}${valueHint}${sensitivityHint}。`, {
    selector: firstSelector(event),
    confidence: fieldLabel ? 'high' : 'medium'
  })
}

function buildClickStep(event: RecordedEvent): SuggestedFlowStep | null {
  const text = event.element?.text?.replace(/\s+/g, ' ').trim()
  const placeholder = event.element?.placeholder?.trim()
  const selector = firstSelector(event)

  if (event.element?.tagName === 'input' && !text) {
    return null
  }

  if (!text && !selector) {
    return null
  }

  if (text && text.length > 40 && (!selector || selector.includes('nth-of-type'))) {
    return null
  }

  if (text && /登录/.test(text)) {
    return createStep(event, 'click', '提交登录', '点击登录按钮，等待站点完成登录态切换。', {
      selector,
      confidence: 'high'
    })
  }

  if (text && /个人中心/.test(text)) {
    return createStep(event, 'click', '进入个人中心', '从顶部导航进入个人中心。', {
      selector,
      confidence: 'high'
    })
  }

  if (text && /进入学习/.test(text)) {
    return createStep(event, 'click', '打开课程学习详情', '在课程列表里点击“进入学习”。', {
      selector,
      confidence: 'high'
    })
  }

  if (text && /开始学习/.test(text)) {
    return createStep(event, 'click', '打开播放窗口', '在课程详情弹层中点击“开始学习”。', {
      selector,
      confidence: 'high'
    })
  }

  if (text && /^确\s*定$/.test(text)) {
    return createStep(event, 'handle-dialog', '确认弹窗', '对当前提示框点击“确定”继续流程。', {
      selector,
      confidence: 'high'
    })
  }

  if (placeholder) {
    return createStep(event, 'click', `聚焦${normalizeFieldLabel(placeholder)}`, '用户先手动聚焦了目标输入框。', {
      selector,
      confidence: 'medium'
    })
  }

  if (text) {
    return createStep(event, 'click', `点击“${text}”`, '按录制结果点击该元素继续流程。', {
      selector,
      confidence: 'medium'
    })
  }

  return createStep(event, 'click', `点击 ${event.element?.tagName ?? '元素'}`, '按录制结果点击该元素继续流程。', {
    selector,
    confidence: 'low'
  })
}

function buildNavigationStep(event: RecordedEvent): SuggestedFlowStep | null {
  if (event.pageUrl.includes('/person_center/my_class/user_class')) {
    return createStep(
      event,
      'wait-route',
      '等待进入我的班级课程页',
      '登录后等待页面切换到个人中心的课程列表。',
      {
        confidence: 'high'
      }
    )
  }

  if (event.pageUrl.includes('/video_play')) {
    return createStep(event, 'wait-route', '等待播放页加载', '等待新页面切换到视频播放路由。', {
      confidence: 'high'
    })
  }

  return createStep(event, 'wait-route', '等待页面切换', `等待路由跳转到 ${event.pageUrl}。`, {
    confidence: 'medium'
  })
}

function buildPopupStep(event: RecordedEvent): SuggestedFlowStep | null {
  if (event.pageUrl.includes('/video_play')) {
    return createStep(event, 'switch-page', '切换到视频播放窗口', '课程详情会以新标签页或弹出页打开播放页面。', {
      confidence: 'high'
    })
  }

  return createStep(event, 'switch-page', '切换到新页面', '录制过程中打开了新的标签页或窗口。', {
    confidence: 'medium'
  })
}

function buildDialogStep(event: RecordedEvent): SuggestedFlowStep | null {
  const text = event.element?.text?.replace(/\s+/g, ' ').trim()
  const note = readString(event.data?.note)
  const dialogText = text || note

  if (!dialogText) {
    return null
  }

  if (/是否继续学习/.test(dialogText)) {
    return createStep(event, 'handle-dialog', '处理“是否继续学习”提示', '播放页出现“是否继续学习？”时需要确认继续。', {
      confidence: 'high'
    })
  }

  if (/姓名：|手机号：|入班时间：|剩余学习天数：/.test(dialogText)) {
    return createStep(event, 'handle-dialog', '确认课程信息弹层', '进入学习后会先出现课程信息弹层，需要点击确定。', {
      confidence: 'high'
    })
  }

  return createStep(event, 'handle-dialog', '等待并处理提示框', `页面出现提示内容：${dialogText.slice(0, 60)}。`, {
    confidence: 'medium'
  })
}

function buildVideoStep(event: RecordedEvent): SuggestedFlowStep | null {
  const chapter = readString(event.data?.currentChapter)
  const detailSuffix = chapter ? ` 当前章节：${chapter}。` : ''

  switch (event.type) {
    case 'video-ready':
      return createStep(event, 'wait-video', '等待播放器准备完成', `检测到视频元数据已经加载。${detailSuffix}`, {
        confidence: 'high'
      })
    case 'video-playing':
      return createStep(event, 'wait-video', '确认视频开始播放', `播放器已经开始播放。${describeTimeHint(event)}${detailSuffix}`, {
        confidence: 'high'
      })
    case 'video-paused':
      return createStep(event, 'wait-video', '关注播放器暂停状态', `播放器进入暂停状态。${describeTimeHint(event)}${detailSuffix}`, {
        confidence: 'medium'
      })
    case 'video-ended':
      return createStep(event, 'wait-video', '等待当前视频播放结束', `检测到当前视频已经播放结束。${detailSuffix}`, {
        confidence: 'high'
      })
    default:
      return null
  }
}

function createStep(
  event: RecordedEvent,
  kind: SuggestedFlowStepKind,
  title: string,
  detail: string,
  options?: {
    pageUrl?: string
    selector?: string
    confidence?: SuggestedFlowStep['confidence']
  }
): SuggestedFlowStep {
  return {
    id: `step-${event.id}`,
    kind,
    title,
    detail,
    pageUrl: options?.pageUrl ?? event.pageUrl,
    selector: options?.selector,
    confidence: options?.confidence ?? 'medium',
    eventIds: [event.id]
  }
}

function normalizeFieldLabel(value: string): string {
  if (/手机号|mobile|phone/i.test(value)) {
    return '登录手机号'
  }
  if (/密码|password|pass|pwd/i.test(value)) {
    return '登录密码'
  }
  if (/验证码|captcha|code/i.test(value)) {
    return '图形验证码'
  }
  return value.replace(/请输入|请输|请填写/g, '').trim()
}

function inferLegacyFieldLabel(event: RecordedEvent): string | undefined {
  const selector = firstSelector(event)
  if (!selector || !event.pageUrl.includes('/pc/index.html#/')) {
    return undefined
  }

  if (/form > div:nth-of-type\(1\)/.test(selector)) {
    return '登录手机号'
  }
  if (/form > div:nth-of-type\(2\)/.test(selector)) {
    return '登录密码'
  }
  if (/form > div:nth-of-type\(3\)/.test(selector)) {
    return '图形验证码'
  }
  return undefined
}

function describeTimeHint(event: RecordedEvent): string {
  const currentTime = readNumber(event.data?.currentTime)
  const duration = readNumber(event.data?.duration)

  if (currentTime === undefined || duration === undefined) {
    return ''
  }

  return ` 已播放 ${formatTime(currentTime)} / ${formatTime(duration)}。`
}

function compareEventsByTime(left: RecordedEvent, right: RecordedEvent): number {
  if (left.timestamp === right.timestamp) {
    return left.id.localeCompare(right.id)
  }
  return left.timestamp.localeCompare(right.timestamp)
}

function firstSelector(event: RecordedEvent): string | undefined {
  return event.selectors?.[0]?.value
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
