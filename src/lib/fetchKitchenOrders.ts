import type { SupabaseClient } from '@supabase/supabase-js'
import { filterKitchenOrders, RESTOBOT_KITCHEN_ACTIVE_STATUSES, type OrderRow } from './ordersQuery'

const CONFIRMED_WINDOW_MS = 15 * 60 * 1000

function createdAtIsInsideWindow(order: OrderRow, fromMs: number): boolean {
  const createdAt = String(order.created_at ?? '')
  if (!createdAt) return false
  const createdMs = Date.parse(createdAt)
  if (Number.isNaN(createdMs)) return false
  return createdMs >= fromMs
}

/**
 * Igual que AdminApp.loadOrders en RestoBot: `orders` + `restaurant_id` + orden por `created_at` DESC,
 * acotado por status de cocina en servidor (.in) y refinado en cliente por si hay filas legacy.
 * Además, para evitar ráfagas al reiniciar, limita a pedidos `confirmed` creados en los últimos 15 min.
 *
 * Ver: `automatizacion_bot-main/dashboard/src/screens/AdminApp.jsx` (loadOrders, applyOrderFilters).
 */
export async function fetchKitchenOrders(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<{ rows: OrderRow[]; error: Error | null }> {
  const fromIso = new Date(Date.now() - CONFIRMED_WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .in('status', [...RESTOBOT_KITCHEN_ACTIVE_STATUSES])
    .gte('created_at', fromIso)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    return { rows: [], error: new Error(error.message) }
  }

  const minCreatedAtMs = Date.now() - CONFIRMED_WINDOW_MS
  const rows = filterKitchenOrders((data ?? []) as OrderRow[])
    .filter((row) => createdAtIsInsideWindow(row, minCreatedAtMs))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))

  return { rows, error: null }
}
