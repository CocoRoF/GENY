import React from 'react'
import ReactDOM from 'react-dom/client'
import { OverlayApp } from './OverlayApp'
import { ControlApp } from './ControlApp'
import './styles.css'

// One renderer build serves the local windows; ?window=overlay → avatar
// placeholder, ?window=settings → the settings/login panel (ControlApp).
const kind = window.connector?.windowKind ?? 'overlay'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{kind === 'overlay' ? <OverlayApp /> : <ControlApp />}</React.StrictMode>,
)
