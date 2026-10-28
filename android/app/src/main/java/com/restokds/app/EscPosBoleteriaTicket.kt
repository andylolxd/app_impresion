package com.restokds.app

import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.text.Normalizer
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Layout ESC/POS para entradas de boletería (paridad con buildBoleteriaTicketBytes en TS).
 * Sin java.time: minSdk 24 y no hay desugaring.
 */
object EscPosBoleteriaTicket {

    private const val BANNER = "BOLETERIA MENDOZA DEL OESTE"
    private const val CONDITIONS_TITLE = "CONDICIONES DE INGRESO Y VALIDEZ"
    private val CONDITIONS = listOf(
        "Entrada válida para un (1) único acceso. El código QR será validado en puerta.",
        "Los códigos QR previamente utilizados no habilitarán un nuevo ingreso. En caso de duplicidad, prevalecerá el primer acceso registrado.",
        "La organización no se responsabiliza por robo, hurto o extravío de la entrada.",
        "En caso de extravío, no se garantiza la reimpresión ni el reintegro del importe abonado.",
    )

    /** Fuente B (9x17) da 64 columnas en 80 mm; se corta en 56 por si el modelo usa una fuente B más ancha. */
    private const val CONDITIONS_COLS = 56
    private const val TICKET_ZONE = "America/Argentina/Mendoza"
    private val OFFSET_SUFFIX = Regex("(Z|[+-]\\d{2}:?\\d{2})$")

    private fun toAscii(text: String): String {
        val n = Normalizer.normalize(text.replace('\u2013', '-').replace('\u2014', '-'), Normalizer.Form.NFD)
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
                byteArrayOf(0x1b, 0x21, 0x30),
                enc("$text\n"),
                byteArrayOf(0x1b, 0x21, 0x00),
                byteArrayOf(0x1b, 0x45, 0x00),
                byteArrayOf(0x1b, 0x61, 0x00),
            ),
        )

    private fun cutPartial(): ByteArray = byteArrayOf(0x1d, 0x56, 0x41, 0x03)

    /** Ítem con guion y sangría colgante, cortando por palabras. */
    private fun wrapBullet(text: String, cols: Int): List<String> {
        val words = toAscii(text).split(Regex("\\s+")).filter { it.isNotEmpty() }
        val lines = mutableListOf<String>()
        var cur = "-"
        for (w in words) {
            if (cur.trim() != "-" && cur.length + 1 + w.length > cols) {
                lines.add(cur)
                cur = "  $w"
            } else {
                cur += " $w"
            }
        }
        lines.add(cur)
        return lines
    }

    private fun conditions(): ByteArray {
        val body = CONDITIONS.flatMap { wrapBullet(it, CONDITIONS_COLS) }.joinToString("\n")
        return concat(
            listOf(
                byteArrayOf(0x1b, 0x4d, 0x01),
                byteArrayOf(0x1b, 0x61, 0x01),
                byteArrayOf(0x1b, 0x45, 0x01),
                enc("$CONDITIONS_TITLE\n"),
                byteArrayOf(0x1b, 0x45, 0x00),
                byteArrayOf(0x1b, 0x61, 0x00),
                enc("$body\n"),
                byteArrayOf(0x1b, 0x4d, 0x00),
            ),
        )
    }

    private fun qr(payload: String): ByteArray {
        val data = enc(payload.take(200))
        val storeLen = data.size + 3
        val pL = (storeLen and 0xff).toByte()
        val pH = ((storeLen shr 8) and 0xff).toByte()
        return concat(
            listOf(
                byteArrayOf(0x1b, 0x61, 0x01),
                byteArrayOf(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00),
                byteArrayOf(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x0a),
                byteArrayOf(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31),
                byteArrayOf(0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30),
                data,
                byteArrayOf(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30),
                byteArrayOf(0x1b, 0x61, 0x00),
            ),
        )
    }

    /** Prisma guarda UTC en `timestamp without time zone`; PostgREST lo devuelve sin offset. */
    private fun formatWhen(iso: String): String {
        val s = iso.trim().replace(Regex("\\.\\d+"), "")
        if (s.isEmpty()) return ""
        return try {
            val hasOffset = OFFSET_SUFFIX.containsMatchIn(s.substringAfter('T', ""))
            val parser =
                SimpleDateFormat(
                    if (hasOffset) "yyyy-MM-dd'T'HH:mm:ssXXX" else "yyyy-MM-dd'T'HH:mm:ss",
                    Locale.US,
                ).apply { timeZone = TimeZone.getTimeZone("UTC") }
            val date = parser.parse(s) ?: return s.take(19).replace('T', ' ')
            SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone(TICKET_ZONE) }
                .format(date)
        } catch (_: Exception) {
            s.take(19).replace('T', ' ')
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
        val typeNumber = ticket.optLong("typeNumber", 0)
        val typeCapacity = ticket.optInt("typeCapacity", 0)
        if (typeNumber > 0) {
            // "Nro" y no "N°": la térmica recibe solo ASCII.
            val label = if (typeCapacity > 0) "Boleto Nro $typeNumber de $typeCapacity" else "Boleto Nro $typeNumber"
            parts.add(byteArrayOf(0x1b, 0x45, 0x01))
            parts.add(line(label))
            parts.add(byteArrayOf(0x1b, 0x45, 0x00))
        }
        parts.add(line("Precio: ${formatPrice(priceCents)}"))
        parts.add(line("Pago: $payment"))
        parts.add(line(""))
        parts.add(line("Titular: $buyer"))
        if (phone.isNotBlank()) parts.add(line("Tel: $phone"))
        parts.add(line(""))
        parts.add(prominent(shortCode.ifBlank { "--" }))
        parts.add(line(""))
        if (shortCode.isNotBlank()) {
            parts.add(qr(shortCode))
            parts.add(line(""))
        }
        parts.add(centered("Presentar en puerta"))
        parts.add(line(""))
        parts.add(conditions())
        parts.add(byteArrayOf(0x0a, 0x0a))
        parts.add(cutPartial())
        return concat(parts)
    }
}
