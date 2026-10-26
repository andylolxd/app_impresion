import { registerPlugin } from '@capacitor/core'

export interface NativeOrderPollerPlugin {
  configure(options: {
    supabaseUrl: string
    supabaseAnonKey: string
    restaurantId: string
    printerHost: string
    printerPort: number
    pollIntervalMs: number
    printedIdsJson: string
    /** restaurant (default) | boleteria */
    workMode?: string
  }): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  clearPrintedIds(): Promise<void>
  getPrintedIdsJson(): Promise<{ printedIdsJson: string }>
}

export const NativeOrderPoller = registerPlugin<NativeOrderPollerPlugin>('NativeOrderPoller')
