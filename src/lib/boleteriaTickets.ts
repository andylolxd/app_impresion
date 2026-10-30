import type { SupabaseClient } from '@supabase/supabase-js'

/** Una fila por boleto listo para impresión térmica (fisico=true). */
export type BoleteriaTicketRow = {
  id: string
  shortCode: string
  status: string
  fisico: boolean
  printCount: number
  createdAt: string
  buyerName: string
  buyerEmail: string
  buyerPhone: string
  paymentMethod: string
  origin: string
  eventTitle: string
  startsAt: string
  venue: string
  ticketTypeName: string
  priceCents: number
  /** Orden de emisión dentro del tipo de entrada (función ticket_print_numbers). */
  typeNumber: number | null
  typeCapacity: number | null
  /** Observación de la entrada (ej. "Mesa 4"); vacío si no tiene. */
  note: string
  /** Hasta cuándo se puede ingresar: validUntil de la entrada o, si no tiene, entryUntil del tipo. */
  entryLimit: string
}

type TicketDbRow = {
  id: string
  shortCode: string
  status: string
  fisico: boolean
  printCount: number | null
  createdAt: string
  orderId: string
  eventId: string
  ticketTypeId: string
  note: string | null
  validUntil: string | null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v)
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

/**
 * Polla entradas pendientes de impresión física en el proyecto Supabase de boletería.
 * Tablas Prisma PascalCase: Ticket, Order, Event, TicketType.
 */
export async function fetchFisicoTickets(
  supabase: SupabaseClient,
): Promise<{ rows: BoleteriaTicketRow[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('Ticket')
    .select(
      'id, shortCode, status, fisico, printCount, createdAt, orderId, eventId, ticketTypeId, note, validUntil',
    )
    .eq('fisico', true)
    .eq('status', 'VALIDO')
    .order('createdAt', { ascending: true })
    .limit(100)

  if (error) {
    return { rows: [], error: new Error(error.message) }
  }

  const tickets = (data ?? []) as TicketDbRow[]
  if (tickets.length === 0) return { rows: [], error: null }

  const orderIds = [...new Set(tickets.map((t) => t.orderId).filter(Boolean))]
  const eventIds = [...new Set(tickets.map((t) => t.eventId).filter(Boolean))]
  const typeIds = [...new Set(tickets.map((t) => t.ticketTypeId).filter(Boolean))]

  const [ordersRes, eventsRes, typesRes, numbersRes] = await Promise.all([
    orderIds.length
      ? supabase
          .from('Order')
          .select('id, buyerName, buyerEmail, buyerPhone, paymentMethod, origin')
          .in('id', orderIds)
      : Promise.resolve({ data: [], error: null }),
    eventIds.length
      ? supabase.from('Event').select('id, title, startsAt, venue').in('id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    typeIds.length
      ? supabase.from('TicketType').select('id, name, priceCents, entryUntil').in('id', typeIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.rpc('ticket_print_numbers', { ticket_ids: tickets.map((t) => t.id) }),
  ])

  if (ordersRes.error) return { rows: [], error: new Error(ordersRes.error.message) }
  if (eventsRes.error) return { rows: [], error: new Error(eventsRes.error.message) }
  if (typesRes.error) return { rows: [], error: new Error(typesRes.error.message) }
  if (numbersRes.error) {
    return { rows: [], error: new Error(`Número de boleto: ${numbersRes.error.message}`) }
  }

  const numbers = new Map<string, { typeNumber: number; typeCapacity: number }>()
  for (const row of (numbersRes.data ?? []) as unknown[]) {
    const r = asRecord(row)
    if (r && typeof r.id === 'string') {
      numbers.set(r.id, { typeNumber: num(r.typeNumber), typeCapacity: num(r.typeCapacity) })
    }
  }

  const orders = new Map<string, Record<string, unknown>>()
  for (const row of ordersRes.data ?? []) {
    const r = asRecord(row)
    if (r && typeof r.id === 'string') orders.set(r.id, r)
  }
  const events = new Map<string, Record<string, unknown>>()
  for (const row of eventsRes.data ?? []) {
    const r = asRecord(row)
    if (r && typeof r.id === 'string') events.set(r.id, r)
  }
  const types = new Map<string, Record<string, unknown>>()
  for (const row of typesRes.data ?? []) {
    const r = asRecord(row)
    if (r && typeof r.id === 'string') types.set(r.id, r)
  }

  const rows: BoleteriaTicketRow[] = []
  for (const t of tickets) {
    const o = orders.get(t.orderId)
    const e = events.get(t.eventId)
    const tt = types.get(t.ticketTypeId)
    if (!o || !e || !tt) continue
    rows.push({
      id: t.id,
      shortCode: str(t.shortCode),
      status: str(t.status),
      fisico: Boolean(t.fisico),
      printCount: num(t.printCount, 0),
      createdAt: str(t.createdAt),
      buyerName: str(o.buyerName),
      buyerEmail: str(o.buyerEmail),
      buyerPhone: str(o.buyerPhone),
      paymentMethod: str(o.paymentMethod),
      origin: str(o.origin),
      eventTitle: str(e.title),
      startsAt: str(e.startsAt),
      venue: str(e.venue),
      ticketTypeName: str(tt.name),
      priceCents: num(tt.priceCents, 0),
      typeNumber: numbers.get(t.id)?.typeNumber ?? null,
      typeCapacity: numbers.get(t.id)?.typeCapacity ?? null,
      note: str(t.note).trim(),
      entryLimit: str(t.validUntil) || str(tt.entryUntil),
    })
  }

  return { rows, error: null }
}

/**
 * Tras imprimir: baja fisico y suma printCount (solo si sigue fisico=true).
 */
export async function ackTicketPrinted(
  supabase: SupabaseClient,
  ticket: Pick<BoleteriaTicketRow, 'id' | 'printCount'>,
): Promise<{ ok: boolean; error: Error | null }> {
  const nextCount = Math.max(0, ticket.printCount) + 1
  const { data, error } = await supabase
    .from('Ticket')
    .update({ fisico: false, printCount: nextCount })
    .eq('id', ticket.id)
    .eq('fisico', true)
    .select('id')

  if (error) return { ok: false, error: new Error(error.message) }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: new Error('No se actualizó ninguna fila: ya no estaba en cola o falta permiso UPDATE (RLS) en Ticket.'),
    }
  }
  return { ok: true, error: null }
}
