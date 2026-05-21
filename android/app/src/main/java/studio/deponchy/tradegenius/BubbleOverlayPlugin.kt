/**
 * Trade Genius — Bubble Overlay Plugin (Capacitor 6 / Kotlin)
 *
 * Plugin natif Android qui :
 * 1. Affiche une bulle flottante (SYSTEM_ALERT_WINDOW) par-dessus toutes les apps
 * 2. Au tap → déclenche MediaProjection (capture d'écran)
 * 3. Lance l'OCR via ML Kit Vision (texte du graph)
 * 4. Renvoie le résultat au JS via event 'bubbleScanResult'
 *
 * Le JS écoute l'event puis appelle ses propres détecteurs (agents IA).
 *
 * À PLACER DANS :
 *   android/app/src/main/java/studio/deponchy/tradegenius/BubbleOverlayPlugin.kt
 *
 * À RÉFÉRENCER DANS MainActivity.kt avec :
 *   registerPlugin(BubbleOverlayPlugin::class.java)
 */
package studio.deponchy.tradegenius

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "BubbleOverlay",
    permissions = [
        Permission(strings = [android.Manifest.permission.SYSTEM_ALERT_WINDOW], alias = "overlay"),
        Permission(strings = [android.Manifest.permission.FOREGROUND_SERVICE], alias = "foreground"),
        Permission(strings = [android.Manifest.permission.POST_NOTIFICATIONS], alias = "notifs")
    ]
)
class BubbleOverlayPlugin : Plugin() {

    /**
     * Demande la permission SYSTEM_ALERT_WINDOW (renvoie vers les paramètres système si nécessaire).
     */
    @PluginMethod
    fun requestOverlayPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!Settings.canDrawOverlays(context)) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + context.packageName)
                )
                intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
                context.startActivity(intent)
                call.resolve(JSObject().put("granted", false).put("prompted", true))
                return
            }
        }
        call.resolve(JSObject().put("granted", true).put("prompted", false))
    }

    /**
     * Vérifie si la permission overlay est accordée.
     */
    @PluginMethod
    fun hasOverlayPermission(call: PluginCall) {
        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Settings.canDrawOverlays(context)
        } else true
        call.resolve(JSObject().put("granted", granted))
    }

    /**
     * Lance le foreground service qui crée et affiche la bulle.
     */
    @PluginMethod
    fun showBubble(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
            call.reject("Permission SYSTEM_ALERT_WINDOW non accordée")
            return
        }
        val intent = Intent(context, BubbleService::class.java)
        intent.action = BubbleService.ACTION_SHOW
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
        call.resolve(JSObject().put("shown", true))
    }

    /**
     * Cache la bulle (arrête le service).
     */
    @PluginMethod
    fun hideBubble(call: PluginCall) {
        val intent = Intent(context, BubbleService::class.java)
        intent.action = BubbleService.ACTION_HIDE
        context.startService(intent)
        call.resolve(JSObject().put("hidden", true))
    }

    /**
     * Déclenche manuellement un scan d'écran (sans avoir besoin de la bulle).
     * MediaProjection demandera confirmation à l'user à la 1re fois.
     */
    @PluginMethod
    fun triggerScan(call: PluginCall) {
        val activity = activity ?: run {
            call.reject("No activity")
            return
        }
        ScreenScanManager.requestScan(activity) { result ->
            if (result.success) {
                val res = JSObject()
                res.put("text", result.ocrText ?: "")
                res.put("ticker", result.detectedTicker ?: "")
                res.put("price", result.detectedPrice ?: 0.0)
                res.put("ts", System.currentTimeMillis())
                notifyListeners("bubbleScanResult", res)
                call.resolve(res)
            } else {
                call.reject(result.error ?: "Scan failed")
            }
        }
    }

    /**
     * Helper utilisé par le BubbleService quand l'user tap sur la bulle.
     * Appelle ScreenScanManager → OCR → notifyListeners('bubbleScanResult').
     */
    fun onBubbleTapped() {
        val activity = activity ?: return
        ScreenScanManager.requestScan(activity) { result ->
            if (result.success) {
                val res = JSObject()
                res.put("text", result.ocrText ?: "")
                res.put("ticker", result.detectedTicker ?: "")
                res.put("price", result.detectedPrice ?: 0.0)
                res.put("ts", System.currentTimeMillis())
                notifyListeners("bubbleScanResult", res)
            }
        }
    }
}
