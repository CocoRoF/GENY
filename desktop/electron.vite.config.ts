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
        // Native addons (keytar, nut.js) + electron-updater + the MCP SDK stay
        // external so they resolve from node_modules at runtime (packaged by
        // electron-builder). The MCP SDK is ESM + spawns stdio children.
        external: ['keytar', 'electron-updater', '@nut-tree-fork/nut-js', '@modelcontextprotocol/sdk'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        // Emit CommonJS .cjs: a sandboxed renderer (contextIsolation default)
        // cannot load an ESM (.mjs) preload, and package.json "type":"module"
        // would otherwise make electron-vite emit .mjs. .cjs is unambiguous CJS.
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
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
