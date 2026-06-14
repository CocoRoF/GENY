import React from 'react'
import ReactDOM from 'react-dom/client'
import { OverlayApp } from './OverlayApp'
import { ControlApp } from './ControlApp'
import './styles.css'

// One renderer build serves both windows; ?window=overlay|control picks which
// React tree to mount (see main/index.ts loadRoute).
const kind = window.connector?.windowKind ?? 'overlay'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{kind === 'control' ? <ControlApp /> : <OverlayApp />}</React.StrictMode>,
)
