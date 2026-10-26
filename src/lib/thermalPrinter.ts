import { Capacitor, registerPlugin } from '@capacitor/core'
import type { BoleteriaTicketRow } from './boleteriaTickets'
import type { OrderRow } from './ordersQuery'

export interface ThermalPrinterPluginContract {
  sendBytes(options: { host: string; port: number; data: string }): Promise<void>
}

export const ThermalPrinter = registerPlugin<ThermalPrinterPluginContract>('ThermalPrinter')

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

/** Secuencias ESC/POS mínimas */
const ESC = 0x1b
const GS = 0x1d

function encoder(): TextEncoder {
  return new TextEncoder()
}

/** Separadores “puntito del medio” (Unicode) → ASCII; si no, `toThermalAscii` los pone como `?`. */
function replaceUnicodeSeparatorsForThermal(text: string): string {
  return text
    .replace(/\u00b7/g, ' | ') // · MIDDLE DOT (muy común en UI / notas)
    .replace(/\u2219/g, ' | ') // ∙ BULLET OPERATOR
    .replace(/\u2022/g, ' | ') // • BULLET
    .replace(/\u2027/g, ' | ') // ‧ HYPHENATION POINT
    .replace(/\u30fb/g, ' | ') // ・ KATAKANA MIDDLE DOT
    .replace(/\u0387/g, ' | ') // · GREEK ANO TELEIA
}

/**
 * Las térmicas suelen interpretar bytes como CP437/850, no UTF-8: los acentos y
 * símbolos Unicode (─ •) salen como “ruso” o basura. Para máxima compatibilidad
 * enviamos solo ASCII (acentos → sin tilde, ñ→n).
 */
function toThermalAscii(text: string): string {
  const stripped = replaceUnicodeSeparatorsForThermal(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
  return stripped
    .replace(/ñ/g, 'n')
    .replace(/Ñ/g, 'N')
    .replace(/[^\x20-\x7E\n\r\t]/g, '?')
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

function headerBytes(title: string): Uint8Array {
  const enc = encoder()
  const safe = toThermalAscii(title)
  return concat([
    new Uint8Array([ESC, 0x40]),
    new Uint8Array([ESC, 0x61, 0x01]),
    enc.encode(`${safe}\n`),
    new Uint8Array([ESC, 0x61, 0x00]),
  ])
}

function lineBytes(text: string): Uint8Array {
  return concat([encoder().encode(toThermalAscii(text)), new Uint8Array([0x0a])])
}

/** Centrado ESC/POS sin `ESC @` (evita reinicializar la impresora a mitad del ticket). */
function centeredLineBytes(text: string): Uint8Array {
  const enc = encoder()
  const safe = toThermalAscii(text)
  return concat([
    new Uint8Array([ESC, 0x61, 0x01]),
    enc.encode(`${safe}\n`),
    new Uint8Array([ESC, 0x61, 0x00]),
  ])
}

/** Centrado + negrita + altura doble (ESC/POS Epson típico); sin `ESC @`. */
function prominentCenteredAlertBytes(text: string): Uint8Array {
  const enc = encoder()
  const safe = toThermalAscii(text)
  return concat([
    new Uint8Array([ESC, 0x61, 0x01]),
    new Uint8Array([ESC, 0x45, 0x01]),
    new Uint8Array([ESC, 0x21, 0x08]),
    enc.encode(`${safe}\n`),
    new Uint8Array([ESC, 0x21, 0x00]),
    new Uint8Array([ESC, 0x45, 0x00]),
    new Uint8Array([ESC, 0x61, 0x00]),
  ])
}

function cutPartial(): Uint8Array {
  return new Uint8Array([GS, 0x56, 0x41, 0x03])
}

const MAX_CONTEXT_CHARS = 400
const MAX_PAYMENT_CHARS = 200
const MONEY_DECIMALS = 2

/** Encabezado del ticket (impreso centrado en ESC/POS). Solo ASCII (ver toThermalAscii). */
export const TICKET_RESTAURANT_BANNER = '--- RESTAURANTE ILLIMANI ---'

/** Pie del ticket (mismo estilo `--- ... ---` que el banner). */
export const TICKET_THANK_YOU_BANNER = '--- Gracias por su compra ---'

/** Prefijo de la alerta de envío programado (impreso destacado debajo del agradecimiento). */
export const TICKET_SCHEDULED_DELIVERY_LABEL = 'ENVIO PROGRAMADO'

/** Línea sobre dirección cuando el pedido es delivery. */
export const TICKET_DELIVERY_SECTION_LABEL = 'Envío a domicilio'

/** Zona horaria fija para la línea `Creado:` (Buenos Aires, Argentina). */
export const TICKET_TIMEZONE = 'America/Argentina/Buenos_Aires'

/** Fecha/hora en `TICKET_TIMEZONE` hasta segundos (sin ms). */
export function formatCreatedForTicket(iso: string): string {
  const raw = String(iso ?? '').trim()
  if (!raw) return ''
  const t = Date.parse(raw)
  if (Number.isNaN(t)) {
    return raw.includes('T') ? raw.slice(0, 19).replace('T', ' ') : raw
  }
  const d = new Date(t)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TICKET_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d)

  const map: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value
  }
  const y = map.year
  const mo = map.month
  const da = map.day
  const h = map.hour
  const mi = map.minute
  const s = map.second
  if (!y || !mo || !da) return raw.includes('T') ? raw.slice(0, 19).replace('T', ' ') : raw
  return `${y}-${mo}-${da} ${h ?? '00'}:${mi ?? '00'}:${s ?? '00'}`
}

