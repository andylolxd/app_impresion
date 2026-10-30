package com.restokds.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground service: consulta Supabase (REST) e imprime por TCP sin depender del WebView.
 */
class OrderPollingService : Service() {

    /** Hilo propio: el Main Looper se congela/aplaza en segundo plano y el poll no corría hasta volver al frente. */
    private var pollThread: HandlerThread? = null
    private var pollHandler: Handler? = null
    private val running = AtomicBoolean(false)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        HandlerThread("resto-order-poller").apply {
            start()
            pollThread = this
            pollHandler = Handler(looper)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            val type =
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        if (running.compareAndSet(false, true)) {
            scheduleNext(0L)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        pollHandler?.removeCallbacksAndMessages(null)
        pollThread?.quitSafely()
        pollThread = null
        pollHandler = null
        super.onDestroy()
    }

    private fun scheduleNext(delayMs: Long) {
        val h = pollHandler ?: return
        h.postDelayed({
            if (!running.get()) return@postDelayed
            try {
                runPollPass()
            } catch (e: Exception) {
                Log.e(TAG, "poll error", e)
            } finally {
                val next = readPollIntervalMs()
                scheduleNext(next)
            }
        }, delayMs)
    }

    private fun readPollIntervalMs(): Long {
        val cfg = loadConfig() ?: return DEFAULT_POLL_MS
        val raw = cfg.opt("pollIntervalMs") ?: return DEFAULT_POLL_MS
        val v =
            when (raw) {
                is Number -> raw.toLong()
                else -> DEFAULT_POLL_MS
            }
        return maxOf(1500L, if (v <= 0) DEFAULT_POLL_MS else v)
    }

    private fun loadConfig(): JSONObject? {
        val prefs = getSharedPreferences(RestoPollerPrefs.PREFS_NAME, MODE_PRIVATE)
        val raw = prefs.getString(RestoPollerPrefs.CONFIG_KEY, null) ?: return null
        return try {
            JSONObject(raw)
        } catch (_: Exception) {
            null
        }
    }

    private fun runPollPass() {
        val cfg = loadConfig()
        if (cfg == null) {
            Log.w(TAG, "sin config; esperando configure()")
            return
        }
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        val wakeLock =
            pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$TAG:poll").apply {
                setReferenceCounted(false)
                acquire(120_000)
            }
        try {
            runPollPassLocked(cfg)
        } finally {
            try {
                if (wakeLock.isHeld) wakeLock.release()
            } catch (_: Exception) {
            }
        }
    }

    private fun runPollPassLocked(cfg: JSONObject) {
        val workMode = cfg.optString("workMode", "restaurant").trim()
        if (workMode == "boleteria") {
            runBoleteriaPollPass(cfg)
        } else {
            runRestaurantPollPass(cfg)
        }
    }

    private fun runRestaurantPollPass(cfg: JSONObject) {
        val baseUrl = cfg.optString("supabaseUrl", "").trimEnd('/')
        val anon = cfg.optString("supabaseAnonKey", "")
        val restaurantId = cfg.optString("restaurantId", "")
        val printerHost = cfg.optString("printerHost", "").trim()
        val printerPort = cfg.optInt("printerPort", 9100)
        val pollMs = readPollIntervalMs()
        if (baseUrl.isEmpty() || anon.isEmpty() || restaurantId.isEmpty() || printerHost.isEmpty()) {
            Log.w(
                TAG,
                "poll omitido: config incompleta (url=${baseUrl.isNotEmpty()}, anon=${anon.isNotEmpty()}, " +
                    "restaurant=${restaurantId.isNotEmpty()}, printer=${printerHost.isNotEmpty()})",
            )
            return
        }

        logNetworkDiag()
        val t0 = System.currentTimeMillis()
        Log.i(TAG, "poll ciclo inicio intervalMs=$pollMs restaurant=${shortId(restaurantId)}")

        val fromIso = utcIsoMillis(System.currentTimeMillis() - WINDOW_MS)
        val encId = URLEncoder.encode(restaurantId, StandardCharsets.UTF_8.name())
        val encFrom = URLEncoder.encode(fromIso, StandardCharsets.UTF_8.name())
        val menuPrices = fetchMenuPrices(baseUrl, anon, encId)
        val urlStr =
            "$baseUrl/rest/v1/orders?restaurant_id=eq.$encId&status=in.(confirmed)&created_at=gte.$encFrom&select=*&order=created_at.desc&limit=200"

        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("apikey", anon)
            setRequestProperty("Authorization", "Bearer $anon")
            setRequestProperty("Accept", "application/json")
            connectTimeout = 25_000
            readTimeout = 25_000
        }

