package com.restokds.app

import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Misma lógica que buildOrderTicketBytes en src/lib/thermalPrinter.ts
 */
object EscPosOrderTicket {

    private const val MAX_CONTEXT = 400
    private const val MAX_PAYMENT = 200
    private const val MONEY_DECIMALS = 2

    private const val TICKET_BANNER = "--- RESTAURANTE ILLIMANI ---"

    private const val TICKET_THANK_YOU_BANNER = "--- Gracias por su compra ---"

    private const val TICKET_SCHEDULED_DELIVERY_LABEL = "ENVIO PROGRAMADO"

    private const val TICKET_DELIVERY_SECTION_LABEL = "Envío a domicilio"

    /** Misma zona que `TICKET_TIMEZONE` en thermalPrinter.ts (Buenos Aires). */
    private val ticketZone: ZoneId = ZoneId.of("America/Argentina/Buenos_Aires")

    private val ticketTimeFmt: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ticketZone)

    private fun formatCreatedForTicket(iso: String): String {
        if (iso.isBlank()) return ""
        return try {
            val instant = Instant.parse(iso)
            ticketTimeFmt.format(instant)
        } catch (_: Exception) {
            iso.take(19).replace('T', ' ')
        }
    }

    private fun fulfillmentNorm(order: JSONObject): String =
        order.optString("fulfillment_type", "").lowercase().trim()

    private fun isDeliveryLike(order: JSONObject): Boolean =
        when (fulfillmentNorm(order)) {
            "delivery", "delivery_mozo" -> true
            else -> false
        }

    /** Igual que `parseMozoNameFromNotes` en thermalPrinter.ts */
    private fun parseMozoNameFromNotes(notes: String): String? {
        val m = Regex("""Mozo\s*:\s*(.+)$""", RegexOption.IGNORE_CASE).find(notes.trim()) ?: return null
        return m.groupValues[1].trim().takeIf { it.isNotEmpty() }
    }

    /** Igual que `scheduledDeliveryAlertLine` en thermalPrinter.ts */
    private fun scheduledDeliveryAlertLine(order: JSONObject): String? {
        if (!isDeliveryLike(order)) return null
        val raw = order.optString("scheduled_delivery_at", "").trim()
        if (raw.isEmpty()) return null
        return try {
            Instant.parse(raw)
            val scheduledAt = formatCreatedForTicket(raw)
            if (scheduledAt.isBlank()) null
            else ">>> ${TICKET_SCHEDULED_DELIVERY_LABEL}: $scheduledAt <<<"
        } catch (_: Exception) {
            null
        }
    }

    private fun money(value: Double): String = "$" + "%.${MONEY_DECIMALS}f".format(value)

    private fun formatQty(qty: Double): String =
        if (qty % 1.0 == 0.0) qty.toInt().toString() else "%.2f".format(qty)

    private fun asDouble(value: Any?): Double? = when (value) {
        is Number -> value.toDouble()
        is String -> value.replace(',', '.').toDoubleOrNull()
        else -> null
    }

    private fun pickFirstDouble(obj: JSONObject, keys: List<String>): Double? {
        for (k in keys) {
            if (obj.has(k) && !obj.isNull(k)) {
                val n = asDouble(obj.opt(k))
                if (n != null) return n
            }
        }
        return null
    }

    private fun pickFirstString(obj: JSONObject, keys: List<String>): String? {
        for (k in keys) {
            val s = obj.optString(k, "").trim()
            if (s.isNotEmpty()) return s
        }
        return null
    }

    private data class ParsedItem(val line: String, val total: Double?)

    private fun normalizeItemName(raw: String): String =
        Normalizer.normalize(raw, Normalizer.Form.NFD)
            .replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
            .lowercase(Locale.ROOT)
            .replace(Regex("\\([^)]*\\)"), " ")
            .replace(Regex("[^a-z0-9\\s]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()

    private fun lookupPriceByName(menuPrices: Map<String, Double>, rawName: String): Double? {
        val norm = normalizeItemName(rawName)
        if (norm.isNotEmpty() && menuPrices.containsKey(norm)) return menuPrices[norm]
        val noParen = normalizeItemName(rawName.replace(Regex("\\([^)]*\\)"), " "))
        if (noParen.isNotEmpty() && menuPrices.containsKey(noParen)) return menuPrices[noParen]
        return null
    }

    private fun itemHasPriceFields(v: Any?): Boolean {
        if (v !is JSONObject) return false
        val keys = listOf(
            "unit_price", "price", "amount", "unitPrice",
            "total", "total_price", "line_total", "subtotal"
        )
        return keys.any { k -> asDouble(v.opt(k)) != null }
    }

    private fun scoreItemsSource(source: Any?): Int = when (source) {
        is JSONArray -> {
            var hasObject = false
            var hasPricedObject = false
            for (i in 0 until source.length()) {
                val v = source.opt(i)
                if (v is JSONObject) hasObject = true
                if (itemHasPriceFields(v)) hasPricedObject = true
            }
            when {
                hasPricedObject -> 4
                hasObject -> 3
                source.length() > 0 -> 2
                else -> 0
            }
        }
        is JSONObject -> if (itemHasPriceFields(source)) 4 else 3
        is String -> if (source.trim().isNotEmpty()) 1 else 0
        null -> 0
        else -> 1
    }

    private fun pickBestItemsSource(order: JSONObject): Any? {
        val candidates = listOf(
            order.opt("order_items"),
            order.opt("line_items"),
            order.opt("items")
        )
        var best: Any? = null
        var bestScore = -1
        for (c in candidates) {
            val score = scoreItemsSource(c)
            if (score > bestScore) {
                best = c
                bestScore = score
            }
        }
        return best
    }

    private fun parseTicketItem(it: Any?, menuPrices: Map<String, Double>): ParsedItem {
        if (it is String) {
            val unitPrice = lookupPriceByName(menuPrices, it)
            val priceText = if (unitPrice != null) " ${money(unitPrice)}" else ""
            return ParsedItem("- $it$priceText", unitPrice)
        }
        if (it !is JSONObject) return ParsedItem("- ${it.toString()}", null)

        val name =
            pickFirstString(it, listOf("name", "title", "product_name", "product", "item"))
                ?: it.toString()
        val qty = pickFirstDouble(it, listOf("quantity", "qty", "count", "units"))
        val unitPrice =
            pickFirstDouble(it, listOf("unit_price", "price", "amount", "unitPrice"))
                ?: lookupPriceByName(menuPrices, name)
        val lineTotal =
            pickFirstDouble(it, listOf("total", "total_price", "line_total", "subtotal"))
                ?: if (qty != null && unitPrice != null) qty * unitPrice else null

        val qtyText = if (qty != null) " x${formatQty(qty)}" else ""
        val priceText =
            if (unitPrice != null && lineTotal != null) " ${money(unitPrice)}(${money(lineTotal)})"
            else if (lineTotal != null) " ${money(lineTotal)}"
            else if (unitPrice != null) " ${money(unitPrice)}"
            else ""
        return ParsedItem("- $name$qtyText$priceText", lineTotal)
    }

    private fun orderTotalForTicket(order: JSONObject, itemTotals: List<Double>): Double? {
        val direct =
            asDouble(order.opt("final_total_amount"))
                ?: asDouble(order.opt("total_amount"))
                ?: asDouble(order.opt("total_price"))
        if (direct != null) return direct
        if (itemTotals.isNotEmpty()) return itemTotals.sum()
        return null
    }

    private fun deliveryFeeForTicket(order: JSONObject): Double? {
        if (!isDeliveryLike(order)) return null
        val fee = asDouble(order.opt("delivery_fee")) ?: return null
        if (fee <= 0.0) return null
        return fee
    }

    private fun addressText(order: JSONObject): String? {
        if (!order.has("address") || order.isNull("address")) return null
        return when (val a = order["address"]) {
            is String -> a.trim().takeIf { it.isNotEmpty() }
            is JSONObject -> a.toString().takeIf { it.isNotBlank() }
            else -> a?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        }?.take(MAX_CONTEXT)
    }

    /** Misma regla que pushFulfillmentContextLines en thermalPrinter.ts */
    private fun appendFulfillmentContext(order: JSONObject, line: (String) -> Unit) {
        when (fulfillmentNorm(order)) {
            "delivery" -> {
                line(TICKET_DELIVERY_SECTION_LABEL)
                val addr = addressText(order)
                if (!addr.isNullOrBlank()) line("Direccion: $addr")
                val pm = order.optString("payment_method", "")
                if (pm.isNotBlank()) line("Pago: ${pm.take(MAX_PAYMENT)}")
            }
            "delivery_mozo" -> {
                line(TICKET_DELIVERY_SECTION_LABEL)
                val addr = addressText(order)
                if (!addr.isNullOrBlank()) line("Direccion: $addr")
                val pm = order.optString("payment_method", "")
                if (pm.isNotBlank()) line("Pago: ${pm.take(MAX_PAYMENT)}")
                val notes = order.optString("notes", "")
                if (notes.isNotBlank()) {
                    val mozo = parseMozoNameFromNotes(notes)
                    if (!mozo.isNullOrBlank()) line("Mozo: ${mozo.take(MAX_CONTEXT)}")
                }
            }
            "local" -> {
                val notes = order.optString("notes", "")
                if (notes.isNotBlank()) line("Notas: ${notes.take(MAX_CONTEXT)}")
            }
            else -> {
                val notes = order.optString("notes", "")
                if (notes.isNotBlank()) line("Notas: ${notes.take(MAX_CONTEXT)}")
            }
        }
    }

    /** Igual que `replaceUnicodeSeparatorsForThermal` en thermalPrinter.ts */
    private fun replaceUnicodeSeparatorsForThermal(text: String): String =
        text
            .replace("\u00b7", " | ") // · MIDDLE DOT
            .replace("\u2219", " | ") // ∙
            .replace("\u2022", " | ") // •
            .replace("\u2027", " | ") // ‧
            .replace("\u30fb", " | ") // ・
            .replace("\u0387", " | ") // · ano teleia

    /** Misma regla que `toThermalAscii` en thermalPrinter.ts (UTF-8 crudo → basura en CP437). */
    private fun toThermalAscii(text: String): String {
        val stripped = Normalizer.normalize(replaceUnicodeSeparatorsForThermal(text), Normalizer.Form.NFD)
            .replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
        return stripped
            .replace('ñ', 'n')
            .replace('Ñ', 'N')
            .replace(Regex("[^\\x20-\\x7E\\n\\r\\t]"), "?")
    }

    private fun concat(parts: List<ByteArray>): ByteArray {
        val total = parts.sumOf { it.size }
        val out = ByteArray(total)
        var o = 0
        for (p in parts) {
            p.copyInto(out, o)
            o += p.size
        }
        return out
    }

    fun build(order: JSONObject, menuPrices: Map<String, Double> = emptyMap()): ByteArray {
        val esc = 0x1b.toByte()
        val gs = 0x1d.toByte()
        val chunks = mutableListOf<ByteArray>()

        chunks += byteArrayOf(esc, 0x40)
        chunks += byteArrayOf(esc, 0x61, 0x01)
        chunks += "${toThermalAscii(TICKET_BANNER)}\n".toByteArray(StandardCharsets.UTF_8)
        chunks += byteArrayOf(esc, 0x61, 0x00)

        fun line(text: String) {
            chunks += (toThermalAscii(text) + "\n").toByteArray(StandardCharsets.UTF_8)
        }

        line("")
        line("Creado: ${formatCreatedForTicket(order.optString("created_at", ""))}")
        line("")

        val items: Any? = pickBestItemsSource(order)

        var wroteItemsSection = false
        val itemTotals = mutableListOf<Double>()
        when (items) {
            is JSONArray -> {
                wroteItemsSection = true
                line("--- Items ---")
                for (i in 0 until items.length()) {
                    val it = items.get(i)
                    val parsed = parseTicketItem(it, menuPrices)
                    line(parsed.line)
                    if (parsed.total != null) itemTotals.add(parsed.total)
                }
            }
            is JSONObject -> {
                wroteItemsSection = true
                val parsed = parseTicketItem(items, menuPrices)
                line(parsed.line)
                if (parsed.total != null) itemTotals.add(parsed.total)
            }
            null -> {}
            else -> {
                wroteItemsSection = true
                val parsed = parseTicketItem(items, menuPrices)
                line(parsed.line)
                if (parsed.total != null) itemTotals.add(parsed.total)
            }
        }
        val deliveryFee = deliveryFeeForTicket(order)
        if (deliveryFee != null) {
            wroteItemsSection = true
            line("- Delivery ${money(deliveryFee)}")
            itemTotals.add(deliveryFee)
        }
        val orderTotal = orderTotalForTicket(order, itemTotals)
        if (orderTotal != null) {
            line("Total: ${money(orderTotal)}")
        }

        val ctxLines = mutableListOf<String>()
        appendFulfillmentContext(order) { text -> ctxLines.add(text) }
        if (wroteItemsSection && ctxLines.isNotEmpty()) {
            line("")
        }
        for (t in ctxLines) {
            line(t)
        }

        line("")
        chunks += byteArrayOf(esc, 0x61, 0x01)
        chunks += "${toThermalAscii(TICKET_THANK_YOU_BANNER)}\n".toByteArray(StandardCharsets.UTF_8)
        chunks += byteArrayOf(esc, 0x61, 0x00)
        val scheduledAlert = scheduledDeliveryAlertLine(order)
        if (scheduledAlert != null) {
            line("")
            chunks += byteArrayOf(esc, 0x61, 0x01)
            chunks += byteArrayOf(esc, 0x45, 0x01)
            chunks += byteArrayOf(esc, 0x21, 0x08)
            chunks += "${toThermalAscii(scheduledAlert)}\n".toByteArray(StandardCharsets.UTF_8)
            chunks += byteArrayOf(esc, 0x21, 0x00)
            chunks += byteArrayOf(esc, 0x45, 0x00)
            chunks += byteArrayOf(esc, 0x61, 0x00)
        }
        chunks += byteArrayOf(0x0a, 0x0a)
        chunks += byteArrayOf(gs, 0x56, 0x41, 0x03)

        return concat(chunks)
    }
}
