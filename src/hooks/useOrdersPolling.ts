import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { AppSettings } from '../lib/settingsStorage'
import { printerConfigured, settingsAreComplete } from '../lib/settingsStorage'
import { fetchKitchenOrders } from '../lib/fetchKitchenOrders'
import { getSupabase } from '../lib/supabaseClient'
import type { OrderRow } from '../lib/ordersQuery'
import { NativeOrderPoller } from '../lib/nativeOrderPoller'
import { buildOrderTicketPreview, printOrderEscPos } from '../lib/thermalPrinter'
import { getMenuItemsPriceMap } from '../lib/menuItemsPrices'

const PRINTED_KEY = 'resto_kds_printed_order_ids'
const MAX_ACTIVITY = 40
const MAX_PRINT_LOGS = 20

export type ActivityEntry = {
  id: string
  at: number
  text: string
}

function loadPrintedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(PRINTED_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function savePrintedSet(s: Set<string>): void {
  localStorage.setItem(PRINTED_KEY, JSON.stringify([...s]))
}

function rowSignature(row: OrderRow): string {
  const st = String(row.status ?? '')
  const u = String(row.updated_at ?? '')
  const c = String(row.created_at ?? '')
  return `${st}|${u}|${c}`
}

function shortId(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 8)}…`
}

export type PollState = {
  rows: OrderRow[]
  lastError: string | null
  lastPollAt: number | null
  pollCount: number
  activity: ActivityEntry[]
  printedLogs: PrintedTicketLog[]
}

export type PrintedTicketLog = {
  id: string
  at: number
  orderId: string
  status: 'printed' | 'failed' | 'simulated'
  preview: string
  order: OrderRow
  error?: string
}

function newActivityId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function useOrdersPolling(
  settings: AppSettings,
  enabled: boolean,
  delegateNativeBackgroundPrint = false,
) {
  const [state, setState] = useState<PollState>({
    rows: [],
    lastError: null,
    lastPollAt: null,
    pollCount: 0,
    activity: [],
    printedLogs: [],
  })

  const printedRef = useRef<Set<string>>(loadPrintedSet())
  const tickRef = useRef(0)
  /** id → firma del último poll (status + fechas) */
  const prevSigRef = useRef<Map<string, string>>(new Map())
  const hadFirstPollRef = useRef(false)
  const settingsKeyRef = useRef('')

  const appendActivity = useCallback((lines: string[]) => {
    if (!lines.length) return
    const at = Date.now()
    setState((s) => {
      const additions: ActivityEntry[] = lines.map((text) => ({
        id: newActivityId(),
        at,
        text,
      }))
      const activity = [...additions, ...s.activity].slice(0, MAX_ACTIVITY)
      return { ...s, activity }
    })
  }, [])

  const settingsKey = `${settings.supabaseUrl}|${settings.restaurantId}`

  useEffect(() => {
    if (settingsKeyRef.current !== settingsKey) {
      settingsKeyRef.current = settingsKey
      prevSigRef.current = new Map()
      hadFirstPollRef.current = false
      setState((s) => ({
        ...s,
        activity: [],
        rows: [],
        pollCount: 0,
        lastPollAt: null,
        printedLogs: [],
      }))
    }
  }, [settingsKey])

  const pollOnce = useCallback(async () => {
    if (!enabled || !settingsAreComplete(settings)) return

    const supabase = getSupabase(settings)
    const { rows, error } = await fetchKitchenOrders(supabase, settings.restaurantId)

    const now = Date.now()
    if (error) {
      setState((s) => ({
        ...s,
        lastError: error.message,
        lastPollAt: now,
        pollCount: s.pollCount + 1,
      }))
      return
    }

    const prev = prevSigRef.current
    const currentIds = new Set<string>()
    const lines: string[] = []

    if (!hadFirstPollRef.current) {
      hadFirstPollRef.current = true
      for (const row of rows) {
        const id = row.id != null ? String(row.id) : ''
        if (id) {
          currentIds.add(id)
          prev.set(id, rowSignature(row))
        }
      }
      if (rows.length === 0) {
        lines.push('Conectado. Sin pedidos en cola de cocina.')
      } else {
        lines.push(`Conectado. ${rows.length} pedido(s) en cola de cocina.`)
      }
    } else {
      for (const row of rows) {
        const id = row.id != null ? String(row.id) : ''
        if (!id) continue
        currentIds.add(id)
        const sig = rowSignature(row)
        const old = prev.get(id)
        if (old === undefined) {
          lines.push(
            `Nuevo pedido: ${shortId(id)} · ${String(row.status ?? '—')}`,
          )
        } else if (old !== sig) {
          const oldStatus = old.split('|')[0] ?? ''
          lines.push(
            `Actualización: ${shortId(id)} · ${oldStatus || '?'} → ${String(row.status ?? '—')}`,
          )
        }
        prev.set(id, sig)
      }

      const dropped = [...prev.keys()].filter((id) => !currentIds.has(id))
      for (const id of dropped) {
        lines.push(`Ya no en cola cocina: ${shortId(id)}`)
        prev.delete(id)
      }
    }

    if (lines.length) appendActivity(lines)

    setState((s) => ({
      ...s,
      rows,
      lastError: null,
      lastPollAt: now,
      pollCount: s.pollCount + 1,
    }))

    const printed = printedRef.current
    const toPrint: OrderRow[] = []

    for (const row of rows) {
      const id = row.id != null ? String(row.id) : null
      if (!id || printed.has(id)) continue
      toPrint.push(row)
    }

    if (printerConfigured(settings) && !delegateNativeBackgroundPrint) {
      const menuPriceMap = await getMenuItemsPriceMap(supabase, settings.restaurantId)
      let markedPrinted = false
      for (const row of toPrint) {
        const id = String(row.id)
        const preview = buildOrderTicketPreview(row, menuPriceMap)
        if (!Capacitor.isNativePlatform()) {
          const entry: PrintedTicketLog = {
            id: newActivityId(),
            at: Date.now(),
            orderId: id,
            status: 'simulated',
            preview,
            order: row,
            error: 'Web/localhost: no se envía TCP real. Solo vista previa del ticket.',
          }
          setState((s) => ({
            ...s,
            printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
          }))
          printed.add(id)
          markedPrinted = true
          continue
        }
        try {
          await printOrderEscPos(settings.printerHost, settings.printerPort, row, menuPriceMap)
          printed.add(id)
          markedPrinted = true
          const entry: PrintedTicketLog = {
            id: newActivityId(),
            at: Date.now(),
            orderId: id,
            status: 'printed',
            preview,
            order: row,
          }
          setState((s) => ({
            ...s,
            printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
          }))
        } catch (e) {
          console.error(e)
          const errText = e instanceof Error ? e.message : String(e)
          const entry: PrintedTicketLog = {
            id: newActivityId(),
            at: Date.now(),
            orderId: id,
            status: 'failed',
            preview,
            order: row,
            error: errText,
          }
          setState((s) => ({
            ...s,
            lastError: errText,
            printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
          }))
          break
        }
      }
      if (markedPrinted) savePrintedSet(printed)
    }
  }, [enabled, settings, appendActivity, delegateNativeBackgroundPrint])

  useEffect(() => {
    if (!enabled || !settingsAreComplete(settings)) return

    const ms = Math.max(1500, settings.pollIntervalMs)
    void pollOnce()

    tickRef.current = window.setInterval(() => {
      void pollOnce()
    }, ms)

    return () => {
      window.clearInterval(tickRef.current)
    }
  }, [enabled, settings, pollOnce])

  const clearActivity = useCallback(() => {
    setState((s) => ({ ...s, activity: [] }))
  }, [])

  const clearPrintedLogs = useCallback(() => {
    setState((s) => ({ ...s, printedLogs: [] }))
  }, [])

  const resetPollingCounters = useCallback(() => {
    setState((s) => ({
      ...s,
      pollCount: 0,
      lastPollAt: null,
      lastError: null,
    }))
  }, [])

  const mergePrintedFromNative = useCallback(async () => {
    if (!delegateNativeBackgroundPrint || !Capacitor.isNativePlatform()) return
    try {
      const { printedIdsJson } = await NativeOrderPoller.getPrintedIdsJson()
      const arr = JSON.parse(printedIdsJson) as unknown
      if (!Array.isArray(arr)) return
      let changed = false
      for (const id of arr) {
        if (typeof id !== 'string') continue
        if (!printedRef.current.has(id)) {
          printedRef.current.add(id)
          changed = true
        }
      }
      if (changed) savePrintedSet(printedRef.current)
    } catch {
      // noop
    }
  }, [delegateNativeBackgroundPrint])

  const reprintLog = useCallback(
    async (logId: string) => {
      const target = state.printedLogs.find((l) => l.id === logId)
      if (!target) return

      if (!printerConfigured(settings)) {
        const entry: PrintedTicketLog = {
          id: newActivityId(),
          at: Date.now(),
          orderId: target.orderId,
          status: 'failed',
          preview: target.preview,
          order: target.order,
          error: 'No hay impresora configurada (IP/puerto).',
        }
        setState((s) => ({
          ...s,
          lastError: entry.error ?? null,
          printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
        }))
        return
      }

      if (!Capacitor.isNativePlatform()) {
        const entry: PrintedTicketLog = {
          id: newActivityId(),
          at: Date.now(),
          orderId: target.orderId,
          status: 'simulated',
          preview: target.preview,
          order: target.order,
          error: 'Reimpresión simulada en web/localhost (sin envío TCP real).',
        }
        setState((s) => ({
          ...s,
          printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
        }))
        return
      }

      try {
        const supabase = getSupabase(settings)
        const menuPriceMap = await getMenuItemsPriceMap(supabase, settings.restaurantId)
        await printOrderEscPos(settings.printerHost, settings.printerPort, target.order, menuPriceMap)
        const entry: PrintedTicketLog = {
          id: newActivityId(),
          at: Date.now(),
          orderId: target.orderId,
          status: 'printed',
          preview: target.preview,
          order: target.order,
        }
        setState((s) => ({
          ...s,
          printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
        }))
      } catch (e) {
        const errText = e instanceof Error ? e.message : String(e)
        const entry: PrintedTicketLog = {
          id: newActivityId(),
          at: Date.now(),
          orderId: target.orderId,
          status: 'failed',
          preview: target.preview,
          order: target.order,
          error: `Reimpresión falló: ${errText}`,
        }
        setState((s) => ({
          ...s,
          lastError: entry.error ?? null,
          printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
        }))
      }
    },
    [settings, state.printedLogs],
  )

  return {
    state,
    pollOnce,
    clearPrintedMemory: () => {
      printedRef.current = new Set()
      savePrintedSet(printedRef.current)
      if (delegateNativeBackgroundPrint && Capacitor.isNativePlatform()) {
        void NativeOrderPoller.clearPrintedIds()
      }
    },
    clearActivity,
    clearPrintedLogs,
    reprintLog,
    resetPollingCounters,
    mergePrintedFromNative,
  }
}
