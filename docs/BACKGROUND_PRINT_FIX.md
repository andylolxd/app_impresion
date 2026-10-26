# Impresión TCP en segundo plano (poller nativo) — diagnóstico v1.2.3

## Verificación REST vs Web (`fetchKitchenOrders.ts`)

El servicio nativo replica la consulta relevante para este producto:

- Tabla `orders`, `select=*`, `restaurant_id=eq.<uuid>`, ventana `created_at >= now - 15 min`, `order=created_at.desc`, `limit=200`.
- Estados de cocina: el JS usa solo `confirmed` (`RESTOBOT_KITCHEN_ACTIVE_STATUSES`). El nativo filtra `status=in.(confirmed)` y vuelve a filtrar por `confirmed` en cliente.

Cabeceras alineadas con Supabase JS: `apikey`, `Authorization: Bearer <anon>`, `Accept: application/json`.

Si ves **401/403** en logcat, revisá RLS/políticas sobre `orders` para rol `anon` y que la URL/key coincidan con la app.

## Logcat — reproducir con pantalla apagada

Con el USB depuración y la app en modo delegación nativa (polling activo + impresora configurada):

```text
adb logcat -v time OrderPollingService:D NativeOrderPoller:D ThermalPrinterPlugin:D *:S
```

Para incluir fallos genéricos de red/hilo:

```text
adb logcat -v time | findstr /i "OrderPollingService NativeOrderPoller ThermalPrinter OkHttp HttpURLConnection SSL "
```

### Qué mirar por ciclo

| Log (tag `OrderPollingService`) | Significado |
|---------------------------------|-------------|
| `poll ciclo inicio intervalMs=…` | El `HandlerThread` ejecutó un ciclo con pantalla apagada si aparece sin abrir la app. |
| `diag red: wifi=… internet=… validated=…` | Si `internet=false` o sin `activeNetwork`, el fallo es conectividad antes de HTTP/TCP. |
| `Supabase HTTP …` distinto de 200 | Problema de URL, key o RLS; el cuerpo truncado ayuda. |
| `Supabase OK … rows=… filteredConfirmed=…` | HTTP bien; si `filteredConfirmed>0` y no hay `impreso nativo`, mirá líneas TCP. |
| `TCP intento … falló` | Reintento automático (3 intentos); hostname DNS, firewall, PC receptor apagado o puerto 9100. |
| `TCP ok tras reintento` | Latencia/retransmisión; la red estuvo inestable. |

Tags `NativeOrderPoller`: `configure`, `start`/`stop` confirman que Capacitor escribió prefs y arrancó el foreground service.

## Cambios en 1.2.3 (versionCode 6)

1. **Logs estructurados** en `OrderPollingService`: cada ciclo, tiempos HTTP, conteos y envíos TCP (sin volcar secrets).
2. **Reintentos TCP** (3 intentos, backoff corto) ante timeouts/resets intermitentes con pantalla apagada.
3. **`WifiLock`**: en API 29+ se usa `WIFI_MODE_FULL_LOW_LATENCY` en lugar del modo alto rendimiento deprecado (nativo + `ThermalPrinterPlugin`).
4. **Foreground service**: tipo `dataSync|connectedDevice` + permiso `FOREGROUND_SERVICE_CONNECTED_DEVICE`, y `startForeground` en API 34+ con la máscara combinada — orientado a comunicación con el receptor RAW en LAN.

## OEM / restricciones

Si los ciclos **no aparecen** en logcat con pantalla apagada pero sí al volver al frente, revisá optimización de batería para `com.restokds.app` (Xiaomi/MIUI, Samsung, Oppo/Vivo). El canal de notificación confirma el FGS; no garantiza que el OEM no retrase red en WiFi.

## Play Store / declaraciones

Si publicás en Play Console, `connectedDevice` puede exigir declaración del uso del tipo de foreground service según políticas vigentes; para distribución interna/APK directo suele bastar con permisos en el manifiesto.
