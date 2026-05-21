package studio.deponchy.tradegenius

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import androidx.core.app.NotificationCompat

/**
 * Trade Genius Live — Foreground Service v1.0
 * (forké du pattern BJ Genius v1.3.4)
 *
 * Maintient la bulle TG visible par-dessus toutes les apps (Binance, eToro,
 * TradingView, etc.) pour analyser le graph en cours.
 *
 * Cycle de vie :
 *   ACTION_START          → cree la bulle via WindowManager + foreground notif
 *   ACTION_STOP           → retire la bulle + arrete le service
 *   ACTION_SET_DECISION   → met a jour le rectangle decision (depuis JS)
 */
class TGBubbleService : Service() {

    companion object {
        const val ACTION_START = "studio.deponchy.tradegenius.START_BUBBLE"
        const val ACTION_STOP = "studio.deponchy.tradegenius.STOP_BUBBLE"
        const val ACTION_SET_DECISION = "studio.deponchy.tradegenius.SET_DECISION"
        const val EXTRA_DECISION_TEXT = "decision_text"
        const val EXTRA_DECISION_COLOR = "decision_color"

        // Broadcasts emis par le service vers le plugin Java qui les relaie a JS
        const val BROADCAST_BUBBLE_EVENT = "studio.deponchy.tradegenius.BUBBLE_EVENT"
        const val EXTRA_EVENT_TYPE = "event_type"
        const val EVENT_SCAN_TAP = "scan_tap"
        const val EVENT_CLOSE_TAP = "close_tap"
        const val EVENT_BUBBLE_TAP = "bubble_tap"

        const val CHANNEL_ID = "tradegenius_bubble_channel"
        const val NOTIFICATION_ID = 4243
        const val TAG = "TGBubble"

        private var running: Boolean = false

        @JvmStatic
        fun isRunning(): Boolean = running

        private var instance: TGBubbleService? = null

        @JvmStatic
        fun setDecision(text: String, colorHex: String?) {
            val inst = instance ?: return
            inst.bubbleView?.updateDecision(text, colorHex)
        }
    }

    private var windowManager: WindowManager? = null
    private var bubbleView: BubbleOverlayView? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service onCreate")
        instance = this
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startBubble()
            ACTION_STOP -> stopBubble()
            ACTION_SET_DECISION -> {
                val text = intent.getStringExtra(EXTRA_DECISION_TEXT) ?: ""
                val color = intent.getStringExtra(EXTRA_DECISION_COLOR)
                bubbleView?.updateDecision(text, color)
            }
            else -> Log.w(TAG, "Unknown action: ${intent?.action}")
        }
        return START_NOT_STICKY
    }

    private fun startBubble() {
        if (running) {
            Log.d(TAG, "Already running, ignoring start")
            return
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    buildNotification(),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                )
            } else {
                startForeground(NOTIFICATION_ID, buildNotification())
            }
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed (fatal)", e)
            stopSelf()
            return
        }

        val wm = windowManager
        if (wm == null) {
            Log.e(TAG, "WindowManager is null (fatal)")
            stopSelf()
            return
        }

        try {
            bubbleView = BubbleOverlayView(this).apply {
                onCloseRequested = {
                    emitBubbleEvent(EVENT_CLOSE_TAP)
                    stopBubble()
                }
                onBubbleTap = { emitBubbleEvent(EVENT_BUBBLE_TAP) }
                onScanTap = { emitBubbleEvent(EVENT_SCAN_TAP) }
                this.windowManager = wm
            }
        } catch (e: Exception) {
            Log.e(TAG, "BubbleOverlayView construction failed (fatal)", e)
            stopSelf()
            return
        }

        val density = resources.displayMetrics.density
        val viewW = BubbleOverlayView.collapsedWidthPx(density)
        val viewH = BubbleOverlayView.collapsedHeightPx(density)

        val layoutFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        val overlayFlags =
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN

        val params = WindowManager.LayoutParams(
            viewW, viewH,
            layoutFlag,
            overlayFlags,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            val screenW = resources.displayMetrics.widthPixels
            x = screenW - viewW - (16 * density).toInt()
            y = (90 * density).toInt()
        }

        try {
            wm.addView(bubbleView, params)
            running = true
            Log.d(TAG, "Bubble added at x=${params.x}, y=${params.y}, w=$viewW, h=$viewH")
        } catch (e: Exception) {
            Log.e(TAG, "addView failed (fatal)", e)
            bubbleView = null
            stopSelf()
        }
    }

    private fun emitBubbleEvent(eventType: String) {
        val intent = Intent(BROADCAST_BUBBLE_EVENT).apply {
            putExtra(EXTRA_EVENT_TYPE, eventType)
            setPackage(packageName)
        }
        try {
            sendBroadcast(intent)
            Log.d(TAG, "Bubble event: $eventType")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to broadcast bubble event", e)
        }
    }

    private fun stopBubble() {
        Log.d(TAG, "Stopping bubble")
        try {
            bubbleView?.let { windowManager?.removeView(it) }
        } catch (e: Exception) {
            Log.w(TAG, "removeView failed (already removed?)", e)
        }
        bubbleView = null
        running = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onDestroy() {
        Log.d(TAG, "Service onDestroy")
        instance = null
        try {
            bubbleView?.let { windowManager?.removeView(it) }
        } catch (_: Exception) {}
        bubbleView = null
        running = false
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        } ?: Intent().apply {
            setPackage(packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val openAppPending = PendingIntent.getActivity(this, 0, openAppIntent, pendingFlags)

        val stopIntent = Intent(this, TGBubbleService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(this, 1, stopIntent, pendingFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Trade Genius actif")
            .setContentText("La bulle d'analyse est visible — tap pour ouvrir l'app")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(openAppPending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Fermer", stopPending)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Trade Genius Live",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Notification permanente quand la bulle Trade Genius est active"
                setShowBadge(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }
}