        val code = conn.responseCode
        val body =
            try {
                val stream =
                    if (code in 200..299) conn.inputStream else conn.errorStream ?: conn.inputStream
                BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).readText()
            } finally {
                conn.disconnect()
            }

        val httpMs = System.currentTimeMillis() - t0
        if (code !in 200..299) {
            Log.e(TAG, "Supabase HTTP $code (${httpMs}ms) body=${body.take(500)}")
            return
        }

        val rows =
            try {
                JSONArray(body)
            } catch (e: Exception) {
                Log.e(TAG, "JSON inválido (${httpMs}ms): ${body.take(200)}", e)
                return
            }
        val cutoff = System.currentTimeMillis() - WINDOW_MS
        val filtered = mutableListOf<JSONObject>()
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val st = row.optString("status", "").lowercase().trim()
            if (st != "confirmed") continue
            val created = row.optString("created_at", "")
            val ts = parseCreatedMs(created) ?: continue
            if (ts < cutoff) continue
            filtered.add(row)
        }
        filtered.sortBy { parseCreatedMs(it.optString("created_at", "")) ?: 0L }

        Log.i(
            TAG,
            "Supabase OK (${httpMs}ms) rows=${rows.length()} filteredConfirmed=${filtered.size} ventana15min",
        )

        val prefs = getSharedPreferences(RestoPollerPrefs.PREFS_NAME, MODE_PRIVATE)
        val printed = loadPrintedIds(prefs)
        var printedThisPass = 0

        for (row in filtered) {
            val id = row.optString("id", "")
            if (id.isEmpty()) continue
            if (printed.contains(id)) continue
            val bytes = EscPosOrderTicket.build(row, menuPrices)
            try {
                Log.i(
                    TAG,
                    "TCP envío id=${shortId(id)} → $printerHost:$printerPort bytes=${bytes.size}",
                )
                sendTcp(printerHost, printerPort, bytes)
                printed.add(id)
                savePrintedIds(prefs, printed)
                printedThisPass++
                Log.i(TAG, "impreso nativo id=${shortId(id)} (${printedThisPass} este ciclo)")
            } catch (e: Exception) {
                Log.e(TAG, "TCP fallo para ${shortId(id)} tras reintentos: ${e.message}", e)
                break
            }
        }

        if (printedThisPass == 0 && filtered.any { !printed.contains(it.optString("id", "")) }) {
            Log.w(TAG, "fin ciclo: hay pedidos sin imprimir pero TCP falló (ver errores arriba)")
        }
        Log.i(TAG, "poll ciclo fin (${System.currentTimeMillis() - t0}ms total)")
    }

    /** Entradas boletería: Ticket.fisico=true → imprimir → fisico=false + printCount++. */
    private fun runBoleteriaPollPass(cfg: JSONObject) {
        val baseUrl = cfg.optString("supabaseUrl", "").trimEnd('/')
        val anon = cfg.optString("supabaseAnonKey", "")
        val printerHost = cfg.optString("printerHost", "").trim()
        val printerPort = cfg.optInt("printerPort", 9100)
        val pollMs = readPollIntervalMs()
        if (baseUrl.isEmpty() || anon.isEmpty() || printerHost.isEmpty()) {
            Log.w(
                TAG,
                "poll boleteria omitido: config incompleta (url=${baseUrl.isNotEmpty()}, anon=${anon.isNotEmpty()}, " +
                    "printer=${printerHost.isNotEmpty()})",
            )
            return
        }

        logNetworkDiag()
        val t0 = System.currentTimeMillis()
        Log.i(TAG, "poll boleteria inicio intervalMs=$pollMs")

        val select =
            URLEncoder.encode(
                "id,shortCode,status,fisico,printCount,createdAt,orderId,eventId,ticketTypeId,note,validUntil",
                StandardCharsets.UTF_8.name(),
            )
        val urlStr =
            "$baseUrl/rest/v1/Ticket?fisico=eq.true&status=eq.VALIDO&select=$select&order=createdAt.asc&limit=100"

        val body = httpGet(anon, urlStr) ?: return
        val tickets =
            try {
                JSONArray(body)
            } catch (e: Exception) {
                Log.e(TAG, "boleteria JSON inválido: ${body.take(200)}", e)
                return
            }

        val prefs = getSharedPreferences(RestoPollerPrefs.PREFS_NAME, MODE_PRIVATE)
        val printedKey = RestoPollerPrefs.PRINTED_BOLETERIA_IDS_KEY
        val printed = loadPrintedIds(prefs, printedKey)
        val queued = mutableSetOf<String>()
        for (i in 0 until tickets.length()) {
            tickets.optJSONObject(i)?.optString("id", "")?.takeIf { it.isNotEmpty() }?.let { queued.add(it) }
        }
        // Lo que ya no está en cola quedó confirmado (fisico=false); si vuelve a la cola, se reimprime.
        if (printed.retainAll(queued)) savePrintedIds(prefs, printed, printedKey)

        if (tickets.length() == 0) {
            Log.i(TAG, "boleteria: sin tickets fisico (${System.currentTimeMillis() - t0}ms)")
            return
        }

        val orderIds = linkedSetOf<String>()
        val eventIds = linkedSetOf<String>()
        val typeIds = linkedSetOf<String>()
        for (i in 0 until tickets.length()) {
            val t = tickets.optJSONObject(i) ?: continue
            t.optString("orderId", "").takeIf { it.isNotEmpty() }?.let { orderIds.add(it) }
            t.optString("eventId", "").takeIf { it.isNotEmpty() }?.let { eventIds.add(it) }
            t.optString("ticketTypeId", "").takeIf { it.isNotEmpty() }?.let { typeIds.add(it) }
        }

        val orders = fetchByIds(baseUrl, anon, "Order", orderIds, "id,buyerName,buyerEmail,buyerPhone,paymentMethod,origin")
        val events = fetchByIds(baseUrl, anon, "Event", eventIds, "id,title,startsAt,venue")
        val types = fetchByIds(baseUrl, anon, "TicketType", typeIds, "id,name,priceCents,entryUntil")
        val numbers = fetchTicketNumbers(baseUrl, anon, queued)
        if (numbers == null) {
            Log.e(TAG, "boleteria: sin números de boleto (ticket_print_numbers); se reintenta en el próximo ciclo")
            return
        }

        var printedThisPass = 0

        for (i in 0 until tickets.length()) {
            val t = tickets.optJSONObject(i) ?: continue
            val id = t.optString("id", "")
            if (id.isEmpty()) continue
            if (printed.contains(id)) {
                // Ya impreso pero la marca fisico=false falló: solo se reintenta la marca, nunca se reimprime.
                if (ackBoleteriaPrinted(baseUrl, anon, id, t.optInt("printCount", 0) + 1)) {
                    Log.i(TAG, "ack reintentado OK id=${shortId(id)}")
                } else {
                    Log.e(TAG, "ack reintento falló id=${shortId(id)} (¿falta permiso UPDATE en Ticket?)")
                }
                continue
            }

            val order = orders[t.optString("orderId", "")] ?: continue
            val event = events[t.optString("eventId", "")] ?: continue
            val type = types[t.optString("ticketTypeId", "")] ?: continue

            val enriched =
                JSONObject().apply {
                    put("id", id)
                    put("shortCode", t.optString("shortCode", ""))
                    put("printCount", t.optInt("printCount", 0))
                    put("buyerName", order.optString("buyerName", ""))
                    put("buyerPhone", order.optString("buyerPhone", ""))
                    put("paymentMethod", order.optString("paymentMethod", ""))
                    put("eventTitle", event.optString("title", ""))
                    put("startsAt", event.optString("startsAt", ""))
                    put("venue", event.optString("venue", ""))
                    put("ticketTypeName", type.optString("name", ""))
                    put("priceCents", type.optInt("priceCents", 0))
                    put("note", if (t.isNull("note")) "" else t.optString("note", ""))
                    // El límite propio de la entrada manda; si no tiene, vale el del tipo.
                    val validUntil = if (t.isNull("validUntil")) "" else t.optString("validUntil", "")
                    val entryUntil = if (type.isNull("entryUntil")) "" else type.optString("entryUntil", "")
                    put("entryLimit", validUntil.ifBlank { entryUntil })
                    numbers[id]?.let { (n, cap) ->
                        put("typeNumber", n)
                        put("typeCapacity", cap)
                    }
                }

            val bytes = EscPosBoleteriaTicket.build(enriched)
            try {
                Log.i(
                    TAG,
                    "TCP boleto ${t.optString("shortCode", shortId(id))} → $printerHost:$printerPort bytes=${bytes.size}",
                )
                sendTcp(printerHost, printerPort, bytes)
                printed.add(id)
                savePrintedIds(prefs, printed, printedKey)
                printedThisPass++
                val nextCount = enriched.optInt("printCount", 0) + 1
                if (ackBoleteriaPrinted(baseUrl, anon, id, nextCount)) {
                    Log.i(TAG, "boleto OK id=${shortId(id)} (${printedThisPass} este ciclo)")
                } else {
                    Log.e(TAG, "impreso pero ack fisico falló id=${shortId(id)}; no se reimprime, se reintenta el ack")
                }
            } catch (e: Exception) {
                Log.e(TAG, "TCP boleto falló ${shortId(id)}: ${e.message}", e)
                break
            }
        }

        Log.i(TAG, "poll boleteria fin (${System.currentTimeMillis() - t0}ms) impresos=$printedThisPass")
    }

    private fun httpGet(anon: String, urlStr: String): String? {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("apikey", anon)
            setRequestProperty("Authorization", "Bearer $anon")
            setRequestProperty("Accept", "application/json")
            connectTimeout = 25_000
            readTimeout = 25_000
        }
        val code = conn.responseCode
        val body =
            try {
                val stream =
                    if (code in 200..299) conn.inputStream else conn.errorStream ?: conn.inputStream
                BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).readText()
            } finally {
                conn.disconnect()
            }
        if (code !in 200..299) {
            Log.e(TAG, "HTTP GET $code url=${urlStr.take(120)} body=${body.take(400)}")
            return null
        }
        return body
    }

    private fun fetchByIds(
        baseUrl: String,
        anon: String,
        table: String,
        ids: Set<String>,
        select: String,
    ): Map<String, JSONObject> {
        if (ids.isEmpty()) return emptyMap()
        val encSelect = URLEncoder.encode(select, StandardCharsets.UTF_8.name())
        val inList = ids.joinToString(",")
        val encIn = URLEncoder.encode("($inList)", StandardCharsets.UTF_8.name())
        val url = "$baseUrl/rest/v1/$table?id=in.$encIn&select=$encSelect"
        val body = httpGet(anon, url) ?: return emptyMap()
        val arr =
            try {
                JSONArray(body)
            } catch (_: Exception) {
                return emptyMap()
            }
        val map = mutableMapOf<String, JSONObject>()
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            val id = row.optString("id", "")
            if (id.isNotEmpty()) map[id] = row
        }
        return map
    }

    /** id → (orden dentro del tipo de entrada, capacidad del tipo); null si la llamada falla. */
    private fun fetchTicketNumbers(
        baseUrl: String,
        anon: String,
        ids: Set<String>,
    ): Map<String, Pair<Long, Int>>? {
        if (ids.isEmpty()) return emptyMap()
        val payload = JSONObject().put("ticket_ids", JSONArray(ids.toList()))
        val conn = (URL("$baseUrl/rest/v1/rpc/ticket_print_numbers").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("apikey", anon)
            setRequestProperty("Authorization", "Bearer $anon")
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            connectTimeout = 20_000
            readTimeout = 20_000
        }
        return try {
            conn.outputStream.use { it.write(payload.toString().toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream ?: conn.inputStream
            val body = BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { it.readText() }
            if (code !in 200..299) {
                Log.e(TAG, "ticket_print_numbers HTTP $code body=${body.take(300)}")
                return null
            }
            val arr = JSONArray(body)
            val out = mutableMapOf<String, Pair<Long, Int>>()
            for (i in 0 until arr.length()) {
                val row = arr.optJSONObject(i) ?: continue
                val id = row.optString("id", "")
                if (id.isNotEmpty()) out[id] = row.optLong("typeNumber", 0) to row.optInt("typeCapacity", 0)
            }
            out
        } catch (e: Exception) {
            Log.e(TAG, "ticket_print_numbers error: ${e.message}", e)
            null
        } finally {
            conn.disconnect()
        }
    }

    private fun ackBoleteriaPrinted(
        baseUrl: String,
        anon: String,
        ticketId: String,
        nextPrintCount: Int,
    ): Boolean {
        val encId = URLEncoder.encode(ticketId, StandardCharsets.UTF_8.name())
        // select=id: anon solo puede leer algunas columnas de Ticket; devolver * da "permission denied".
        val urlStr = "$baseUrl/rest/v1/Ticket?id=eq.$encId&fisico=eq.true&select=id"
        val payload = JSONObject().apply {
            put("fisico", false)
            put("printCount", nextPrintCount)
        }
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "PATCH"
            doOutput = true
            setRequestProperty("apikey", anon)
            setRequestProperty("Authorization", "Bearer $anon")
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Prefer", "return=representation")
            setRequestProperty("Accept", "application/json")
            connectTimeout = 20_000
            readTimeout = 20_000
        }
        return try {
            conn.outputStream.use { it.write(payload.toString().toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            val body =
                try {
                    val stream =
                        if (code in 200..299) conn.inputStream else conn.errorStream ?: conn.inputStream
                    BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).readText()
                } finally {
                    conn.disconnect()
                }
            if (code !in 200..299) {
                Log.e(TAG, "ack PATCH HTTP $code body=${body.take(300)}")
                return false
            }
            val arr =
                try {
                    JSONArray(body)
                } catch (_: Exception) {
                    return false
                }
            arr.length() > 0
        } catch (e: Exception) {
            Log.e(TAG, "ack PATCH error: ${e.message}", e)
            false
        }
    }

    private fun shortId(id: String): String {
        if (id.length <= 12) return id
        return id.take(8) + "…"
    }

    private fun normalizeItemName(raw: String): String =
        java.text.Normalizer.normalize(raw, java.text.Normalizer.Form.NFD)
            .replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
            .trim()
            .lowercase(Locale.ROOT)
            .replace(Regex("\\([^)]*\\)"), " ")
            .replace(Regex("[^a-z0-9\\s]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()

    private fun asDouble(value: Any?): Double? = when (value) {
        is Number -> value.toDouble()
        is String -> value.replace(',', '.').toDoubleOrNull()
        else -> null
    }

    private fun pickFirstString(obj: JSONObject, keys: List<String>): String? {
        for (k in keys) {
            val s = obj.optString(k, "").trim()
            if (s.isNotEmpty()) return s
        }
        return null
    }

    private fun pickFirstDouble(obj: JSONObject, keys: List<String>): Double? {
        for (k in keys) {
            val n = asDouble(obj.opt(k))
            if (n != null) return n
        }
        return null
    }

    private fun fetchMenuPrices(baseUrl: String, anon: String, encRestaurantId: String): Map<String, Double> {
        val urlStr = "$baseUrl/rest/v1/menu_items?restaurant_id=eq.$encRestaurantId&select=*&limit=2000"
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("apikey", anon)
            setRequestProperty("Authorization", "Bearer $anon")
            setRequestProperty("Accept", "application/json")
            connectTimeout = 20_000
            readTimeout = 20_000
        }
        val code = conn.responseCode
        val body =
            try {
                val stream =
                    if (code in 200..299) conn.inputStream else conn.errorStream ?: conn.inputStream
                BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).readText()
            } finally {
                conn.disconnect()
            }
        if (code !in 200..299) {
            Log.w(TAG, "menu_items HTTP $code; precio fallback desactivado")
            return emptyMap()
        }
        val arr =
            try {
                JSONArray(body)
            } catch (_: Exception) {
                return emptyMap()
            }
        val map = mutableMapOf<String, Double>()
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            val name = pickFirstString(
                row,
                listOf("name", "title", "product_name", "item", "product", "nombre", "menu_item_name", "display_name"),
            ) ?: continue
            val price = pickFirstDouble(
                row,
                listOf("price", "unit_price", "amount", "unitPrice", "precio", "price_bs", "final_price", "sale_price"),
            ) ?: continue
            val norm = normalizeItemName(name)
            if (norm.isNotEmpty()) map[norm] = price
            val noParen = normalizeItemName(name.replace(Regex("\\([^)]*\\)"), " "))
            if (noParen.isNotEmpty()) map[noParen] = price
        }
        return map
    }

    /** Ayuda a distinguir HTTP caído vs solo LAN/impre apagada en soporte. */
    private fun logNetworkDiag() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: run {
                Log.d(TAG, "diag red: ConnectivityManager null")
                return
            }
            val n = cm.activeNetwork
            if (n == null) {
                Log.w(TAG, "diag red: sin activeNetwork (WiFi/datos apagados o OEM)")
                return
            }
            val caps = cm.getNetworkCapabilities(n)
            if (caps == null) {
                Log.w(TAG, "diag red: sin NetworkCapabilities")
                return
            }
            val wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            val cell = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
            val ethernet = caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
            val internet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            Log.d(
                TAG,
                "diag red: wifi=$wifi cellular=$cell ethernet=$ethernet internet=$internet validated=$validated",
            )
        } catch (e: Exception) {
            Log.d(TAG, "diag red error: ${e.message}")
        }
    }


    private fun utcIsoMillis(ms: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date(ms))
    }

    private fun parseCreatedMs(iso: String): Long? {
        if (iso.isEmpty()) return null
        val patterns =
            arrayOf(
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                "yyyy-MM-dd'T'HH:mm:ss'Z'",
                "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
                "yyyy-MM-dd'T'HH:mm:ssXXX",
            )
        for (p in patterns) {
            try {
                val fmt = SimpleDateFormat(p, Locale.US)
                if (p.endsWith("'Z'")) fmt.timeZone = TimeZone.getTimeZone("UTC")
                return fmt.parse(iso)?.time
            } catch (_: Exception) {
                continue
            }
        }
        return null
    }

    private fun loadPrintedIds(
        prefs: android.content.SharedPreferences,
        key: String = RestoPollerPrefs.PRINTED_IDS_KEY,
    ): MutableSet<String> {
        val raw = prefs.getString(key, "[]") ?: "[]"
        return try {
            val arr = JSONArray(raw)
            val s = mutableSetOf<String>()
            for (i in 0 until arr.length()) {
                s.add(arr.getString(i))
            }
            s
        } catch (_: Exception) {
            mutableSetOf()
        }
    }

    private fun savePrintedIds(
        prefs: android.content.SharedPreferences,
        ids: Set<String>,
        key: String = RestoPollerPrefs.PRINTED_IDS_KEY,
    ) {
        val arr = JSONArray()
        for (id in ids) arr.put(id)
        prefs.edit().putString(key, arr.toString()).apply()
    }

    private fun sendTcp(host: String, port: Int, bytes: ByteArray) {
        var wifiLock: WifiManager.WifiLock? = null
        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            if (wm != null) {
                @Suppress("DEPRECATION")
                val mode =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    } else {
                        WifiManager.WIFI_MODE_FULL_HIGH_PERF
                    }
                wifiLock = wm.createWifiLock(mode, "resto-receptor:native-print")
                wifiLock.setReferenceCounted(false)
                wifiLock.acquire()
            }
            val maxAttempts = 3
            var last: Exception? = null
            for (attempt in 1..maxAttempts) {
                try {
                    Socket().use { socket ->
                        socket.tcpNoDelay = true
                        socket.soTimeout = 20_000
                        socket.connect(InetSocketAddress(host, port), 20_000)
                        socket.getOutputStream().use { out ->
                            out.write(bytes)
                            out.flush()
                        }
                    }
                    if (attempt > 1) {
                        Log.i(TAG, "TCP ok tras reintento $attempt/$maxAttempts → $host:$port")
                    }
                    return
                } catch (e: Exception) {
                    last = e
                    Log.w(
                        TAG,
                        "TCP intento $attempt/$maxAttempts falló (${e.javaClass.simpleName}): ${e.message}",
                    )
                    if (attempt < maxAttempts) {
                        try {
                            Thread.sleep((450L * attempt).coerceAtMost(1800L))
                        } catch (_: InterruptedException) {
                            Thread.currentThread().interrupt()
                            throw e
                        }
                    }
                }
            }
            throw last ?: IllegalStateException("TCP sin causa")
        } finally {
            try {
                if (wifiLock?.isHeld == true) wifiLock.release()
            } catch (_: Exception) {
            }
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(
            CHANNEL_ID,
            "bole-kds — receptor",
            NotificationManager.IMPORTANCE_LOW,
        )
        ch.description = "Mantiene consultas e impresión en segundo plano"
        nm.createNotificationChannel(ch)
    }

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val contentIntent = PendingIntent.getActivity(this, 0, launchIntent, piFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("bole-kds activo")
            .setContentText("Consultando cola e imprimiendo en segundo plano")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build()
    }

    companion object {
        private const val TAG = "OrderPollingService"
        private const val CHANNEL_ID = "resto-receptor-native-poller"
        private const val NOTIFICATION_ID = 574543956
        private const val DEFAULT_POLL_MS = 10_000L
        private const val WINDOW_MS = 15 * 60 * 1000L

        fun start(ctx: Context) {
            val i = Intent(ctx, OrderPollingService::class.java)
            ContextCompat.startForegroundService(ctx, i)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, OrderPollingService::class.java))
        }
    }
}
