import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// The renderer reuses the browser app's component tree where possible.
// `@geny` points at ../frontend/src so ported overlay code can import the
// existing Live2D/Spine canvases, the audio engine, the WS transport, and the
// zustand stores without copying them. (Next-specific modules are shimmed in
// src/renderer/src/next-shims — see README §"Reusing the browser renderer".)
const frontendSrc = resolve(__dirname, '../frontend/src')

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // keytar is a native addon — never bundle it.
        external: ['keytar'],
      },
    },
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@geny': frontendSrc,
      },
    },
    plugins: [react()],
    server: {
      // Allow Vite to serve files from the sibling frontend/src tree.
      fs: { allow: [resolve(__dirname, '..')] },
    },
  },
})
