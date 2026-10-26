import { useEffect, useMemo, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import './App.css'
import {
  deleteSettingsTemplate,
  loadSettings,
  loadSettingsTemplates,
  printerConfigured,
  saveSettings,
  settingsAreComplete,
  upsertSettingsTemplate,
  type AppSettings,
  type SettingsTemplate,
  type WorkMode,
} from './lib/settingsStorage'
import { useOrdersPolling } from './hooks/useOrdersPolling'
import { useBoleteriaPolling } from './hooks/useBoleteriaPolling'
import { NativeOrderPoller } from './lib/nativeOrderPoller'
import {
  buildBoleteriaTicketPreview,
  buildOrderTicketPreview,
} from './lib/thermalPrinter'

/** Pide al sistema abrir pantallas de “sin restricciones de batería” y autoinicio en segundo plano (OEM). */
function openAndroidBackgroundPermissionsScreens(): boolean {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return false
  const bg = window.cordova?.plugins?.backgroundMode
  if (!bg) return false
  bg.disableBatteryOptimizations?.()
  bg.openAppStartSettings?.(false)
  return true
}

function enableAndroidBackgroundMode(): void {
  if (!Capacitor.isNativePlatform()) return
  const bg = window.cordova?.plugins?.backgroundMode
  if (!bg) return
  const BG_SETUP_KEY = 'resto_receptor_bg_setup_done'
  bg.setDefaults({
    title: 'bole-kds activo',
    text: 'Escuchando cola de impresión en segundo plano',
    resume: true,
    silent: false,
  })
  bg.on?.('activate', () => {
    // Mantiene ejecución de timers/red del WebView al ir a segundo plano.
    bg.disableWebViewOptimizations?.()
  })
  // Reduce congelamientos agresivos en Android OEM (MIUI/ColorOS/etc).
  if (!localStorage.getItem(BG_SETUP_KEY)) {
    openAndroidBackgroundPermissionsScreens()
    bg.overrideBackButton?.()
    localStorage.setItem(BG_SETUP_KEY, '1')
  }
  bg.enable()
}

function SettingsForm({
  initial,
  onPersist,
  onCancel,
}: {
  initial: AppSettings
  onPersist: (s: AppSettings, mode: 'stay' | 'leave') => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<AppSettings>(initial)
  const [justSaved, setJustSaved] = useState(false)
  const [templates, setTemplates] = useState<SettingsTemplate[]>(() => loadSettingsTemplates())
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    setDraft(initial)
  }, [initial])

  useEffect(() => {
    setTemplates(loadSettingsTemplates())
  }, [initial])

  useEffect(() => {
    setTemplateName('')
    setSaveError('')
  }, [initial])

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initial),
    [draft, initial],
  )

  function persist(mode: 'stay' | 'leave') {
    const cleanName = templateName.trim()
    if (!cleanName) {
      setSaveError('Escribí un nombre de plantilla antes de guardar.')
      return
    }
    const ok = window.confirm(
      `¿Guardar esta configuración en la plantilla "${cleanName}"?`,
    )
    if (!ok) return

    saveSettings(draft)
    const savedTemplate = upsertSettingsTemplate(cleanName, draft)
    setTemplates(loadSettingsTemplates())
    setSelectedTemplateId(savedTemplate.id)
    setTemplateName(savedTemplate.name)
    setSaveError('')
    onPersist(draft, mode)
    if (mode === 'stay') {
      setJustSaved(true)
      window.setTimeout(() => setJustSaved(false), 3500)
    }
  }

  return (
    <div className="panel settings-panel">
      <h2>Configuración</h2>
      <p className="settings-hint muted">
        Los datos se guardan solo en este dispositivo (localStorage). Usá los botones de abajo para
        guardar.
      </p>

      {justSaved ? (
        <div className="save-banner" role="status">
          Guardado en este dispositivo ✓
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          persist('stay')
        }}
      >
        <label>
          Modo de trabajo
          <select
            value={draft.workMode}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                workMode: (e.target.value === 'boleteria' ? 'boleteria' : 'restaurant') as WorkMode,
              }))
            }
          >
            <option value="restaurant">Restaurante (pedidos cocina)</option>
            <option value="boleteria">Boletería (entradas fisico)</option>
          </select>
        </label>

        <p className="settings-hint muted">
          {draft.workMode === 'boleteria'
            ? 'Usá la URL y anon key del proyecto Supabase de boletería (tablas Ticket / Order / Event). No hace falta restaurant_id.'
            : 'Usá el proyecto Supabase del restaurante (tabla orders) y el restaurant_id del local.'}
        </p>

        <label>
          Supabase URL
          <input
            type="url"
            value={draft.supabaseUrl}
            onChange={(e) => setDraft((d) => ({ ...d, supabaseUrl: e.target.value }))}
            placeholder="https://xxxx.supabase.co"
            autoComplete="off"
          />
        </label>

        <label>
          Anon key
          <input
            type="password"
            value={draft.supabaseAnonKey}
            onChange={(e) => setDraft((d) => ({ ...d, supabaseAnonKey: e.target.value }))}
            placeholder="eyJ..."
            autoComplete="off"
          />
        </label>

        {draft.workMode === 'restaurant' ? (
          <label>
            restaurant_id
            <input
              value={draft.restaurantId}
              onChange={(e) => setDraft((d) => ({ ...d, restaurantId: e.target.value }))}
              placeholder="UUID del restaurante"
              autoComplete="off"
            />
          </label>
        ) : null}

        <label>
          Impresora — IP o hostname (opcional para solo ver pedidos)
          <input
            value={draft.printerHost}
            onChange={(e) => setDraft((d) => ({ ...d, printerHost: e.target.value }))}
            placeholder="Vacío = solo Supabase, sin imprimir"
            autoComplete="off"
          />
        </label>

        <label>
          Puerto TCP (opcional si no imprimís)
          <input
            type="number"
            min={1}
            max={65535}
            value={draft.printerPort}
            onChange={(e) =>
              setDraft((d) => ({ ...d, printerPort: Number(e.target.value) || 9100 }))
            }
          />
        </label>

        <label>
          Intervalo polling (ms)
          <input
            type="number"
            min={1500}
            step={500}
            value={draft.pollIntervalMs}
            onChange={(e) =>
              setDraft((d) => ({ ...d, pollIntervalMs: Number(e.target.value) || 10_000 }))
            }
          />
        </label>

        {Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' ? (
          <div className="settings-oem-block">
            <p className="settings-oem-title">Recepción con pantalla apagada</p>
            <p className="settings-hint muted settings-oem-hint">
              En algunos equipos hay que permitir autoinicio y uso sin restricciones de batería. Podés
              volver a abrir esos menús cuando quieras.
            </p>
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => {
                if (!openAndroidBackgroundPermissionsScreens()) {
                  window.alert(
                    'No se pudo abrir el asistente. Cerrá la app por completo y volvé a entrar, o actualizá desde una build reciente.',
                  )
                }
              }}
            >
              Abrir ajustes de segundo plano y batería
            </button>
          </div>
        ) : null}

        <div className="template-box">
          <p className="template-title">Plantillas guardadas</p>
          <label>
            Nombre de plantilla para guardar
            <input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Ej: Local principal"
              autoComplete="off"
            />
          </label>
          {saveError ? <p className="ticket-error">{saveError}</p> : null}
          <div className="template-controls">
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
            >
              <option value="">Seleccionar plantilla…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => {
                const t = templates.find((x) => x.id === selectedTemplateId)
                if (!t) return
                setDraft(t.settings)
                setTemplateName(t.name)
                setSaveError('')
              }}
              disabled={!selectedTemplateId}
            >
              Cargar
            </button>
            <button
              type="button"
              className="ghost small-btn danger-outline"
              onClick={() => {
                const t = templates.find((x) => x.id === selectedTemplateId)
                if (!t) return
                const okDelete = window.confirm(`¿Eliminar plantilla "${t.name}"?`)
                if (!okDelete) return
                deleteSettingsTemplate(t.id)
                setTemplates(loadSettingsTemplates())
                setSelectedTemplateId('')
              }}
              disabled={!selectedTemplateId}
            >
              Eliminar
            </button>
          </div>
        </div>

        {dirty ? (
          <p className="dirty-hint" role="status">
            Tenés cambios sin guardar
          </p>
        ) : null}

        <div className="actions settings-actions">
          <button type="submit" className="primary">
            Guardar configuración
          </button>
          <button
            type="button"
            className="primary outline"
            onClick={() => persist('leave')}
          >
            Guardar y volver al inicio
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              if (dirty) {
                const ok = window.confirm(
                  '¿Salir sin guardar? Los cambios en pantalla se perderán.',
                )
                if (!ok) return
              }
              onCancel()
            }}
          >
            Volver sin guardar
          </button>
        </div>
      </form>
    </div>
  )
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [screen, setScreen] = useState<'home' | 'settings'>('home')
  const [settingsFormKey, setSettingsFormKey] = useState(0)
  const [collapsedPrinted, setCollapsedPrinted] = useState(false)
  const [collapsedPreview, setCollapsedPreview] = useState(false)
  const [pollingEnabled, setPollingEnabled] = useState(true)

  useEffect(() => {
    const onReady = () => enableAndroidBackgroundMode()
    document.addEventListener('deviceready', onReady, false)
    // En algunos builds Capacitor ya está listo cuando monta React.
    enableAndroidBackgroundMode()
    return () => document.removeEventListener('deviceready', onReady, false)
  }, [])

  const isBoleteria = settings.workMode === 'boleteria'
  const complete = settingsAreComplete(settings)
  const pollingActive = complete && pollingEnabled
  const hasPrinter = printerConfigured(settings)
  const delegateNativeBackgroundPrint =
    Capacitor.isNativePlatform() && pollingActive && complete && hasPrinter

  const restaurantPoll = useOrdersPolling(
    settings,
    pollingActive && !isBoleteria,
    delegateNativeBackgroundPrint && !isBoleteria,
  )
  const boleteriaPoll = useBoleteriaPolling(
    settings,
    pollingActive && isBoleteria,
    delegateNativeBackgroundPrint && isBoleteria,
  )

  const {
    state,
    clearPrintedMemory,
    clearActivity,
    clearPrintedLogs,
    reprintLog,
    resetPollingCounters,
    mergePrintedFromNative,
  } = isBoleteria ? boleteriaPoll : restaurantPoll

  /**
   * Poller nativo (foreground service): impresión TCP fuera del WebView.
   * Importante: NO usar cleanup que haga stop() al cambiar solo settings — eso mataba el servicio en segundo plano.
   */
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    if (!delegateNativeBackgroundPrint) {
      void NativeOrderPoller.stop().catch(() => {})
      return
    }
    const printedKey = isBoleteria
      ? 'resto_kds_printed_boleteria_ids'
      : 'resto_kds_printed_order_ids'
    const printedIdsJson = localStorage.getItem(printedKey) ?? '[]'
    let cancelled = false
    void (async () => {
      try {
        await NativeOrderPoller.configure({
          supabaseUrl: settings.supabaseUrl.trim(),
          supabaseAnonKey: settings.supabaseAnonKey.trim(),
          restaurantId: settings.restaurantId.trim(),
          printerHost: settings.printerHost.trim(),
          printerPort: settings.printerPort,
          pollIntervalMs: Math.round(settings.pollIntervalMs),
          printedIdsJson,
          workMode: settings.workMode,
        })
        if (!cancelled) await NativeOrderPoller.start()
      } catch (e) {
        console.warn('[NativeOrderPoller]', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    delegateNativeBackgroundPrint,
    isBoleteria,
    settings.supabaseUrl,
    settings.supabaseAnonKey,
    settings.restaurantId,
    settings.printerHost,
    settings.printerPort,
    settings.pollIntervalMs,
    settings.workMode,
  ])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const onVis = () => {
      if (document.visibilityState === 'visible') void mergePrintedFromNative()
    }
    document.addEventListener('visibilitychange', onVis)
    void mergePrintedFromNative()
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [mergePrintedFromNative])

  return (
    <div className="app">
      <header className="topbar">
        <h1>bole-kds</h1>
        <div className="topbar-actions">
          <button
            type="button"
            className={pollingActive ? 'primary small-btn' : 'ghost small-btn'}
            onClick={() =>
              setPollingEnabled((v) => {
                const next = !v
                if (next) resetPollingCounters()
                return next
              })
            }
          >
            {pollingActive ? '⏸ Detener' : '▶ Iniciar'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              if (screen === 'settings') {
                setScreen('home')
                return
              }
              setSettingsFormKey((k) => k + 1)
              setScreen('settings')
            }}
          >
            {screen === 'settings' ? 'Inicio' : 'Ajustes'}
          </button>
        </div>
      </header>

      {screen === 'settings' ? (
        <SettingsForm
          key={settingsFormKey}
          initial={settings}
          onPersist={(s, mode) => {
            setSettings(s)
            if (mode === 'leave') setScreen('home')
          }}
          onCancel={() => setScreen('home')}
        />
      ) : (
        <main className="main">
          {!complete ? (
            <div className="panel warn">
              <p>
                {isBoleteria ? (
                  <>
                    Completá <strong>Supabase URL</strong> y <strong>anon key</strong> del proyecto
                    de boletería. La impresora es opcional hasta que quieras imprimir.
                  </>
                ) : (
                  <>
                    Completá <strong>Supabase URL</strong>, <strong>anon key</strong> y{' '}
                    <strong>restaurant_id</strong>. La impresora es opcional hasta que quieras
                    tickets.
                  </>
                )}
              </p>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setSettingsFormKey((k) => k + 1)
                  setScreen('settings')
                }}
              >
                Ir a ajustes
              </button>
            </div>
          ) : !pollingEnabled ? (
            <div className="panel info-banner">
              Polling detenido manualmente. Tocá <strong>▶ Iniciar</strong> para volver a consultar
              la cola.
            </div>
          ) : (
            <>
              <div className="panel info-banner" role="status">
                Modo: <strong>{isBoleteria ? 'Boletería' : 'Restaurante'}</strong>
                {isBoleteria
                  ? ' — imprime filas Ticket con fisico=true y luego las baja a false.'
                  : ' — imprime pedidos confirmed de cocina.'}
              </div>

              {!hasPrinter ? (
                <div className="panel info-banner" role="status">
                  Modo solo lectura: no hay IP de impresora. Vas a ver la cola y actividad; para
                  imprimir cargá IP y puerto en Ajustes.
                </div>
              ) : null}

              <section className="panel stats">
                <div>
                  <span className="muted">Último poll</span>
                  <strong>
                    {state.lastPollAt
                      ? new Date(state.lastPollAt).toLocaleTimeString()
                      : '—'}
                  </strong>
                </div>
                <div>
                  <span className="muted">Ciclos</span>
                  <strong>{state.pollCount}</strong>
                </div>
                <div>
                  <span className="muted">{isBoleteria ? 'Boletos (fisico)' : 'Pedidos (cocina)'}</span>
                  <strong>{state.rows.length}</strong>
                </div>
              </section>

              {state.lastError ? (
                <div className="panel error" role="alert">
                  {state.lastError}
                </div>
              ) : null}

              {state.activity.length > 0 ? (
                <section className="panel activity-panel">
                  <div className="activity-header">
                    <h2>{isBoleteria ? 'Actividad (boletos)' : 'Actividad (pedidos)'}</h2>
                    <button type="button" className="ghost small-btn" onClick={clearActivity}>
                      Limpiar lista
                    </button>
                  </div>
                  <p className="muted activity-sub">
                    {isBoleteria
                      ? 'Avisos cuando entra un boleto a la cola fisico o sale tras imprimir.'
                      : 'Avisos cuando entra un pedido nuevo, cambia el estado o sale de la cola de cocina.'}
                  </p>
                  <ul className="activity-list">
                    {state.activity.map((a) => (
                      <li key={a.id}>
                        <time dateTime={new Date(a.at).toISOString()}>
                          {new Date(a.at).toLocaleTimeString()}
                        </time>
                        <span className="activity-text">{a.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {isBoleteria ? (
                <>
                  {boleteriaPoll.state.printedLogs.length > 0 ? (
                    <section className="panel printed-panel">
                      <div className="activity-header">
                        <h2>Boletos impresos</h2>
                        <div className="section-actions">
                          <button
                            type="button"
                            className="ghost small-btn"
                            onClick={() => setCollapsedPrinted((v) => !v)}
                          >
                            {collapsedPrinted ? 'Expandir' : 'Contraer'}
                          </button>
                          <button
                            type="button"
                            className="ghost small-btn"
                            onClick={clearPrintedLogs}
                          >
                            Limpiar lista
                          </button>
                        </div>
                      </div>
                      {!collapsedPrinted ? (
                        <ul className="printed-list">
                          {boleteriaPoll.state.printedLogs.map((t) => (
                            <li key={t.id}>
                              <div className="printed-head">
                                <time dateTime={new Date(t.at).toISOString()}>
                                  {new Date(t.at).toLocaleTimeString()}
                                </time>
                                <span
                                  className={
                                    t.status === 'printed'
                                      ? 'ok'
                                      : t.status === 'simulated'
                                        ? 'sim'
                                        : 'bad'
                                  }
                                >
                                  {t.status === 'printed'
                                    ? 'Enviado'
                                    : t.status === 'simulated'
                                      ? 'Simulado'
                                      : 'Falló'}
                                </span>
                                <span className="ticket-id">{t.shortCode || t.ticketId}</span>
                              </div>
                              {t.error ? <p className="ticket-error">{t.error}</p> : null}
                              <div className="ticket-actions">
                                <button
                                  type="button"
                                  className="ghost small-btn"
                                  onClick={() => {
                                    void reprintLog(t.id)
                                  }}
                                >
                                  Reimprimir
                                </button>
                              </div>
                              <details>
                                <summary>Ver boleto</summary>
                                <pre className="ticket-preview">{t.preview}</pre>
                              </details>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">
                          Sección contraída ({boleteriaPoll.state.printedLogs.length} registro/s).
                        </p>
                      )}
                    </section>
                  ) : null}

                  {boleteriaPoll.state.rows.length > 0 ? (
                    <section className="panel printed-panel">
                      <div className="activity-header">
                        <h2>Vista previa boletos (fisico)</h2>
                        <div className="section-actions">
                          <button
                            type="button"
                            className="ghost small-btn"
                            onClick={() => setCollapsedPreview((v) => !v)}
                          >
                            {collapsedPreview ? 'Expandir' : 'Contraer'}
                          </button>
                        </div>
                      </div>
                      {!collapsedPreview ? (
                        <>
                          <p className="muted activity-sub">
                            Referencia del ESC/POS que se envía por cada entrada pendiente.
                          </p>
                          <ul className="printed-list">
                            {boleteriaPoll.state.rows.map((t) => (
                              <li key={t.id}>
                                <div className="printed-head">
                                  <span className="sim">Preview</span>
                                  <span className="ticket-id">{t.shortCode || t.id}</span>
                                </div>
                                <pre className="ticket-preview">
                                  {buildBoleteriaTicketPreview(t)}
                                </pre>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <p className="muted">
                          Sección contraída ({boleteriaPoll.state.rows.length} boleto/s).
                        </p>
                      )}
                    </section>
                  ) : null}

                  <section className="panel">
                    <h2>Cola de impresión (fisico=true)</h2>
                    {boleteriaPoll.state.rows.length === 0 ? (
                      <p className="muted">Sin boletos pendientes.</p>
                    ) : (
                      <ul className="order-list">
                        {boleteriaPoll.state.rows.map((t) => (
                          <li key={t.id}>
                            <span className="oid">{t.shortCode}</span>
                            <span className="ost">{t.ticketTypeName}</span>
                            <span className="odt">{t.eventTitle}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              ) : (
                <>
                  {restaurantPoll.state.printedLogs.length > 0 ? (
                    <section className="panel printed-panel">
                      <div className="activity-header">
                        <h2>Tickets impresos</h2>
                        <div className="section-actions">
                          <button
                            type="button"
                            className="ghost small-btn"
                            onClick={() => setCollapsedPrinted((v) => !v)}
                          >
                            {collapsedPrinted ? 'Expandir' : 'Contraer'}
                          </button>
                          <button
                            type="button"
                            className="ghost small-btn"
                            onClick={clearPrintedLogs}
                          >
                            Limpiar lista
                          </button>
                        </div>
                      </div>
                      {!collapsedPrinted ? (
                        <ul className="printed-list">
                          {restaurantPoll.state.printedLogs.map((t) => (
                            <li key={t.id}>
                              <div className="printed-head">
                                <time dateTime={new Date(t.at).toISOString()}>
                                  {new Date(t.at).toLocaleTimeString()}
                                </time>
                                <span
                                  className={
                                    t.status === 'printed'
                                      ? 'ok'
                                      : t.status === 'simulated'
                                        ? 'sim'
                                        : 'bad'
                                  }
                                >
                                  {t.status === 'printed'
                                    ? 'Enviado'
                                    : t.status === 'simulated'
                                      ? 'Simulado'
                                      : 'Falló'}
                                </span>
                                <span className="ticket-id">{t.orderId}</span>
                              </div>
                              {t.error ? <p className="ticket-error">{t.error}</p> : null}
                              <div className="ticket-actions">
                                <button
                                  type="button"
                                  className="ghost small-btn"
                                  onClick={() => {
                                    void reprintLog(t.id)
                                  }}
                                >
                                  Reimprimir
                                </button>
                              </div>
                              <details>
                                <summary>Ver ticket</summary>
                                <pre className="ticket-preview">{t.preview}</pre>
                              </details>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">
                          Sección contraída ({restaurantPoll.state.printedLogs.length} registro/s).
                        </p>
                      )}
                    </section>
                  ) : null}

                  {restaurantPoll.state.rows.length > 0 ? (
                    <section className="panel printed-panel">
                      <div className="activity-header">
                        <h2>Vista previa tickets (confirmados)</h2>
                        <div className="section-actions">
                          <button
                            type="button"
                            className="ghost small-btn"
                            onClick={() => setCollapsedPreview((v) => !v)}
                          >
                            {collapsedPreview ? 'Expandir' : 'Contraer'}
                          </button>
                        </div>
                      </div>
                      {!collapsedPreview ? (
                        <>
                          <p className="muted activity-sub">
                            Esta vista es solo referencia visual del ticket que se construye para
                            cada pedido actual.
                          </p>
                          <ul className="printed-list">
                            {restaurantPoll.state.rows.map((o, i) => (
                              <li key={String(o.id ?? `preview-${i}`)}>
                                <div className="printed-head">
                                  <span className="sim">Preview</span>
                                  <span className="ticket-id">{String(o.id ?? 'sin-id')}</span>
                                </div>
                                <pre className="ticket-preview">{buildOrderTicketPreview(o)}</pre>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <p className="muted">
                          Sección contraída ({restaurantPoll.state.rows.length} ticket/s).
                        </p>
                      )}
                    </section>
                  ) : null}

                  <section className="panel">
                    <h2>Pedidos activos</h2>
                    {restaurantPoll.state.rows.length === 0 ? (
                      <p className="muted">Sin pedidos en cola con los filtros actuales.</p>
                    ) : (
                      <ul className="order-list">
                        {restaurantPoll.state.rows.map((o, i) => (
                          <li key={String(o.id ?? `row-${i}`)}>
                            <span className="oid">{String(o.id ?? '—')}</span>
                            <span className="ost">{String(o.status ?? '')}</span>
                            <span className="odt">
                              {String(o.created_at ?? '').slice(0, 19)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              )}

              <div className="panel actions-row">
                <button type="button" className="ghost" onClick={clearPrintedMemory}>
                  Limpiar memoria de tickets impresos
                </button>
              </div>
            </>
          )}
        </main>
      )}
    </div>
  )
}
