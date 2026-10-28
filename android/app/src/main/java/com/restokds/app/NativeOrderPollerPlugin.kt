package com.restokds.app

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject

@CapacitorPlugin(name = "NativeOrderPoller")
class NativeOrderPollerPlugin : Plugin() {

    companion object {
        private const val TAG = "NativeOrderPoller"
        /** Une IDs ya marcados en Android con los que manda JS (evita pisar impresiones nativas si localStorage va atrasado). */
        private fun mergePrintedIds(prefs: SharedPreferences, incomingJson: String?, key: String) {
            val merged = LinkedHashSet<String>()
            fun addAll(raw: String?) {
                try {
                    val arr = JSONArray(raw ?: "[]")
                    for (i in 0 until arr.length()) merged.add(arr.getString(i))
                } catch (_: Exception) {
                }
            }
            addAll(prefs.getString(key, "[]"))
            addAll(incomingJson)
            val out = JSONArray()
            for (id in merged) out.put(id)
            prefs.edit().putString(key, out.toString()).apply()
        }
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        try {
            val prefs = context.applicationContext.getSharedPreferences(RestoPollerPrefs.PREFS_NAME, Context.MODE_PRIVATE)
            val pollMs =
                (call.getDouble("pollIntervalMs", 10_000.0) ?: 10_000.0).toLong().coerceAtLeast(1500L)
            val workMode = (call.getString("workMode", "restaurant") ?: "restaurant").trim()
            val cfg =
                JSONObject().apply {
                    put("supabaseUrl", call.getString("supabaseUrl", "") ?: "")
                    put("supabaseAnonKey", call.getString("supabaseAnonKey", "") ?: "")
                    put("restaurantId", call.getString("restaurantId", "") ?: "")
                    put("printerHost", call.getString("printerHost", "") ?: "")
                    put("printerPort", call.getInt("printerPort", 9100))
                    put("pollIntervalMs", pollMs)
                    put("workMode", if (workMode == "boleteria") "boleteria" else "restaurant")
                }
            prefs.edit().putString(RestoPollerPrefs.CONFIG_KEY, cfg.toString()).apply()

            val printedJson = call.getString("printedIdsJson") ?: "[]"
            mergePrintedIds(prefs, printedJson, RestoPollerPrefs.printedKeyFor(workMode))
            val rid = call.getString("restaurantId", "") ?: ""
            val host = call.getString("printerHost", "") ?: ""
            Log.i(
                TAG,
                "configure mode=$workMode pollMs=$pollMs restaurantLen=${rid.length} printer=${host.isNotBlank()}",
            )
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message, e)
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        Log.i(TAG, "start foreground OrderPollingService")
        OrderPollingService.start(context.applicationContext)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        Log.i(TAG, "stop OrderPollingService")
        OrderPollingService.stop(context.applicationContext)
        call.resolve()
    }

    @PluginMethod
    fun clearPrintedIds(call: PluginCall) {
        val prefs = context.applicationContext.getSharedPreferences(RestoPollerPrefs.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(RestoPollerPrefs.printedKey(prefs), "[]").apply()
        call.resolve()
    }

    @PluginMethod
    fun getPrintedIdsJson(call: PluginCall) {
        val prefs = context.applicationContext.getSharedPreferences(RestoPollerPrefs.PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(RestoPollerPrefs.printedKey(prefs), "[]") ?: "[]"
        val ret = JSObject()
        ret.put("printedIdsJson", raw)
        call.resolve(ret)
    }
}