function normalizedFulfillmentType(order: OrderRow): string {
  return String(order.fulfillment_type ?? '').toLowerCase().trim()
}

/** `delivery` u otros modos que comparten layout de envío (p. ej. mozo interno). */
function isDeliveryLike(order: OrderRow): boolean {
  const ft = normalizedFulfillmentType(order)
  return ft === 'delivery' || ft === 'delivery_mozo'
}

/**
 * Extrae el nombre del mozo desde `notes` (formato del otro proyecto: `... Mozo: Juan`).
 * Usa la última coincidencia tipo `Mozo:` al final del texto.
 */
export function parseMozoNameFromNotes(raw: string): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const m = s.match(/Mozo\s*:\s*(.+)$/im)
  const name = m?.[1]?.trim()
  return name || null
}

/** ISO parseable del campo `scheduled_delivery_at`, o null. */
function scheduledDeliveryIsoRaw(order: OrderRow): string | null {
  const v = order.scheduled_delivery_at
  if (typeof v !== 'string' || !v.trim()) return null
  const raw = v.trim()
  if (Number.isNaN(Date.parse(raw))) return null
  return raw
}

/**
 * Texto de alerta para envío programado (solo delivery + fecha válida).
 * Usa el mismo formato de hora que `Creado:` (`TICKET_TIMEZONE`).
 */
export function scheduledDeliveryAlertLine(order: OrderRow): string | null {
  if (!isDeliveryLike(order)) return null
  const iso = scheduledDeliveryIsoRaw(order)
  if (!iso) return null
  const when = formatCreatedForTicket(iso)
  if (!when) return null
  return `>>> ${TICKET_SCHEDULED_DELIVERY_LABEL}: ${when} <<<`
}

function money(value: number): string {
  return `$${value.toFixed(MONEY_DECIMALS)}`
}

function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2)
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value.replace(',', '.'))
    if (Number.isFinite(n)) return n
  }
  return null
}

function pickFirstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const n = asNumber(obj[k])
    if (n != null) return n
  }
  return null
}

function pickFirstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

type ParsedItem = { line: string; total: number | null }
export type MenuPriceMap = Record<string, number>

function normalizeItemName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function lookupPriceByName(menuPriceMap: MenuPriceMap | undefined, rawName: string): number | null {
  if (!menuPriceMap) return null
  const norm = normalizeItemName(rawName)
  if (!norm) return null
  if (menuPriceMap[norm] != null) return menuPriceMap[norm]!

  // fallback: intenta sin texto entre paréntesis en origen
  const noParen = normalizeItemName(rawName.replace(/\([^)]*\)/g, ' '))
  if (noParen && menuPriceMap[noParen] != null) return menuPriceMap[noParen]!
  return null
}

