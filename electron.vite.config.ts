import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const projectRoot = __dirname

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(projectRoot, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'electron/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(projectRoot, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: projectRoot,
    resolve: {
      alias: {
        '@shared': resolve(projectRoot, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'index.html')
      }
    },
    plugins: [react()]
  }
})
