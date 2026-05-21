/**
 * ScreenScanManager.kt — Capture d'écran via MediaProjection + OCR ML Kit
 *
 * À PLACER DANS :
 *   android/app/src/main/java/studio/deponchy/tradegenius/ScreenScanManager.kt
 *
 * DÉPENDANCE GRADLE à ajouter (app/build.gradle) :
 *   implementation 'com.google.mlkit:text-recognition:16.0.1'
 */
package studio.deponchy.tradegenius

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

data class ScanResult(
    val success: Boolean,
    val ocrText: String? = null,
    val detectedTicker: String? = null,
    val detectedPrice: Double? = null,
    val error: String? = null
)

object ScreenScanManager {

    private const val REQUEST_CODE_PROJECTION = 19999

    private var mediaProjection: MediaProjection? = null
    private var projectionData: Intent? = null
    private var resultCode: Int = 0
    private var pendingCallback: ((ScanResult) -> Unit)? = null

    /**
     * Appelé par le plugin. La 1re fois, demande la permission MediaProjection.
     * Ensuite, capture l'écran et OCR le résultat.
     */
    fun requestScan(activity: Activity, cb: (ScanResult) -> Unit) {
        pendingCallback = cb
        if (mediaProjection == null) {
            // Pas encore de permission → demander
            val pm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
                as MediaProjectionManager
            val intent = pm.createScreenCaptureIntent()
            activity.startActivityForResult(intent, REQUEST_CODE_PROJECTION)
            return
        }
        // Sinon capturer directement
        performCapture(activity, cb)
    }

    /**
     * À appeler depuis MainActivity.onActivityResult.
     * Le user a accordé/refusé la permission MediaProjection.
     */
    fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_CODE_PROJECTION) return
        val cb = pendingCallback ?: return
        if (resultCode != Activity.RESULT_OK || data == null) {
            cb(ScanResult(success = false, error = "Permission refusée"))
            pendingCallback = null
            return
        }
        val pm = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        mediaProjection = pm.getMediaProjection(resultCode, data)
        projectionData = data
        this.resultCode = resultCode
        performCapture(activity, cb)
    }

    private fun performCapture(activity: Activity, cb: (ScanResult) -> Unit) {
        val proj = mediaProjection ?: run {
            cb(ScanResult(success = false, error = "No projection"))
            return
        }
        val metrics = DisplayMetrics()
        activity.windowManager.defaultDisplay.getMetrics(metrics)
        val w = metrics.widthPixels
        val h = metrics.heightPixels
        val density = metrics.densityDpi

        val reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        val virtualDisplay = proj.createVirtualDisplay(
            "tg-capture",
            w, h, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            null
        )

        Handler(Looper.getMainLooper()).postDelayed({
            try {
                val image = reader.acquireLatestImage()
                if (image == null) {
                    cb(ScanResult(success = false, error = "No image captured"))
                    return@postDelayed
                }
                val planes = image.planes
                val buffer = planes[0].buffer
                val pixelStride = planes[0].pixelStride
                val rowStride = planes[0].rowStride
                val rowPadding = rowStride - pixelStride * w
                val bitmap = Bitmap.createBitmap(
                    w + rowPadding / pixelStride, h, Bitmap.Config.ARGB_8888
                )
                bitmap.copyPixelsFromBuffer(buffer)
                image.close()
                virtualDisplay.release()
                reader.close()
                // Lance OCR ML Kit
                runOcr(bitmap, cb)
            } catch (e: Exception) {
                cb(ScanResult(success = false, error = "Capture error: " + e.message))
            }
        }, 200)
    }

    private fun runOcr(bitmap: Bitmap, cb: (ScanResult) -> Unit) {
        val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        val image = InputImage.fromBitmap(bitmap, 0)
        recognizer.process(image)
            .addOnSuccessListener { result ->
                val text = result.text
                // Extraction simple : trouve un ticker probable (3-5 majuscules) et un prix
                val ticker = Regex("\\b[A-Z]{2,6}(/[A-Z]{2,5})?\\b").find(text)?.value
                val priceMatch = Regex("\\d{1,7}[.,]\\d{1,4}").find(text)?.value
                val price = priceMatch?.replace(",", ".")?.toDoubleOrNull()
                cb(ScanResult(
                    success = true,
                    ocrText = text,
                    detectedTicker = ticker,
                    detectedPrice = price
                ))
            }
            .addOnFailureListener { e ->
                cb(ScanResult(success = false, error = "OCR failed: " + e.message))
            }
    }
}