function itemHasPriceFields(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const row = v as Record<string, unknown>
  return ['unit_price', 'price', 'amount', 'unitPrice', 'total', 'total_price', 'line_total', 'subtotal']
    .some((k) => asNumber(row[k]) != null)
}

function scoreItemsSource(source: unknown): number {
  if (Array.isArray(source)) {
    const hasPricedObject = source.some(itemHasPriceFields)
    const hasObject = source.some((v) => v && typeof v === 'object')
    if (hasPricedObject) return 4
    if (hasObject) return 3
    return source.length > 0 ? 2 : 0
  }
  if (source && typeof source === 'object') {
    if (itemHasPriceFields(source)) return 4
    return 3
  }
  if (typeof source === 'string') return source.trim() ? 1 : 0
  return source != null ? 1 : 0
}

function pickBestItemsSource(order: OrderRow): unknown {
  const candidates = [order.order_items, order.line_items, order.items]
  let best: unknown = null
  let bestScore = -1
  for (const c of candidates) {
    const score = scoreItemsSource(c)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  return best
}

function parseTicketItem(it: unknown, menuPriceMap?: MenuPriceMap): ParsedItem {
  if (typeof it === 'string') {
    const unitPrice = lookupPriceByName(menuPriceMap, it)
    const priceText = unitPrice != null ? ` ${money(unitPrice)}` : ''
    return { line: `- ${it}${priceText}`, total: unitPrice ?? null }
  }
  if (!it || typeof it !== 'object') return { line: `- ${String(it)}`, total: null }

  const row = it as Record<string, unknown>
  const name = pickFirstString(row, ['name', 'title', 'product_name', 'product', 'item']) ?? JSON.stringify(it)
  const qty = pickFirstNumber(row, ['quantity', 'qty', 'count', 'units'])
  const unitPrice =
    pickFirstNumber(row, ['unit_price', 'price', 'amount', 'unitPrice']) ??
    lookupPriceByName(menuPriceMap, name)
  const lineTotal = pickFirstNumber(row, ['total', 'total_price', 'line_total', 'subtotal']) ??
    (qty != null && unitPrice != null ? qty * unitPrice : null)

  const qtyText = qty != null ? ` x${formatQty(qty)}` : ''
  const priceText =
    unitPrice != null && lineTotal != null
      ? ` ${money(unitPrice)}(${money(lineTotal)})`
      : lineTotal != null
        ? ` ${money(lineTotal)}`
        : unitPrice != null
          ? ` ${money(unitPrice)}`
          : ''
  return { line: `- ${name}${qtyText}${priceText}`, total: lineTotal }
}

function orderTotalForTicket(order: OrderRow, itemTotals: number[]): number | null {
  const direct =
    asNumber(order.final_total_amount) ??
    asNumber(order.total_amount) ??
    asNumber(order.total_price)
  if (direct != null) return direct
  if (itemTotals.length > 0) return itemTotals.reduce((a, b) => a + b, 0)
  return null
}

function deliveryFeeForTicket(order: OrderRow): number | null {
  if (!isDeliveryLike(order)) return null
  const fee = asNumber(order.delivery_fee)
  if (fee == null || fee <= 0) return null
  return fee
}

/** Texto para ticket: string o JSON si viene como objeto. */
function formatAddressForTicket(order: OrderRow): string | null {
  const a = order.address
  if (typeof a === 'string' && a.trim()) return a.trim().slice(0, MAX_CONTEXT_CHARS)
  if (a != null && typeof a === 'object') return JSON.stringify(a).slice(0, MAX_CONTEXT_CHARS)
  return null
}

function pushObservacionLine(order: OrderRow, push: (line: string) => void): void {
  const obs = order.observacion
  if (typeof obs !== 'string' || !obs.trim()) return
  push(`Observacion: ${obs.trim().slice(0, MAX_CONTEXT_CHARS)}`)
}

/**
 * delivery → address + payment (+ tel opcional en otro flujo).
 * delivery_mozo → igual que delivery + línea Mozo (nombre desde notes); sin teléfono en ticket.
 * local → notes · otros → notes si hay (compatibilidad).
 */
function pushFulfillmentContextLines(order: OrderRow, push: (line: string) => void): void {
  const ft = normalizedFulfillmentType(order)
  if (ft === 'delivery') {
    push(TICKET_DELIVERY_SECTION_LABEL)
    const addr = formatAddressForTicket(order)
    if (addr) push(`Direccion: ${addr}`)
    const pm = order.payment_method
    if (typeof pm === 'string' && pm.trim()) {
      push(`Pago: ${pm.trim().slice(0, MAX_PAYMENT_CHARS)}`)
    }
  } else if (ft === 'delivery_mozo') {
    push(TICKET_DELIVERY_SECTION_LABEL)
    const addr = formatAddressForTicket(order)
    if (addr) push(`Direccion: ${addr}`)
    const pm = order.payment_method
    if (typeof pm === 'string' && pm.trim()) {
      push(`Pago: ${pm.trim().slice(0, MAX_PAYMENT_CHARS)}`)
    }
    const notes = order.notes
    if (typeof notes === 'string' && notes.trim()) {
      const mozo = parseMozoNameFromNotes(notes.trim())
      if (mozo) push(`Mozo: ${mozo.slice(0, MAX_CONTEXT_CHARS)}`)
    }
  } else if (ft === 'local') {
    const notes = order.notes
    if (typeof notes === 'string' && notes.trim()) {
      push(`Notas: ${notes.trim().slice(0, MAX_CONTEXT_CHARS)}`)
    }
  } else {
    const notes = order.notes
    if (typeof notes === 'string' && notes.trim()) {
      push(`Notas: ${notes.trim().slice(0, MAX_CONTEXT_CHARS)}`)
    }
  }
  pushObservacionLine(order, push)
}

/**
 * Construye el ticket ESC/POS para un pedido (texto plano; ampliable con tu layout).
 */
export function buildOrderTicketBytes(order: OrderRow, menuPriceMap?: MenuPriceMap): Uint8Array {
  const created = formatCreatedForTicket(String(order.created_at ?? ''))
  const parts: Uint8Array[] = [
    headerBytes(TICKET_RESTAURANT_BANNER),
    lineBytes(''),
    lineBytes(`Creado: ${created}`),
    lineBytes(''),
  ]

  /** Si hay varias fuentes de items, preferimos la más rica (con precio/cantidad). */
  const items = pickBestItemsSource(order)
  let wroteItemsSection = false
  const itemTotals: number[] = []
  if (Array.isArray(items)) {
    wroteItemsSection = true
    parts.push(lineBytes('--- Items ---'))
    for (const it of items) {
      const parsed = parseTicketItem(it, menuPriceMap)
      parts.push(lineBytes(parsed.line))
      if (parsed.total != null) itemTotals.push(parsed.total)
    }
  } else if (items != null) {
    wroteItemsSection = true
    const parsed = parseTicketItem(items, menuPriceMap)
    parts.push(lineBytes(parsed.line))
    if (parsed.total != null) itemTotals.push(parsed.total)
  }
  const deliveryFee = deliveryFeeForTicket(order)
  if (deliveryFee != null) {
    wroteItemsSection = true
    parts.push(lineBytes(`- Delivery ${money(deliveryFee)}`))
    itemTotals.push(deliveryFee)
  }
  const orderTotal = orderTotalForTicket(order, itemTotals)
  if (orderTotal != null) {
    parts.push(lineBytes(`Total: ${money(orderTotal)}`))
  }

  const ctxLines: string[] = []
  pushFulfillmentContextLines(order, (line) => {
    ctxLines.push(line)
  })
  if (wroteItemsSection && ctxLines.length > 0) {
    parts.push(lineBytes(''))
  }
  for (const line of ctxLines) {
    parts.push(lineBytes(line))
  }

  parts.push(lineBytes(''))
  parts.push(centeredLineBytes(TICKET_THANK_YOU_BANNER))
  const scheduledAlert = scheduledDeliveryAlertLine(order)
  if (scheduledAlert) {
    parts.push(lineBytes(''))
    parts.push(prominentCenteredAlertBytes(scheduledAlert))
  }
  parts.push(new Uint8Array([0x0a, 0x0a]))
  parts.push(cutPartial())

  return concat(parts)
}

/**
 * Versión legible del ticket para UI/debug.
 */
export function buildOrderTicketPreview(order: OrderRow, menuPriceMap?: MenuPriceMap): string {
  const lines: string[] = []
  lines.push(TICKET_RESTAURANT_BANNER)
  lines.push('')
  lines.push(`Creado: ${formatCreatedForTicket(String(order.created_at ?? ''))}`)
  lines.push('')

  const items = pickBestItemsSource(order)
  let wroteItemsSection = false
  const itemTotals: number[] = []
  if (Array.isArray(items)) {
    wroteItemsSection = true
    lines.push('--- Items ---')
    for (const it of items) {
      const parsed = parseTicketItem(it, menuPriceMap)
      lines.push(parsed.line)
      if (parsed.total != null) itemTotals.push(parsed.total)
    }
  } else if (items != null) {
    wroteItemsSection = true
    const parsed = parseTicketItem(items, menuPriceMap)
    lines.push(parsed.line)
    if (parsed.total != null) itemTotals.push(parsed.total)
  }
  const deliveryFee = deliveryFeeForTicket(order)
  if (deliveryFee != null) {
    wroteItemsSection = true
    lines.push(`- Delivery ${money(deliveryFee)}`)
    itemTotals.push(deliveryFee)
  }
  const orderTotal = orderTotalForTicket(order, itemTotals)
  if (orderTotal != null) {
    lines.push(`Total: ${money(orderTotal)}`)
  }

  const ctxLines: string[] = []
  pushFulfillmentContextLines(order, (line) => ctxLines.push(line))
  if (wroteItemsSection && ctxLines.length > 0) {
    lines.push('')
  }
  for (const line of ctxLines) {
    lines.push(line)
  }

  lines.push('')
  lines.push(TICKET_THANK_YOU_BANNER)
  const previewScheduled = scheduledDeliveryAlertLine(order)
  if (previewScheduled) {
    lines.push('')
    lines.push(previewScheduled)
  }
  lines.push('')
  lines.push('[Corte parcial]')
  return lines.join('\n')
}

export async function printOrderEscPos(
  host: string,
  port: number,
  order: OrderRow,
  menuPriceMap?: MenuPriceMap,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    console.warn('[ThermalPrinter] Solo disponible en Android; ticket omitido.', order.id)
    return
  }
  const bytes = buildOrderTicketBytes(order, menuPriceMap)
  await ThermalPrinter.sendBytes({
    host,
    port,
    data: uint8ToBase64(bytes),
  })
}

