package com.restokds.app

import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Layout ESC/POS para entradas de boletería (paridad con buildBoleteriaTicketBytes en TS).
 */
object EscPosBoleteriaTicket {

    private const val BANNER = "BOLETERIA MENDOZA DEL OESTE"
    private val ticketZone: ZoneId = ZoneId.of("America/Argentina/Mendoza")
    private val ticketTimeFmt: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ticketZone)

    private fun toAscii(text: String): String {
        val n = Normalizer.normalize(text, Normalizer.Form.NFD)
            .replace(Regex("\\p{InCombiningDiacriticalMarks}+"), "")
            .replace('ñ', 'n')
            .replace('Ñ', 'N')
        val sb = StringBuilder()
        for (ch in n) {
            val c = ch.code
            if (c in 0x20..0x7E || ch == '\n' || ch == '\r' || ch == '\t') sb.append(ch)
            else sb.append('?')
        }
        return sb.toString()
    }

    private fun concat(chunks: List<ByteArray>): ByteArray {
        val len = chunks.sumOf { it.size }
        val out = ByteArray(len)
        var o = 0
        for (c in chunks) {
            System.arraycopy(c, 0, out, o, c.size)
            o += c.size
        }
        return out
    }

    private fun enc(s: String): ByteArray = toAscii(s).toByteArray(StandardCharsets.US_ASCII)

    private fun header(title: String): ByteArray =
        concat(
            listOf(
                byteArrayOf(0x1b, 0x40),
                byteArrayOf(0x1b, 0x61, 0x01),
                enc("$title\n"),
                byteArrayOf(0x1b, 0x61, 0x00),
            ),
        )

    private fun line(text: String): ByteArray = concat(listOf(enc(text), byteArrayOf(0x0a)))

    private fun centered(text: String): ByteArray =
        concat(
            listOf(
                byteArrayOf(0x1b, 0x61, 0x01),
                enc("$text\n"),
                byteArrayOf(0x1b, 0x61, 0x00),
            ),
        )

    private fun prominent(text: String): ByteArray =
        concat(
            listOf(
                byteArrayOf(0x1b, 0x61, 0x01),
                byteArrayOf(0x1b, 0x45, 0x01),
                byteArrayOf(0x1b, 0x21, 0x08),
                enc("$text\n"),
                byteArrayOf(0x1b, 0x21, 0x00),
                byteArrayOf(0x1b, 0x45, 0x00),
                byteArrayOf(0x1b, 0x61, 0x00),
            ),
        )

    private fun cutPartial(): ByteArray = byteArrayOf(0x1d, 0x56, 0x41, 0x03)

    private fun qr(payload: String): ByteArray {
        val data = enc(payload.take(200))
        val storeLen = data.size + 3
        val pL = (storeLen and 0xff).toByte()
        val pH = ((storeLen shr 8) and 0xff).toByte()
        return concat(
            listOf(
                byteArrayOf(0x1b, 0x61, 0x01),
                byteArrayOf(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00),
                byteArrayOf(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06),
                byteArrayOf(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31),
                byteArrayOf(0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30),
                data,
                byteArrayOf(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30),
                byteArrayOf(0x1b, 0x61, 0x00),
            ),
        )
    }

    private fun formatWhen(iso: String): String {
        if (iso.isBlank()) return ""
        return try {
            ticketTimeFmt.format(Instant.parse(iso))
        } catch (_: Exception) {
            iso.take(19).replace('T', ' ')
        }
    }

    private fun formatPrice(cents: Int): String =
        if (cents == 0) "Cortesia" else "$" + "%.2f".format(Locale.US, cents / 100.0)

    private fun paymentLabel(method: String): String =
        when (method) {
            "EFECTIVO" -> "Efectivo"
            "TRANSFERENCIA" -> "Transferencia"
            "MERCADO_PAGO" -> "Mercado Pago"
            "CORTESIA" -> "Cortesia"
            else -> method.ifBlank { "—" }
        }

    fun build(ticket: JSONObject): ByteArray {
        val shortCode = ticket.optString("shortCode", "")
        val eventTitle = ticket.optString("eventTitle", "Evento")
        val whenStr = formatWhen(ticket.optString("startsAt", ""))
        val venue = ticket.optString("venue", "—")
        val typeName = ticket.optString("ticketTypeName", "—")
        val priceCents = ticket.optInt("priceCents", 0)
        val payment = paymentLabel(ticket.optString("paymentMethod", ""))
        val buyer = ticket.optString("buyerName", "—")
        val phone = ticket.optString("buyerPhone", "")

        val parts = mutableListOf<ByteArray>()
        parts.add(header(BANNER))
        parts.add(line(""))
        parts.add(centered(eventTitle.ifBlank { "Evento" }))
        parts.add(line("Fecha: $whenStr"))
        parts.add(line("Lugar: $venue"))
        parts.add(line(""))
        parts.add(line("Tipo: $typeName"))
        parts.add(line("Precio: ${formatPrice(priceCents)}"))
        parts.add(line("Pago: $payment"))
        parts.add(line(""))
        parts.add(line("Titular: $buyer"))
        if (phone.isNotBlank()) parts.add(line("Tel: $phone"))
        parts.add(line(""))
        parts.add(prominent(shortCode.ifBlank { "——" }))
        parts.add(line(""))
        if (shortCode.isNotBlank()) {
            parts.add(qr(shortCode))
            parts.add(line(""))
        }
        parts.add(centered("Presentar en puerta"))
        parts.add(byteArrayOf(0x0a, 0x0a))
        parts.add(cutPartial())
        return concat(parts)
    }
}
