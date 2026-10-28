package com.restokds.app

import android.content.SharedPreferences
import org.json.JSONObject

object RestoPollerPrefs {
    const val PREFS_NAME = "resto_receptor_poller"
    const val CONFIG_KEY = "native_poller_config"
    /** Mismas claves que localStorage en JS para mantener ids impresos */
    const val PRINTED_IDS_KEY = "resto_kds_printed_order_ids"
    const val PRINTED_BOLETERIA_IDS_KEY = "resto_kds_printed_boleteria_ids"

    fun printedKeyFor(workMode: String?): String =
        if (workMode?.trim() == "boleteria") PRINTED_BOLETERIA_IDS_KEY else PRINTED_IDS_KEY

    fun printedKey(prefs: SharedPreferences): String {
        val mode =
            try {
                JSONObject(prefs.getString(CONFIG_KEY, null) ?: "{}").optString("workMode", "")
            } catch (_: Exception) {
                ""
            }
        return printedKeyFor(mode)
    }
}
