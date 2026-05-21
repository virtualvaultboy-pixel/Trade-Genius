/**
 * BubbleService.kt — Foreground service qui affiche la bulle flottante.
 *
 * À PLACER DANS :
 *   android/app/src/main/java/studio/deponchy/tradegenius/BubbleService.kt
 */
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
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.core.app.NotificationCompat

class BubbleService : Service() {

    companion object {
        const val ACTION_SHOW = "studio.deponchy.tradegenius.SHOW_BUBBLE"
        const val ACTION_HIDE = "studio.deponchy.tradegenius.HIDE_BUBBLE"
        const val CHANNEL_ID = "tg_bubble_channel"
        const val NOTIF_ID = 4242
    }

    private var windowManager: WindowManager? = null
    private var bubbleView: View? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SHOW -> {
                createNotificationChannel()
                startForeground(NOTIF_ID, buildNotification())
                showBubble()
            }
            ACTION_HIDE -> {
                hideBubble()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val ch = NotificationChannel(
                CHANNEL_ID,
                "Trade Genius — Bulle Analyste",
                NotificationManager.IMPORTANCE_LOW
            )
            ch.description = "Bulle flottante d'analyse de graph"
            mgr.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pi = PendingIntent.getActivity(
            this, 0, openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("🤖 Trade Genius — Analyse active")
            .setContentText("Tap sur la bulle pour scanner un graph")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    @Suppress("ClickableViewAccessibility")
    private fun showBubble() {
        if (bubbleView != null) return
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        bubbleView = FrameLayout(this).apply {
            setBackgroundResource(android.R.drawable.btn_default_small)
            // Crée un cercle dégradé bleu/violet via background drawable
            background = resources.getDrawable(R.drawable.bubble_bg, theme)
            val px56 = (56 * resources.displayMetrics.density).toInt()
            layoutParams = WindowManager.LayoutParams(px56, px56)
        }
        val layoutType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        val params = WindowManager.LayoutParams(
            (60 * resources.displayMetrics.density).toInt(),
            (60 * resources.displayMetrics.density).toInt(),
            layoutType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 50
            y = 200
        }

        var initialX = 0
        var initialY = 0
        var initialTouchX = 0f
        var initialTouchY = 0f
        var moved = false

        bubbleView!!.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = params.x
                    initialY = params.y
                    initialTouchX = event.rawX
                    initialTouchY = event.rawY
                    moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - initialTouchX).toInt()
                    val dy = (event.rawY - initialTouchY).toInt()
                    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true
                    params.x = initialX + dx
                    params.y = initialY + dy
                    windowManager?.updateViewLayout(bubbleView, params)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) {
                        // Tap → déclenche scan via plugin
                        TradeGeniusBridge.onBubbleTap()
                    }
                    true
                }
                else -> false
            }
        }
        windowManager?.addView(bubbleView, params)
    }

    private fun hideBubble() {
        bubbleView?.let { windowManager?.removeView(it) }
        bubbleView = null
    }

    override fun onDestroy() {
        hideBubble()
        super.onDestroy()
    }
}

/**
 * Bridge statique pour permettre au BubbleService d'appeler le plugin.
 * Le plugin s'enregistre au démarrage et le service utilise ce bridge.
 */
object TradeGeniusBridge {
    private var plugin: BubbleOverlayPlugin? = null
    fun register(p: BubbleOverlayPlugin) { plugin = p }
    fun unregister() { plugin = null }
    fun onBubbleTap() { plugin?.onBubbleTapped() }
}
