import type { ConnectorBridge } from './index'

declare global {
  interface Window {
    connector: ConnectorBridge
  }
}

export {}
