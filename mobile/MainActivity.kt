/**
 * MainActivity.kt — Entrée Android, enregistre le plugin BubbleOverlay
 *
 * À PLACER DANS :
 *   android/app/src/main/java/studio/deponchy/tradegenius/MainActivity.kt
 *
 * REMPLACE le MainActivity par défaut généré par `npx cap add android`.
 */
package studio.deponchy.tradegenius

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {

    private var bubblePlugin: BubbleOverlayPlugin? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(BubbleOverlayPlugin::class.java)
        super.onCreate(savedInstanceState)
        // Récupère l'instance du plugin pour le bridge BubbleService
        bubblePlugin = bridge.getPlugin("BubbleOverlay")?.instance as? BubbleOverlayPlugin
        bubblePlugin?.let { TradeGeniusBridge.register(it) }
    }

    /**
     * Réceptionne le résultat MediaProjection et le transmet au manager.
     */
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        ScreenScanManager.onActivityResult(this, requestCode, resultCode, data)
    }

    override fun onDestroy() {
        TradeGeniusBridge.unregister()
        super.onDestroy()
    }
}
