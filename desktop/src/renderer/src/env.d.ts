/// <reference types="vite/client" />
import type { ConnectorBridge } from '../../preload/index'

declare global {
  interface Window {
    connector: ConnectorBridge
  }
}

export {}
