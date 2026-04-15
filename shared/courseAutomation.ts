import type { AutomationFlowItem } from './contracts'

export const NMPA_AUTOMATION_FLOW: AutomationFlowItem[] = [
  {
    id: 'resume-session',
    title: '恢复浏览器会话并检查登录有效性',
    detail: '启动学习浏览器后优先复用本地登录态，如果会话已过期，再进入重新登录流程。',
    support: 'supported'
  },
  {
    id: 'fill-credentials',
    title: '自动填充手机号和密码',
    detail: '用户保存过账号密码后，客户端会在登录失效时自动回到登录页并填充手机号和密码。',
    support: 'supported'
  },
  {
    id: 'captcha-assist',
    title: '等待用户输入验证码',
    detail: '图形验证码仍由用户手动输入，避免站点风控和识别误判；输入后可由客户端继续点击登录。',
    support: 'assisted'
  },
  {
    id: 'login-submit',
    title: '提交登录并回检状态',
    detail: '验证码输入完成后，客户端可代为点击登录，并再次检查当前会话是否已经恢复。',
    support: 'supported'
  },
  {
    id: 'open-classes',
    title: '打开个人中心课程页',
    detail: '已登录状态下直接进入“我的班级课程页”，避免依赖首页导航层层点击。',
    support: 'supported'
  },
  {
    id: 'enter-course',
    title: '进入当前课程并打开学习页',
    detail: '根据当前页面可见的“进入学习 / 开始学习 / 确定”按钮推进到播放页。',
    support: 'supported'
  },
  {
    id: 'watch-progress',
    title: '监控视频播放进度',
    detail: '播放页会持续感知当前课程、章节和视频进度，并识别“是否继续学习”提示框。',
    support: 'supported'
  },
  {
    id: 'continue-dialog',
    title: '处理继续学习提示',
    detail: '如果播放页弹出“是否继续学习？”提示，客户端可以继续确认。',
    support: 'supported'
  },
  {
    id: 'next-sub-video',
    title: '同页切换下一个子视频',
    detail: '当同一个课程页内存在多个章节视频时，可以沿目录继续点击下一条，但还需要更多真实样本验证。',
    support: 'assisted'
  },
  {
    id: 'next-course',
    title: '跨课程自动切换到下一门课',
    detail: '当前还缺少足够稳定的页面规则来判断下一门课和课程完成状态，这部分还要继续补录和验证。',
    support: 'planned'
  },
  {
    id: 'course-evaluation',
    title: '自动评估课程',
    detail: '评估页与评估弹窗的规则还没完全收齐，后续在拿到真实流程后补成稳定动作。',
    support: 'planned'
  }
]
