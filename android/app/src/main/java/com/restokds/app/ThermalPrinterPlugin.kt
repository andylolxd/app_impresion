package com.restokds.app

import android.util.Base64
import android.util.Log
import android.net.wifi.WifiManager
import android.content.Context
import android.os.Build
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Abre un socket TCP hacia la impresora térmica (p. ej. puerto 9100) y envía bytes ESC/POS.
 * El payload llega en Base64 desde el bridge de Capacitor.
 */
@CapacitorPlugin(name = "ThermalPrinter")
class ThermalPrinterPlugin : Plugin() {
    private val tag = "ThermalPrinterPlugin"

    @PluginMethod
    fun sendBytes(call: PluginCall) {
        val host = call.getString("host") ?: run {
            call.reject("Se requiere host")
            return
        }
        val port = call.getInt("port", 9100) ?: 9100
        val dataB64 = call.getString("data") ?: run {
            call.reject("Se requiere data (Base64)")
            return
        }

        val bytes = Base64.decode(dataB64, Base64.DEFAULT)

        Thread {
            var wifiLock: WifiManager.WifiLock? = null
            try {
                val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                if (wm != null) {
                    @Suppress("DEPRECATION")
                    val mode =
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        } else {
                            WifiManager.WIFI_MODE_FULL_HIGH_PERF
                        }
                    wifiLock = wm.createWifiLock(mode, "resto-receptor:printer-send")
                    wifiLock.setReferenceCounted(false)
                    wifiLock.acquire()
                }

                Socket().use { socket ->
                    socket.tcpNoDelay = true
                    socket.soTimeout = 20000
                    socket.connect(InetSocketAddress(host, port), 20000)
                    socket.getOutputStream().use { out ->
                        out.write(bytes)
                        out.flush()
                    }
                }
                bridge.executeOnMainThread { call.resolve() }
            } catch (e: Exception) {
                val msg = e.message ?: e.javaClass.simpleName
                Log.e(tag, "Impresora TCP fallo: $msg", e)
                bridge.executeOnMainThread { call.reject("Impresora TCP: $msg", e) }
            } finally {
                try {
                    if (wifiLock?.isHeld == true) wifiLock?.release()
                } catch (_: Exception) {
                    // noop
                }
            }
        }.start()
    }
}
