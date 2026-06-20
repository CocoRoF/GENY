import React from 'react'
import ReactDOM from 'react-dom/client'
import { OverlayApp } from './OverlayApp'
import { ControlApp } from './ControlApp'
import { QuickChatApp } from './QuickChatApp'
import './styles.css'

// One renderer build serves the local windows; ?window=overlay → avatar
// placeholder, ?window=settings → the settings/login panel (ControlApp),
// ?window=quickchat → the floating Spotlight-style input bar.
const kind = window.connector?.windowKind ?? 'overlay'

const root =
  kind === 'overlay' ? <OverlayApp /> : kind === 'quickchat' ? <QuickChatApp /> : <ControlApp />

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{root}</React.StrictMode>,
)
