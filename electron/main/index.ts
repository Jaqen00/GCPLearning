import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { DEFAULT_COURSE_URL } from '@shared/contracts'
import { BrowserRecorderService } from './browserRecorder'

app.disableHardwareAcceleration()

process.env.APP_ROOT = join(__dirname, '../..')

const RENDERER_DIST = join(process.env.APP_ROOT, 'out/renderer')
const VITE_DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null
let recorder: BrowserRecorderService | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 900,
    minWidth: 580,
    minHeight: 760,
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
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
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

  ipcMain.handle('learning:start', async () => {
    return getRecorder().startLearning()
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
    profileDir: join(app.getPath('userData'), 'playwright-profile'),
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
