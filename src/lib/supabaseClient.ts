import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AppSettings } from './settingsStorage'

let cached: { key: string; client: SupabaseClient } | null = null

export function getSupabase(settings: AppSettings): SupabaseClient {
  const key = `${settings.supabaseUrl}|${settings.supabaseAnonKey}`
  if (cached?.key === key) return cached.client

  const client = createClient(settings.supabaseUrl, settings.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  cached = { key, client }
  return client
}
