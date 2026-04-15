/// <reference types="vite/client" />

import type { RecorderApi } from '@shared/contracts'

declare global {
  interface Window {
    recorder: RecorderApi
  }
}

export {}
