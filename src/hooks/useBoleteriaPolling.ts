import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { AppSettings } from '../lib/settingsStorage'
import { printerConfigured, settingsAreComplete } from '../lib/settingsStorage'
import {
  ackTicketPrinted,
  fetchFisicoTickets,
  type BoleteriaTicketRow,
} from '../lib/boleteriaTickets'
import { getSupabase } from '../lib/supabaseClient'
import { NativeOrderPoller } from '../lib/nativeOrderPoller'
import {
  buildBoleteriaTicketPreview,
  printBoleteriaTicketEscPos,
} from '../lib/thermalPrinter'

const PRINTED_KEY = 'resto_kds_printed_boleteria_ids'
const MAX_ACTIVITY = 40
const MAX_PRINT_LOGS = 20

export type ActivityEntry = {
  id: string
  at: number
  text: string
}

export type PrintedBoletoLog = {
  id: string
  at: number
  ticketId: string
  shortCode: string
  status: 'printed' | 'failed' | 'simulated'
  preview: string
  ticket: BoleteriaTicketRow
  error?: string
}

export type BoleteriaPollState = {
  rows: BoleteriaTicketRow[]
  lastError: string | null
  lastPollAt: number | null
  pollCount: number
  activity: ActivityEntry[]
  printedLogs: PrintedBoletoLog[]
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

function shortId(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 8)}…`
}

function newActivityId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Polling de entradas fisico=true (proyecto boletería).
 * Tras imprimir: UPDATE fisico=false + printCount++.
 */
export function useBoleteriaPolling(
  settings: AppSettings,
  enabled: boolean,
  delegateNativeBackgroundPrint = false,
) {
  const [state, setState] = useState<BoleteriaPollState>({
    rows: [],
    lastError: null,
    lastPollAt: null,
    pollCount: 0,
    activity: [],
    printedLogs: [],
  })

  const printedRef = useRef<Set<string>>(loadPrintedSet())
  const tickRef = useRef(0)
  const prevIdsRef = useRef<Set<string>>(new Set())
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
      return { ...s, activity: [...additions, ...s.activity].slice(0, MAX_ACTIVITY) }
    })
  }, [])

  const settingsKey = `${settings.supabaseUrl}|boleteria`

  useEffect(() => {
    if (settingsKeyRef.current !== settingsKey) {
      settingsKeyRef.current = settingsKey
      prevIdsRef.current = new Set()
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

  const pollingRef = useRef(false)

  const pollPass = useCallback(async () => {
    const supabase = getSupabase(settings)
    const { rows, error } = await fetchFisicoTickets(supabase)
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

    const prev = prevIdsRef.current
    const currentIds = new Set<string>()
    const lines: string[] = []

    if (!hadFirstPollRef.current) {
      hadFirstPollRef.current = true
      for (const row of rows) {
        currentIds.add(row.id)
        prev.add(row.id)
      }
      if (rows.length === 0) {
        lines.push('Conectado. Sin boletos en cola de impresión.')
      } else {
        lines.push(`Conectado. ${rows.length} boleto(s) pendientes (fisico).`)
      }
    } else {
      for (const row of rows) {
        currentIds.add(row.id)
        if (!prev.has(row.id)) {
          lines.push(`Nuevo boleto: ${row.shortCode || shortId(row.id)}`)
        }
        prev.add(row.id)
      }
      for (const id of [...prev]) {
        if (!currentIds.has(id)) {
          lines.push(`Salio de cola: ${shortId(id)}`)
          prev.delete(id)
        }
      }
    }

    // Lo que ya no está en cola quedó confirmado (fisico=false); si vuelve a la cola, se reimprime.
    let pruned = false
    for (const id of [...printedRef.current]) {
      if (!currentIds.has(id)) {
        printedRef.current.delete(id)
        pruned = true
      }
    }
    if (pruned) savePrintedSet(printedRef.current)

    if (lines.length) appendActivity(lines)

    setState((s) => ({
      ...s,
      rows,
      lastError: null,
      lastPollAt: now,
      pollCount: s.pollCount + 1,
    }))

    const printed = printedRef.current
    const toPrint = rows.filter((row) => !printed.has(row.id))

    if (printerConfigured(settings) && !delegateNativeBackgroundPrint) {
      if (Capacitor.isNativePlatform()) {
        // Impresos cuya marca fisico=false falló: solo se reintenta la marca, nunca se reimprimen.
        for (const row of rows) {
          if (!printed.has(row.id)) continue
          const ack = await ackTicketPrinted(supabase, row)
          if (!ack.ok) {
            setState((s) => ({
              ...s,
              lastError: `Boleto ${row.shortCode || shortId(row.id)} impreso pero sin marcar en la base: ${ack.error?.message ?? 'sin permiso de UPDATE'}`,
            }))
            break
          }
        }
      }

      let markedPrinted = false
      for (const row of toPrint) {
        const preview = buildBoleteriaTicketPreview(row)
        if (!Capacitor.isNativePlatform()) {
          const entry: PrintedBoletoLog = {
            id: newActivityId(),
            at: Date.now(),
            ticketId: row.id,
            shortCode: row.shortCode,
            status: 'simulated',
            preview,
            ticket: row,
            error:
              'Web/localhost: sin TCP ni ack (fisico sigue true). Solo vista previa local.',
          }
          setState((s) => ({
            ...s,
            printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
          }))
          printed.add(row.id)
          markedPrinted = true
          continue
        }
        try {
          await printBoleteriaTicketEscPos(settings.printerHost, settings.printerPort, row)
          printed.add(row.id)
          savePrintedSet(printed)
          markedPrinted = true
          const ack = await ackTicketPrinted(supabase, row)
          const ackError = ack.ok
            ? undefined
            : `Impreso, pero no se pudo marcar fisico=false (${ack.error?.message ?? 'sin permiso de UPDATE'}). No se reimprime; se reintenta marcarlo.`
          const entry: PrintedBoletoLog = {
            id: newActivityId(),
            at: Date.now(),
            ticketId: row.id,
            shortCode: row.shortCode,
            status: 'printed',
            preview,
            ticket: row,
            error: ackError,
          }
          setState((s) => ({
            ...s,
            lastError: ackError ?? s.lastError,
            printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
          }))
        } catch (e) {
          console.error(e)
          const errText = e instanceof Error ? e.message : String(e)
          const entry: PrintedBoletoLog = {
            id: newActivityId(),
            at: Date.now(),
            ticketId: row.id,
            shortCode: row.shortCode,
            status: 'failed',
            preview,
            ticket: row,
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
  }, [settings, appendActivity, delegateNativeBackgroundPrint])

  const pollOnce = useCallback(async () => {
    if (!enabled || !settingsAreComplete(settings)) return
    // Imprimir varios boletos tarda más que el intervalo; dos pasadas a la vez duplicarían boletos.
    if (pollingRef.current) return
    pollingRef.current = true
    try {
      await pollPass()
    } finally {
      pollingRef.current = false
    }
  }, [enabled, settings, pollPass])

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
        const entry: PrintedBoletoLog = {
          id: newActivityId(),
          at: Date.now(),
          ticketId: target.ticketId,
          shortCode: target.shortCode,
          status: 'failed',
          preview: target.preview,
          ticket: target.ticket,
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
        const entry: PrintedBoletoLog = {
          id: newActivityId(),
          at: Date.now(),
          ticketId: target.ticketId,
          shortCode: target.shortCode,
          status: 'simulated',
          preview: target.preview,
          ticket: target.ticket,
          error: 'Reimpresión simulada en web/localhost (sin envío TCP real).',
        }
        setState((s) => ({
          ...s,
          printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
        }))
        return
      }

      try {
        await printBoleteriaTicketEscPos(
          settings.printerHost,
          settings.printerPort,
          target.ticket,
        )
        const entry: PrintedBoletoLog = {
          id: newActivityId(),
          at: Date.now(),
          ticketId: target.ticketId,
          shortCode: target.shortCode,
          status: 'printed',
          preview: target.preview,
          ticket: target.ticket,
        }
        setState((s) => ({
          ...s,
          printedLogs: [entry, ...s.printedLogs].slice(0, MAX_PRINT_LOGS),
        }))
      } catch (e) {
        const errText = e instanceof Error ? e.message : String(e)
        const entry: PrintedBoletoLog = {
          id: newActivityId(),
          at: Date.now(),
          ticketId: target.ticketId,
          shortCode: target.shortCode,
          status: 'failed',
          preview: target.preview,
          ticket: target.ticket,
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
