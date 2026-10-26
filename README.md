# Resto KDS

App **Vite + React + TypeScript + Capacitor (Android)** para consultar pedidos en Supabase (tabla `orders`) con polling y enviar tickets por **TCP ESC/POS** a una impresora térmica en red.

## Requisitos

- Node.js 18+ y npm
- Android Studio (SDK, herramientas de compilación) para generar el APK
- JDK compatible con el proyecto (Capacitor suele usar **Java 21** en este template)

## Desarrollo web

```bash
npm install
npm run dev
```

## Sincronizar con Android

Tras cambiar el front o `capacitor.config.ts`:

```bash
npm run cap:sync
```

Equivale a `npm run build && npx cap sync android`.

### Un solo comando (recomendado en Windows)

Desde la carpeta `resto-kds`, con **JDK** en el PATH o variable `JAVA_HOME` apuntando a tu JDK 21:

```bash
npm run android:apk
```

Hace `cap:sync` + `gradlew assembleDebug`. El APK queda en `android/app/build/outputs/apk/debug/app-debug.apk`.

## Generar el APK **debug**

1. Sincronizá los assets web en `android/`:

   ```bash
   npm run cap:sync
   ```

2. Abrí el proyecto Android en Android Studio (opcional pero cómodo):

   ```bash
   npm run android:open
   ```

3. Desde la raíz del repo, compilá el APK debug con Gradle:

   **Windows (PowerShell o CMD):**

   ```bash
   cd android
   .\gradlew.bat assembleDebug
   ```

   **macOS / Linux:**

   ```bash
   cd android
   ./gradlew assembleDebug
   ```

4. El APK queda en:

   `android/app/build/outputs/apk/debug/app-debug.apk`

Instalalo en el dispositivo con `adb install -r` o copiando el archivo.

## Plugin nativo (Kotlin)

El plugin `ThermalPrinter` vive en `android/app/src/main/java/com/restokds/app/ThermalPrinterPlugin.kt`. Expone el método `sendBytes` con `{ host, port, data }`, donde `data` es el payload **Base64** de bytes ESC/POS. Está registrado en `MainActivity`.

## Configuración en la app

En **Ajustes** elegís el **modo de trabajo** y cargás:

- URL de Supabase y anon key
- `restaurant_id` (solo modo Restaurante)
- IP/hostname y puerto TCP de la impresora (típicamente **9100**)

### Modo Boletería

Imprime entradas del proyecto Supabase de boletería (tablas Prisma `Ticket`, `Order`, `Event`, `TicketType`), no la tabla `orders` del restaurante.

1. En boletería el cajero marca **Físico** → `Ticket.fisico = true`
2. Esta app polla `fisico=true` y `status=VALIDO`
3. Imprime ESC/POS (banner, evento, shortCode grande + QR del shortCode)
4. Hace `UPDATE` → `fisico=false` y `printCount = printCount + 1`

La anon key necesita **SELECT** en esas tablas y **UPDATE** en `Ticket` (RLS/policies en Supabase).

### Paridad con el repo RestoBot

Si tenés el código en el escritorio, estos archivos son la fuente de verdad:

| Concepto | Ubicación en RestoBot |
|----------|------------------------|
| Estados de pedido (`pending`, `confirmed`, `delivery_fee_set`, …) | `automatizacion_bot-main/dashboard/src/lib/format.js` (`ORDER_STATUS_LABELS`) |
| Query lista de pedidos (`eq` `restaurant_id`, `order` `created_at`) | `automatizacion_bot-main/dashboard/src/screens/AdminApp.jsx` (`loadOrders`) |
| Tabla y columnas insertadas desde el bot | `automatizacion_bot-main/database.js` (`saveOrder`, `TABLES.orders`) |
| Intervalo de poller de respaldo (orden ~10s) | `automatizacion_bot-main/order_delivery_notifier.js` (`DELIVERY_NOTIFIER_POLL_MS`) |

En la app KDS, el polling usa **solo estados de cocina activa**: `pending`, `confirmed`, `pending_payment`, `notify_failed` (allowlist en `src/lib/ordersQuery.ts`). No incluye `awaiting_delivery_fee`, `delivery_fee_set` ni `awaiting_delivery_total_confirm`, que en RestoBot son previos a preparar. Podés cambiar esa lista si tu operación imprime antes.

El intervalo por defecto del formulario es **10_000 ms**, en la línea del notifier de envíos.

## Notas

- `vite.config.ts` usa `base: './'` para que los assets carguen bien dentro del WebView de Capacitor.
- En el navegador, la impresión nativa no corre; verás un aviso en consola. Probá en el APK o en emulador/dispositivo con red hacia la impresora.