/** Banner boletería (ASCII vía toThermalAscii). */
export const BOLETERIA_BANNER = 'BOLETERIA MENDOZA DEL OESTE'

export const BOLETERIA_TIMEZONE = 'America/Argentina/Mendoza'

const PAYMENT_LABEL_BOLETERIA: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  TRANSFERENCIA: 'Transferencia',
  MERCADO_PAGO: 'Mercado Pago',
  CORTESIA: 'Cortesia',
}

/** Formatea startsAt / createdAt en zona Mendoza. */
export function formatBoleteriaWhen(iso: string): string {
  const raw = String(iso ?? '').trim()
  if (!raw) return ''
  const t = Date.parse(raw)
  if (Number.isNaN(t)) {
    return raw.includes('T') ? raw.slice(0, 19).replace('T', ' ') : raw
  }
  const d = new Date(t)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOLETERIA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const map: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value
  }
  const y = map.year
  const mo = map.month
  const da = map.day
  const h = map.hour
  const mi = map.minute
  if (!y || !mo || !da) return raw.includes('T') ? raw.slice(0, 19).replace('T', ' ') : raw
  return `${y}-${mo}-${da} ${h ?? '00'}:${mi ?? '00'}`
}

function formatArsCents(cents: number): string {
  if (!Number.isFinite(cents) || cents === 0) return 'Cortesia'
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * QR ESC/POS (Epson GS ( k) con el shortCode — no el token HMAC de la web.
 */
function qrCodeBytes(payload: string): Uint8Array {
  const data = encoder().encode(toThermalAscii(payload).slice(0, 200))
  const storeLen = data.length + 3
  const pL = storeLen & 0xff
  const pH = (storeLen >> 8) & 0xff
  return concat([
    new Uint8Array([ESC, 0x61, 0x01]),
    new Uint8Array([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    new Uint8Array([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06]),
    new Uint8Array([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),
    new Uint8Array([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),
    data,
    new Uint8Array([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
    new Uint8Array([ESC, 0x61, 0x00]),
  ])
}

/** ESC/POS de una entrada de boletería (1 fila Ticket = 1 corte). */
export function buildBoleteriaTicketBytes(ticket: BoleteriaTicketRow): Uint8Array {
  const when = formatBoleteriaWhen(ticket.startsAt)
  const payment =
    PAYMENT_LABEL_BOLETERIA[ticket.paymentMethod] ??
    (ticket.paymentMethod || '—')
  const price = formatArsCents(ticket.priceCents)
  const parts: Uint8Array[] = [
    headerBytes(BOLETERIA_BANNER),
    lineBytes(''),
    centeredLineBytes(ticket.eventTitle || 'Evento'),
    lineBytes(`Fecha: ${when}`),
    lineBytes(`Lugar: ${ticket.venue || '—'}`),
    lineBytes(''),
    lineBytes(`Tipo: ${ticket.ticketTypeName || '—'}`),
    lineBytes(`Precio: ${price}`),
    lineBytes(`Pago: ${payment}`),
    lineBytes(''),
    lineBytes(`Titular: ${ticket.buyerName || '—'}`),
  ]
  if (ticket.buyerPhone) {
    parts.push(lineBytes(`Tel: ${ticket.buyerPhone}`))
  }
  parts.push(lineBytes(''))
  parts.push(prominentCenteredAlertBytes(ticket.shortCode || '——'))
  parts.push(lineBytes(''))
  if (ticket.shortCode) {
    parts.push(qrCodeBytes(ticket.shortCode))
    parts.push(lineBytes(''))
  }
  parts.push(centeredLineBytes('Presentar en puerta'))
  parts.push(new Uint8Array([0x0a, 0x0a]))
  parts.push(cutPartial())
  return concat(parts)
}

export function buildBoleteriaTicketPreview(ticket: BoleteriaTicketRow): string {
  const when = formatBoleteriaWhen(ticket.startsAt)
  const payment =
    PAYMENT_LABEL_BOLETERIA[ticket.paymentMethod] ??
    (ticket.paymentMethod || '—')
  const lines = [
    BOLETERIA_BANNER,
    '',
    ticket.eventTitle || 'Evento',
    `Fecha: ${when}`,
    `Lugar: ${ticket.venue || '—'}`,
    '',
    `Tipo: ${ticket.ticketTypeName || '—'}`,
    `Precio: ${formatArsCents(ticket.priceCents)}`,
    `Pago: ${payment}`,
    '',
    `Titular: ${ticket.buyerName || '—'}`,
  ]
  if (ticket.buyerPhone) lines.push(`Tel: ${ticket.buyerPhone}`)
  lines.push('')
  lines.push(`>>> ${ticket.shortCode || '——'} <<<`)
  lines.push('')
  lines.push(`[QR: ${ticket.shortCode || '—'}]`)
  lines.push('')
  lines.push('Presentar en puerta')
  lines.push('')
  lines.push('[Corte parcial]')
  return lines.join('\n')
}

export async function printBoleteriaTicketEscPos(
  host: string,
  port: number,
  ticket: BoleteriaTicketRow,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    console.warn('[ThermalPrinter] Solo disponible en Android; boleto omitido.', ticket.id)
    return
  }
  const bytes = buildBoleteriaTicketBytes(ticket)
  await ThermalPrinter.sendBytes({
    host,
    port,
    data: uint8ToBase64(bytes),
  })
}
