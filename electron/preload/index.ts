import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ExportTraceResult,
  LearningSessionState,
  RecordedEvent,
  RecorderApi,
  RecordedTraceBundle,
  RecorderState
} from '@shared/contracts'

const api: RecorderApi = {
  getState: () => ipcRenderer.invoke('recorder:get-state'),
  getLatestTrace: () => ipcRenderer.invoke('recorder:get-latest-trace'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  setBrowserViewport: (bounds) => ipcRenderer.invoke('learning:set-browser-viewport', bounds),
  startLearning: () => ipcRenderer.invoke('learning:start'),
  resumeManagedSession: () => ipcRenderer.invoke('learning:resume-session'),
  inspectSession: () => ipcRenderer.invoke('learning:inspect-session'),
  submitLoginAfterCaptcha: () => ipcRenderer.invoke('learning:submit-login'),
  openMyClasses: () => ipcRenderer.invoke('learning:open-my-classes'),
  enterCurrentCourse: () => ipcRenderer.invoke('learning:enter-current-course'),
  acknowledgeContinuePrompt: () => ipcRenderer.invoke('learning:acknowledge-continue-prompt'),
  openBrowser: (url?: string) => ipcRenderer.invoke('recorder:open-browser', url),
  startRecording: (label?: string) => ipcRenderer.invoke('recorder:start-recording', label),
  stopRecording: () => ipcRenderer.invoke('recorder:stop-recording'),
  exportTrace: () => ipcRenderer.invoke('recorder:export-trace'),
  openPath: (targetPath: string) => ipcRenderer.invoke('shell:open-path', targetPath),
  onState: (callback: (state: RecorderState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: RecorderState) => {
      callback(state)
    }
    ipcRenderer.on('recorder:state', listener)
    return () => {
      ipcRenderer.removeListener('recorder:state', listener)
    }
  },
  onEvent: (callback: (event: RecordedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: RecordedEvent) => {
      callback(event)
    }
    ipcRenderer.on('recorder:event', listener)
    return () => {
      ipcRenderer.removeListener('recorder:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('recorder', api)

export type { ExportTraceResult, LearningSessionState, RecordedTraceBundle }
