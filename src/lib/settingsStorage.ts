const KEYS = {
  supabaseUrl: 'resto_kds_supabase_url',
  supabaseAnon: 'resto_kds_supabase_anon',
  restaurantId: 'resto_kds_restaurant_id',
  printerHost: 'resto_kds_printer_host',
  printerPort: 'resto_kds_printer_port',
  pollMs: 'resto_kds_poll_ms',
  workMode: 'resto_kds_work_mode',
} as const

/** restaurant = pedidos cocina; boleteria = entradas fisico=true (otro proyecto Supabase). */
export type WorkMode = 'restaurant' | 'boleteria'

export type AppSettings = {
  supabaseUrl: string
  supabaseAnonKey: string
  restaurantId: string
  printerHost: string
  printerPort: number
  pollIntervalMs: number
  workMode: WorkMode
}

function parseWorkMode(raw: string | null): WorkMode {
  return raw === 'boleteria' ? 'boleteria' : 'restaurant'
}

export type SettingsTemplate = {
  id: string
  name: string
  settings: AppSettings
  updatedAt: number
}

const TEMPLATES_KEY = 'resto_kds_settings_templates'

/** Mismo orden de magnitud que RestoBot `DELIVERY_NOTIFIER_POLL_MS` (default 10_000). */
const DEFAULT_POLL_MS = 10_000

export function loadSettings(): AppSettings {
  return {
    supabaseUrl: localStorage.getItem(KEYS.supabaseUrl) ?? '',
    supabaseAnonKey: localStorage.getItem(KEYS.supabaseAnon) ?? '',
    restaurantId: localStorage.getItem(KEYS.restaurantId) ?? '',
    printerHost: localStorage.getItem(KEYS.printerHost) ?? '',
    printerPort: Number(localStorage.getItem(KEYS.printerPort) ?? '9100') || 9100,
    pollIntervalMs: Number(localStorage.getItem(KEYS.pollMs) ?? String(DEFAULT_POLL_MS)) || DEFAULT_POLL_MS,
    workMode: parseWorkMode(localStorage.getItem(KEYS.workMode)),
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEYS.supabaseUrl, s.supabaseUrl.trim())
  localStorage.setItem(KEYS.supabaseAnon, s.supabaseAnonKey.trim())
  localStorage.setItem(KEYS.restaurantId, s.restaurantId.trim())
  localStorage.setItem(KEYS.printerHost, s.printerHost.trim())
  localStorage.setItem(KEYS.printerPort, String(s.printerPort))
  localStorage.setItem(KEYS.pollMs, String(s.pollIntervalMs))
  localStorage.setItem(KEYS.workMode, s.workMode === 'boleteria' ? 'boleteria' : 'restaurant')
}

function newTemplateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function normalizeSettings(partial: Partial<AppSettings> | AppSettings): AppSettings {
  return {
    supabaseUrl: String(partial.supabaseUrl ?? ''),
    supabaseAnonKey: String(partial.supabaseAnonKey ?? ''),
    restaurantId: String(partial.restaurantId ?? ''),
    printerHost: String(partial.printerHost ?? ''),
    printerPort: Number(partial.printerPort ?? 9100) || 9100,
    pollIntervalMs: Number(partial.pollIntervalMs ?? DEFAULT_POLL_MS) || DEFAULT_POLL_MS,
    workMode: parseWorkMode(
      typeof partial.workMode === 'string' ? partial.workMode : null,
    ),
  }
}

export function loadSettingsTemplates(): SettingsTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SettingsTemplate[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t) => t && typeof t.name === 'string' && typeof t.settings === 'object')
      .map((t) => ({ ...t, settings: normalizeSettings(t.settings) }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function saveTemplates(templates: SettingsTemplate[]): void {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates))
}

export function upsertSettingsTemplate(name: string, settings: AppSettings): SettingsTemplate {
  const cleanName = name.trim()
  const now = Date.now()
  const templates = loadSettingsTemplates()
  const existing = templates.find((t) => t.name.toLowerCase() === cleanName.toLowerCase())

  if (existing) {
    const updated: SettingsTemplate = { ...existing, name: cleanName, settings, updatedAt: now }
    const next = templates.map((t) => (t.id === existing.id ? updated : t))
    saveTemplates(next)
    return updated
  }

  const created: SettingsTemplate = {
    id: newTemplateId(),
    name: cleanName,
    settings,
    updatedAt: now,
  }
  saveTemplates([created, ...templates])
  return created
}

export function deleteSettingsTemplate(templateId: string): void {
  const templates = loadSettingsTemplates()
  saveTemplates(templates.filter((t) => t.id !== templateId))
}

/** Mínimo para consultar Supabase (impresora opcional). Boletería no usa restaurant_id. */
export function settingsAreComplete(s: AppSettings): boolean {
  const base =
    s.supabaseUrl.trim().length > 0 && s.supabaseAnonKey.trim().length > 0
  if (s.workMode === 'boleteria') return base
  return base && s.restaurantId.trim().length > 0
}

/** Hay IP/host de impresora configurado (para imprimir tickets ESC/POS). */
export function printerConfigured(s: AppSettings): boolean {
  return s.printerHost.trim().length > 0 && s.printerPort > 0
}
