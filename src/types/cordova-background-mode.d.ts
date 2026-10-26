interface BackgroundModePlugin {
  enable(): void
  disable(): void
  isEnabled(): boolean
  on?(event: 'activate' | 'deactivate' | 'enable' | 'disable' | 'failure', callback: () => void): void
  disableWebViewOptimizations?(): void
  disableBatteryOptimizations?(): void
  openAppStartSettings?(options?: boolean | { title?: string; text?: string }): void
  overrideBackButton?(): void
  setDefaults(opts: {
    title?: string
    text?: string
    icon?: string
    color?: string
    resume?: boolean
    hidden?: boolean
    silent?: boolean
  }): void
}

interface CordovaPlugins {
  backgroundMode?: BackgroundModePlugin
}

interface CordovaGlobal {
  plugins?: CordovaPlugins
}

interface Window {
  cordova?: CordovaGlobal
}
