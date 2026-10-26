/**
 * Reglas alineadas al repo RestoBot (referencia local del usuario):
 * - Estados: `dashboard/src/lib/format.js` → ORDER_STATUS_LABELS / ORDER_STATUS_COLORS
 * - Consulta lista pedidos: `dashboard/src/screens/AdminApp.jsx` → loadOrders + eq(restaurant_id)
 * - Intervalo tipo poller bot: `order_delivery_notifier.js` → DELIVERY_NOTIFIER_POLL_MS (default 10_000)
 *
 * Cocina / ticket: solo pedidos en estados donde el local suele preparar o gestionar el pedido
 * activo (no cotizaciones intermedias tipo “esperando fee” o “cliente debe confirmar total”).
 */

/** Todos los status usados en el dashboard RestoBot (etiquetas en format.js). */
export const RESTOBOT_ALL_STATUSES = [
  'awaiting_payment_method',
  'awaiting_delivery_fee',
  'delivery_fee_set',
  'awaiting_delivery_total_confirm',
  'delivery_denied',
  'delivery_denial_notify_failed',
  'notify_failed',
  'pending_payment',
  'pending',
  'confirmed',
  'delivered',
  'cancelled',
] as const

/**
 * Pedidos que entran en la cola de cocina / KDS: mismo criterio que “pedido ya tomado
 * por el local” sin estar cerrado. Excluye flujos previos (fee, confirmación cliente MP/WhatsApp).
 */
export const RESTOBOT_KITCHEN_ACTIVE_STATUSES = [
  /**
   * Requisito actual del usuario: mostrar SOLO pedidos confirmados
   * en actividad y en pedidos activos.
   */
  'confirmed',
] as const

/** Estados en los que aún no corresponde ticket de cocina (reglas de negocio RestoBot). */
export const RESTOBOT_PRE_KITCHEN_STATUSES = [
  'awaiting_payment_method',
  'awaiting_delivery_fee',
  'delivery_fee_set',
  'awaiting_delivery_total_confirm',
] as const

/** Cerrados / no preparación. */
export const RESTOBOT_TERMINAL_STATUSES = [
  'delivered',
  'cancelled',
  'delivery_denied',
  'delivery_denial_notify_failed',
] as const

const KITCHEN_ALLOWED = new Set<string>(
  RESTOBOT_KITCHEN_ACTIVE_STATUSES as unknown as string[],
)

export type OrderRow = Record<string, unknown> & {
  id?: string
  restaurant_id?: string
  status?: string
  created_at?: string
  updated_at?: string
  items?: unknown
  notes?: string
  /** Observación del mozo sobre el pedido (columna `observacion` en Supabase). */
  observacion?: string | null
  /** Dirección de envío; en Supabase puede ser texto u objeto según esquema */
  address?: unknown
  /** p. ej. `delivery`, `delivery_mozo`, `local` */
  fulfillment_type?: string
  /**
   * ISO 8601 / timestamptz desde Supabase: horario acordado para envío programado.
   * Si está ausente o null, el pedido no se trata como programado en el ticket.
   */
  scheduled_delivery_at?: string | null
  payment_method?: string
  payment_status?: string
  total_amount?: number
  total_price?: number
  final_total_amount?: number
}

export function filterKitchenOrders(rows: OrderRow[]): OrderRow[] {
  return rows.filter((r) => {
    const st = typeof r.status === 'string' ? r.status.toLowerCase().trim() : ''
    if (!st) return false
    return KITCHEN_ALLOWED.has(st)
  })
}
