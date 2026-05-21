package studio.deponchy.tradegenius

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Bulle flottante Trade Genius — v1.0 (forké du pattern BJ Genius v1.3.20)
 *
 * 2 sous-bulles (au lieu de 3 chez BJ) :
 *   - SCAN (📷) : declenche l'analyse de l'asset visible a l'ecran (OCR a venir)
 *   - CLOSE (X) : ferme la bulle
 *
 * Couleur principale : vert TG (#22c55e).
 * Texte central : "TG".
 */
@SuppressLint("ViewConstructor")
class BubbleOverlayView(context: Context) : View(context) {

    companion object {
        const val BUBBLE_DP = 56
        const val SUB_BUBBLE_DP = 42
        const val EXPAND_DIST_DP = 64
        const val DECISION_HEIGHT_DP = 32
        const val DECISION_MIN_WIDTH_DP = 110
        const val DECISION_GAP_DP = 8
        const val PADDING_DP = 6

        @JvmStatic
        fun collapsedWidthPx(density: Float): Int =
            ((BUBBLE_DP + PADDING_DP * 2) * density).toInt()

        @JvmStatic
        fun collapsedHeightPx(density: Float): Int =
            ((BUBBLE_DP + PADDING_DP * 2) * density).toInt()
    }

    // ── Callbacks externes ──────────────────────────────────────────
    var windowManager: WindowManager? = null
    var onBubbleTap: (() -> Unit)? = null
    var onScanTap: (() -> Unit)? = null
    var onCloseRequested: (() -> Unit)? = null

    // ── Etat ────────────────────────────────────────────────────────
    private var expanded = false
    private var decisionText = ""
    private var decisionColor = Color.parseColor("#22c55e") // vert TG par defaut

    // ── Geometrie en pixels ─────────────────────────────────────────
    private val density = resources.displayMetrics.density
    private val bubbleSize = (BUBBLE_DP * density).toInt()
    private val subBubbleSize = (SUB_BUBBLE_DP * density).toInt()
    private val expandDist = EXPAND_DIST_DP * density
    private val decisionHeight = (DECISION_HEIGHT_DP * density).toInt()
    private val decisionMinWidth = (DECISION_MIN_WIDTH_DP * density).toInt()
    private val decisionGap = (DECISION_GAP_DP * density).toInt()
    private val padding = (PADDING_DP * density).toInt()

    private var subBubblesLeft = true

    private var bubbleCx = (bubbleSize / 2f + padding)
    private var bubbleCy = (bubbleSize / 2f + padding)
    private var scanCx = 0f; private var scanCy = 0f
    private var closeCx = 0f; private var closeCy = 0f
    private var decisionTopY = 0f

    private var currentViewW = bubbleSize + padding * 2
    private var currentViewH = bubbleSize + padding * 2

    private var hasLaidOutOnce = false

    // ── Peintures Trade Genius (palette verte/sombre) ───────────────
    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#22c55e"); style = Paint.Style.FILL
    }
    private val shadowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#60000000"); style = Paint.Style.FILL
    }
    private val subBubbleBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#0a0a0c"); style = Paint.Style.FILL
    }
    private val subBubbleBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#22c55e"); style = Paint.Style.STROKE
        strokeWidth = 1.5f * density
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 16 * density
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textAlign = Paint.Align.CENTER
    }
    private val subIconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 18 * density
        textAlign = Paint.Align.CENTER
    }
    private val closeBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#dc2626"); style = Paint.Style.FILL
    }
    private val closeXPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; style = Paint.Style.STROKE
        strokeWidth = 2.5f * density; strokeCap = Paint.Cap.ROUND
    }
    private val decisionBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#22c55e"); style = Paint.Style.FILL
    }
    private val decisionTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 14 * density
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textAlign = Paint.Align.CENTER
    }

    // ── Drag state ──────────────────────────────────────────────────
    private var initialX = 0
    private var initialY = 0
    private var initialTouchX = 0f
    private var initialTouchY = 0f
    private var hasDragged = false
    private var touchDownTime = 0L
    private val touchSlop = 12 * density
    private val tapMaxDuration = 250L

    private enum class HitZone { NONE, BUBBLE, SCAN, CLOSE, DECISION }
    private var hitZone = HitZone.NONE

    private var resizeAnimator: android.animation.ValueAnimator? = null

    // ── API publique ────────────────────────────────────────────────
    fun updateDecision(text: String, colorHex: String?) {
        decisionText = text
        if (!colorHex.isNullOrEmpty()) {
            try { decisionColor = Color.parseColor(colorHex) } catch (_: Exception) {}
        }
        decisionBgPaint.color = decisionColor
        applyResize()
    }

    fun setExpanded(v: Boolean) {
        if (expanded != v) {
            expanded = v
            applyResize()
        }
    }

    fun toggleExpanded() = setExpanded(!expanded)

    // ── Layout ──────────────────────────────────────────────────────
    private fun recomputeLayout() {
        val mainR = bubbleSize / 2
        val subR = subBubbleSize / 2
        val hasDecision = decisionText.isNotEmpty()

        val lp = layoutParams as? WindowManager.LayoutParams
        val screenW = resources.displayMetrics.widthPixels
        if (lp != null && hasLaidOutOnce) {
            val bjScreenX = lp.x + bubbleCx.toInt()
            subBubblesLeft = bjScreenX > screenW / 2
        }

        if (!expanded) {
            val w = if (hasDecision) {
                max(bubbleSize, decisionBoxWidth().toInt()) + padding * 2
            } else {
                bubbleSize + padding * 2
            }
            val h = if (hasDecision) {
                decisionHeight + decisionGap + bubbleSize + padding * 2
            } else {
                bubbleSize + padding * 2
            }
            currentViewW = w
            currentViewH = h
            bubbleCx = w / 2f
            bubbleCy = if (hasDecision) {
                (padding + decisionHeight + decisionGap + mainR).toFloat()
            } else {
                (padding + mainR).toFloat()
            }
            decisionTopY = padding.toFloat()
        } else {
            // EXPANDED : 2 sous-bulles en arc autour de TG (scan dessus, close dessous)
            val arcRadius = expandDist
            val angleSpread = Math.toRadians(40.0)
            val baseAngle = if (subBubblesLeft) Math.PI else 0.0
            val angleScan = baseAngle - angleSpread
            val angleClose = baseAngle + angleSpread

            val cosSpread = Math.cos(angleSpread).toFloat()
            val sinSpread = Math.sin(angleSpread).toFloat()

            val arcExtent = (arcRadius * cosSpread + subR).toInt()
            var w = bubbleSize + arcExtent + padding * 2
            if (hasDecision) {
                val decW = decisionBoxWidth().toInt() + padding * 2
                w = max(w, decW)
            }

            val topSpace = if (hasDecision) decisionHeight + decisionGap else 0
            val arcHalfHeight = (arcRadius * sinSpread + subR).toInt()
            val h = topSpace + max(bubbleSize, arcHalfHeight * 2) + padding * 2

            currentViewW = w
            currentViewH = h

            bubbleCx = if (subBubblesLeft) {
                (w - padding - mainR).toFloat()
            } else {
                (padding + mainR).toFloat()
            }
            bubbleCy = (topSpace + padding + max(bubbleSize, arcHalfHeight * 2) / 2f)

            scanCx = bubbleCx + (arcRadius * Math.cos(angleScan)).toFloat()
            scanCy = bubbleCy + (arcRadius * Math.sin(angleScan)).toFloat()
            closeCx = bubbleCx + (arcRadius * Math.cos(angleClose)).toFloat()
            closeCy = bubbleCy + (arcRadius * Math.sin(angleClose)).toFloat()

            decisionTopY = padding.toFloat()
        }
        hasLaidOutOnce = true
    }

    private fun applyResize() {
        val lp = layoutParams as? WindowManager.LayoutParams
        val canAnimate = lp != null && windowManager != null && hasLaidOutOnce

        if (!canAnimate) {
            recomputeLayout()
            if (lp != null && windowManager != null) {
                lp.width = currentViewW
                lp.height = currentViewH
                try {
                    windowManager?.updateViewLayout(this, lp)
                } catch (e: Exception) {
                    Log.w("BubbleView", "applyResize initial updateViewLayout failed", e)
                }
            }
            invalidate()
            return
        }

        val oldW = lp!!.width
        val oldH = lp.height
        val oldX = lp.x
        val oldY = lp.y
        val oldBubbleCx = bubbleCx
        val oldBubbleCy = bubbleCy
        val oldScanCx = scanCx
        val oldScanCy = scanCy
        val oldCloseCx = closeCx
        val oldCloseCy = closeCy
        val oldDecisionTopY = decisionTopY
        val oldBubbleScreenX = lp.x + bubbleCx.toInt()
        val oldBubbleScreenY = lp.y + bubbleCy.toInt()

        recomputeLayout()

        val newBubbleCx = bubbleCx
        val newBubbleCy = bubbleCy
        val newScanCx = scanCx
        val newScanCy = scanCy
        val newCloseCx = closeCx
        val newCloseCy = closeCy
        val newDecisionTopY = decisionTopY

        val targetW = currentViewW
        val targetH = currentViewH
        var targetX = oldBubbleScreenX - newBubbleCx.toInt()
        var targetY = oldBubbleScreenY - newBubbleCy.toInt()
        val sw = resources.displayMetrics.widthPixels
        val sh = resources.displayMetrics.heightPixels
        val minX = -newBubbleCx.toInt() + (4 * density).toInt()
        val maxX = sw - newBubbleCx.toInt() - (4 * density).toInt() - bubbleSize / 2
        val minY = -newBubbleCy.toInt() + (4 * density).toInt()
        val maxY = sh - newBubbleCy.toInt() - (4 * density).toInt() - bubbleSize / 2
        targetX = max(minX, min(maxX, targetX))
        targetY = max(minY, min(maxY, targetY))

        val negligible = Math.abs(targetW - oldW) < 4 && Math.abs(targetH - oldH) < 4
        if (negligible) {
            lp.width = targetW
            lp.height = targetH
            lp.x = targetX
            lp.y = targetY
            try {
                windowManager?.updateViewLayout(this, lp)
            } catch (e: Exception) {
                Log.w("BubbleView", "applyResize negligible updateViewLayout failed", e)
            }
            invalidate()
            return
        }

        bubbleCx = oldBubbleCx
        bubbleCy = oldBubbleCy
        scanCx = oldScanCx
        scanCy = oldScanCy
        closeCx = oldCloseCx
        closeCy = oldCloseCy
        decisionTopY = oldDecisionTopY

        resizeAnimator?.cancel()
        val anim = android.animation.ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 160
            interpolator = android.view.animation.DecelerateInterpolator(1.5f)
        }
        resizeAnimator = anim
        anim.addUpdateListener { va ->
            val t = va.animatedValue as Float
            try {
                lp.width = (oldW + (targetW - oldW) * t).toInt()
                lp.height = (oldH + (targetH - oldH) * t).toInt()
                lp.x = (oldX + (targetX - oldX) * t).toInt()
                lp.y = (oldY + (targetY - oldY) * t).toInt()
                bubbleCx = oldBubbleCx + (newBubbleCx - oldBubbleCx) * t
                bubbleCy = oldBubbleCy + (newBubbleCy - oldBubbleCy) * t
                scanCx = oldScanCx + (newScanCx - oldScanCx) * t
                scanCy = oldScanCy + (newScanCy - oldScanCy) * t
                closeCx = oldCloseCx + (newCloseCx - oldCloseCx) * t
                closeCy = oldCloseCy + (newCloseCy - oldCloseCy) * t
                decisionTopY = oldDecisionTopY + (newDecisionTopY - oldDecisionTopY) * t
                windowManager?.updateViewLayout(this, lp)
                invalidate()
            } catch (e: Exception) {
                Log.w("BubbleView", "applyResize anim updateViewLayout failed", e)
                anim.cancel()
            }
        }
        anim.addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: android.animation.Animator) {
                bubbleCx = newBubbleCx
                bubbleCy = newBubbleCy
                scanCx = newScanCx
                scanCy = newScanCy
                closeCx = newCloseCx
                closeCy = newCloseCy
                decisionTopY = newDecisionTopY
                resizeAnimator = null
                invalidate()
            }
        })
        anim.start()
        invalidate()
    }

    private fun decisionCenterX(): Float =
        if (expanded) currentViewW / 2f else bubbleCx

    private fun decisionBoxWidth(): Float {
        val measured = if (decisionText.isNotEmpty())
            decisionTextPaint.measureText(decisionText) + 24 * density
        else decisionMinWidth.toFloat()
        return max(decisionMinWidth.toFloat(), measured)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        recomputeLayout()
    }

    // ── Dessin ──────────────────────────────────────────────────────
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (decisionText.isNotEmpty()) {
            val w = decisionBoxWidth()
            val dcx = decisionCenterX()
            val rect = RectF(
                dcx - w / 2f, decisionTopY,
                dcx + w / 2f, decisionTopY + decisionHeight
            )
            val shadowRect = RectF(rect).apply { offset(1.5f * density, 2 * density) }
            canvas.drawRoundRect(shadowRect, 10 * density, 10 * density, shadowPaint)
            canvas.drawRoundRect(rect, 10 * density, 10 * density, decisionBgPaint)
            val ty = rect.centerY() -
                (decisionTextPaint.descent() + decisionTextPaint.ascent()) / 2
            canvas.drawText(decisionText, rect.centerX(), ty, decisionTextPaint)
        }
        if (expanded) {
            // Sous-bulle SCAN (camera icon) — escape unicode pour robustesse cross-font
            drawSubBubble(canvas, scanCx, scanCy, "📷")
            drawCloseButton(canvas, closeCx, closeCy)
        }
        val r = bubbleSize / 2f
        canvas.drawCircle(bubbleCx + 2 * density, bubbleCy + 3 * density,
                          r + 1 * density, shadowPaint)
        canvas.drawCircle(bubbleCx, bubbleCy, r, bgPaint)
        val ty = bubbleCy - (textPaint.descent() + textPaint.ascent()) / 2
        canvas.drawText("TG", bubbleCx, ty, textPaint)
    }

    private fun drawSubBubble(canvas: Canvas, cx: Float, cy: Float, icon: String) {
        val r = subBubbleSize / 2f
        canvas.drawCircle(cx + 1.5f * density, cy + 2 * density, r, shadowPaint)
        canvas.drawCircle(cx, cy, r, subBubbleBgPaint)
        canvas.drawCircle(cx, cy, r, subBubbleBorderPaint)
        val ty = cy - (subIconPaint.descent() + subIconPaint.ascent()) / 2
        canvas.drawText(icon, cx, ty, subIconPaint)
    }

    private fun drawCloseButton(canvas: Canvas, cx: Float, cy: Float) {
        val r = subBubbleSize / 2f
        canvas.drawCircle(cx + 1.5f * density, cy + 2 * density, r, shadowPaint)
        canvas.drawCircle(cx, cy, r, closeBgPaint)
        val xSize = r * 0.4f
        canvas.drawLine(cx - xSize, cy - xSize, cx + xSize, cy + xSize, closeXPaint)
        canvas.drawLine(cx - xSize, cy + xSize, cx + xSize, cy - xSize, closeXPaint)
    }

    // ── Hit-test ────────────────────────────────────────────────────
    private fun hitTest(x: Float, y: Float): HitZone {
        if (decisionText.isNotEmpty()) {
            val w = decisionBoxWidth()
            val dcx = decisionCenterX()
            if (x in (dcx - w / 2f)..(dcx + w / 2f) &&
                y in decisionTopY..(decisionTopY + decisionHeight)) {
                return HitZone.DECISION
            }
        }
        val mainR = bubbleSize / 2f
        if (distSq(x, y, bubbleCx, bubbleCy) <= mainR * mainR) return HitZone.BUBBLE
        if (expanded) {
            val subR = subBubbleSize / 2f
            val subR2 = subR * subR
            if (distSq(x, y, scanCx, scanCy) <= subR2) return HitZone.SCAN
            if (distSq(x, y, closeCx, closeCy) <= subR2) return HitZone.CLOSE
        }
        return HitZone.NONE
    }

    private fun distSq(x1: Float, y1: Float, x2: Float, y2: Float): Float {
        val dx = x1 - x2; val dy = y1 - y2; return dx * dx + dy * dy
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val params = layoutParams as? WindowManager.LayoutParams ?: return false

        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                hitZone = hitTest(event.x, event.y)
                if (hitZone == HitZone.NONE) return false
                initialX = params.x
                initialY = params.y
                initialTouchX = event.rawX
                initialTouchY = event.rawY
                hasDragged = false
                touchDownTime = System.currentTimeMillis()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (hitZone == HitZone.NONE) return false
                val dx = event.rawX - initialTouchX
                val dy = event.rawY - initialTouchY
                if (!hasDragged && sqrt(dx * dx + dy * dy) > touchSlop) {
                    hasDragged = true
                }
                if (hasDragged && (hitZone == HitZone.BUBBLE || hitZone == HitZone.DECISION)) {
                    params.x = (initialX + dx).toInt()
                    params.y = (initialY + dy).toInt()
                    val sw = resources.displayMetrics.widthPixels
                    val sh = resources.displayMetrics.heightPixels
                    val minX = -bubbleCx.toInt() + (4 * density).toInt()
                    val maxX = sw - bubbleCx.toInt() - (4 * density).toInt() - bubbleSize / 2
                    val minY = -bubbleCy.toInt() + (4 * density).toInt()
                    val maxY = sh - bubbleCy.toInt() - (4 * density).toInt() - bubbleSize / 2
                    params.x = max(minX, min(maxX, params.x))
                    params.y = max(minY, min(maxY, params.y))
                    try {
                        windowManager?.updateViewLayout(this, params)
                    } catch (e: Exception) {
                        Log.w("BubbleView", "drag updateViewLayout failed", e)
                    }
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                if (hitZone == HitZone.NONE) return false
                val duration = System.currentTimeMillis() - touchDownTime
                val isTap = !hasDragged && duration < tapMaxDuration
                if (isTap) {
                    when (hitZone) {
                        HitZone.BUBBLE -> {
                            toggleExpanded()
                            onBubbleTap?.invoke()
                        }
                        HitZone.SCAN -> onScanTap?.invoke()
                        HitZone.CLOSE -> onCloseRequested?.invoke()
                        HitZone.DECISION -> toggleExpanded()
                        HitZone.NONE -> {}
                    }
                } else if (hasDragged &&
                           (hitZone == HitZone.BUBBLE || hitZone == HitZone.DECISION)) {
                    snapToEdge(params)
                }
                hitZone = HitZone.NONE
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                hitZone = HitZone.NONE
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    private fun snapToEdge(params: WindowManager.LayoutParams) {
        val screenW = resources.displayMetrics.widthPixels
        val currentBubbleScreenX = params.x + bubbleCx.toInt()
        val targetBubbleScreenX = if (currentBubbleScreenX < screenW / 2) {
            (bubbleSize / 2 + 8 * density).toInt()
        } else {
            screenW - bubbleSize / 2 - (8 * density).toInt()
        }
        val targetParamsX = targetBubbleScreenX - bubbleCx.toInt()
        val anim = android.animation.ValueAnimator.ofInt(params.x, targetParamsX)
        anim.duration = 200
        anim.addUpdateListener { va ->
            params.x = va.animatedValue as Int
            try { windowManager?.updateViewLayout(this, params) } catch (_: Exception) {}
        }
        anim.start()
    }
}
