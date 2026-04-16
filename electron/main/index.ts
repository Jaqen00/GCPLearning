import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_COURSE_URL } from '@shared/contracts'
import { BrowserRecorderService } from './browserRecorder'

app.disableHardwareAcceleration()

process.env.APP_ROOT = join(__dirname, '../..')

const RENDERER_DIST = join(process.env.APP_ROOT, 'out/renderer')
const VITE_DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null
let recorder: BrowserRecorderService | null = null
let screenshotCaptured = false

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 620,
    minWidth: 440,
    minHeight: 520,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '观看助手',
    backgroundColor: '#091019',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  recorder?.attachHostWindow(mainWindow)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(join(RENDERER_DIST, 'index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    const currentState = recorder?.getState()
    if (currentState) {
      mainWindow?.webContents.send('recorder:state', currentState)
    }

    void maybeCaptureMainWindowScreenshot()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function maybeCaptureMainWindowScreenshot(): Promise<void> {
  const targetPath = process.env.APP_SCREENSHOT_PATH
  if (!targetPath || screenshotCaptured || !mainWindow || mainWindow.isDestroyed()) {
    return
  }

  screenshotCaptured = true

  await new Promise((resolve) => setTimeout(resolve, 700))
  const image = await mainWindow.webContents.capturePage().catch(() => null)
  if (!image) {
    return
  }

  await mkdir(dirname(targetPath), { recursive: true }).catch(() => undefined)
  await writeFile(targetPath, image.toPNG()).catch(() => undefined)

  setTimeout(() => {
    app.quit()
  }, 300)
}

function getRecorder(): BrowserRecorderService {
  if (!recorder) {
    throw new Error('Recorder service is not ready yet.')
  }
  return recorder
}

function registerIpcHandlers(): void {
  ipcMain.handle('recorder:get-state', () => {
    return getRecorder().getState()
  })

  ipcMain.handle('recorder:get-latest-trace', async () => {
    return getRecorder().getLatestTrace()
  })

  ipcMain.handle('settings:load', async () => {
    return getRecorder().loadSettings()
  })

  ipcMain.handle('settings:update', async (_event, patch) => {
    return getRecorder().updateSettings(patch)
  })

  ipcMain.handle('window:set-preferred-height', async (_event, height: number) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return
    }

    const nextContentHeight = Math.max(520, Math.min(900, Math.round(height)))
    const contentBounds = mainWindow.getContentBounds()
    const windowBounds = mainWindow.getBounds()
    const chromeHeight = windowBounds.height - contentBounds.height
    const nextWindowHeight = nextContentHeight + chromeHeight

    if (Math.abs(windowBounds.height - nextWindowHeight) < 8) {
      return
    }

    mainWindow.setBounds({
      x: windowBounds.x,
      y: windowBounds.y,
      width: windowBounds.width,
      height: nextWindowHeight
    })
  })

  ipcMain.handle('learning:start', async () => {
    return getRecorder().startLearning()
  })

  ipcMain.handle('learning:pause', async () => {
    return getRecorder().pauseLearning()
  })

  ipcMain.handle('learning:resume', async () => {
    return getRecorder().resumeLearning()
  })

  ipcMain.handle('learning:resume-session', async () => {
    return getRecorder().resumeManagedSession()
  })

  ipcMain.handle('learning:inspect-session', async () => {
    return getRecorder().inspectSession()
  })

  ipcMain.handle('learning:submit-login', async () => {
    return getRecorder().submitLoginAfterCaptcha()
  })

  ipcMain.handle('learning:open-my-classes', async () => {
    return getRecorder().openMyClasses()
  })

  ipcMain.handle('learning:enter-current-course', async () => {
    return getRecorder().enterCurrentCourse()
  })

  ipcMain.handle('learning:acknowledge-continue-prompt', async () => {
    return getRecorder().acknowledgeContinuePrompt()
  })

  ipcMain.handle('recorder:open-browser', async (_event, url?: string) => {
    return getRecorder().openBrowser(url)
  })

  ipcMain.handle('recorder:start-recording', async (_event, label?: string) => {
    return getRecorder().startRecording(label)
  })

  ipcMain.handle('recorder:stop-recording', async () => {
    return getRecorder().stopRecording()
  })

  ipcMain.handle('recorder:export-trace', async () => {
    return getRecorder().exportTrace()
  })

  ipcMain.handle('shell:open-path', async (_event, targetPath: string) => {
    await shell.openPath(targetPath)
  })
}

app.whenReady().then(() => {
  recorder = new BrowserRecorderService({
    sessionDataDir: join(app.getPath('userData'), 'managed-session-data'),
    tracesDir: join(app.getPath('documents'), 'CourseAutomationStudio', 'traces'),
    settingsFile: join(app.getPath('userData'), 'settings.json'),
    baseUrl: DEFAULT_COURSE_URL,
    onStateChange: (state) => {
      mainWindow?.webContents.send('recorder:state', state)
    },
    onEvent: (event) => {
      mainWindow?.webContents.send('recorder:event', event)
    }
  })

  registerIpcHandlers()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('before-quit', () => {
  void recorder?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
