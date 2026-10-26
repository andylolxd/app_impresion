import type { SupabaseClient } from '@supabase/supabase-js'
import type { MenuPriceMap } from './thermalPrinter'

const CACHE_TTL_MS = 60_000

let cache: { key: string; at: number; map: MenuPriceMap } | null = null

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

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value.replace(',', '.'))
    if (Number.isFinite(n)) return n
  }
  return null
}

function pickFirstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function pickFirstNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const n = asNumber(row[k])
    if (n != null) return n
  }
  return null
}

export async function getMenuItemsPriceMap(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<MenuPriceMap> {
  const key = `${restaurantId}`
  const now = Date.now()
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.map

  const { data, error } = await supabase
    .from('menu_items')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .limit(2000)

  if (error) return {}

  const map: MenuPriceMap = {}
  for (const item of data ?? []) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const name = pickFirstString(row, [
      'name',
      'title',
      'product_name',
      'item',
      'product',
      'nombre',
      'menu_item_name',
      'display_name',
    ])
    const price = pickFirstNumber(row, [
      'price',
      'unit_price',
      'amount',
      'unitPrice',
      'precio',
      'price_bs',
      'final_price',
      'sale_price',
    ])
    if (!name || price == null) continue
    const norm = normalizeItemName(name)
    if (!norm) continue
    map[norm] = price

    const noParen = normalizeItemName(name.replace(/\([^)]*\)/g, ' '))
    if (noParen) map[noParen] = price
  }

  cache = { key, at: now, map }
  return map
}

