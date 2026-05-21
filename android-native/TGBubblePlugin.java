package studio.deponchy.tradegenius;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Plugin Capacitor Trade Genius Bubble — v1.0 (forké du pattern BJ Genius v1.3)
 *
 * Expose au JS :
 *   - checkOverlayPermission()        : { granted: boolean }
 *   - requestOverlayPermission()      : ouvre les settings systeme
 *   - start()                         : demarre le foreground service + bulle
 *   - stop()                          : arrete et retire la bulle
 *   - isRunning()                     : { running: boolean }
 *   - bringToFront()                  : ramene l'app au premier plan
 *   - setDecision({text, color})      : MAJ rectangle decision (ex: "ACHAT" vert)
 *
 * Events emis vers JS :
 *   - bubbleEvent { type: 'scan_tap' }    : tap sur bouton scan
 *   - bubbleEvent { type: 'bubble_tap' }  : tap sur la bulle TG
 *   - bubbleEvent { type: 'close_tap' }   : tap sur la croix de fermeture
 *
 * Usage JS :
 *   const { TGBubble } = window.Capacitor.Plugins;
 *   await TGBubble.start();
 *   TGBubble.addListener('bubbleEvent', ({type}) => {
 *     if (type === 'scan_tap') runScan();
 *   });
 *   await TGBubble.setDecision({ text: 'ACHAT', color: '#22c55e' });
 */
@CapacitorPlugin(name = "TGBubble")
public class TGBubblePlugin extends Plugin {

    private static final String TAG = "TGBubble";

    private BroadcastReceiver bubbleEventReceiver;

    @Override
    public void load() {
        super.load();
        bubbleEventReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, final Intent intent) {
                final String type = intent.getStringExtra(TGBubbleService.EXTRA_EVENT_TYPE);
                if (type == null) return;
                try {
                    getBridge().getActivity().runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                JSObject data = new JSObject();
                                data.put("type", type);
                                notifyListeners("bubbleEvent", data);
                                Log.d(TAG, "Bubble event relayed to JS: " + type);
                            } catch (Exception e) {
                                Log.w(TAG, "notifyListeners failed", e);
                            }
                        }
                    });
                } catch (Exception e) {
                    Log.w(TAG, "Cannot post bubble event to main thread", e);
                }
            }
        };
        IntentFilter filter = new IntentFilter(TGBubbleService.BROADCAST_BUBBLE_EVENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(bubbleEventReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(bubbleEventReceiver, filter);
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        if (bubbleEventReceiver != null) {
            try {
                getContext().unregisterReceiver(bubbleEventReceiver);
            } catch (Exception e) {
                Log.w(TAG, "Receiver unregister failed", e);
            }
            bubbleEventReceiver = null;
        }
    }

    @PluginMethod
    public void checkOverlayPermission(PluginCall call) {
        boolean granted = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            granted = Settings.canDrawOverlays(getContext());
        }
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    // Alias pour compatibilite avec tg-bubble.js qui utilise hasOverlayPermission
    @PluginMethod
    public void hasOverlayPermission(PluginCall call) {
        checkOverlayPermission(call);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                Intent intent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("opened", true);
                ret.put("granted", false);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "Failed to open overlay settings", e);
                call.reject("Cannot open overlay settings: " + e.getMessage());
            }
        } else {
            JSObject ret = new JSObject();
            ret.put("opened", false);
            ret.put("granted", true);
            ret.put("reason", "Permission auto-granted on Android < M");
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && !Settings.canDrawOverlays(getContext())) {
            call.reject("OVERLAY_PERMISSION_DENIED");
            return;
        }
        try {
            Intent intent = new Intent(getContext(), TGBubbleService.class);
            intent.setAction(TGBubbleService.ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("shown", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start bubble service", e);
            call.reject("START_FAILED: " + e.getMessage());
        }
    }

    // Alias pour compatibilite avec tg-bubble.js (showBubble/hideBubble)
    @PluginMethod
    public void showBubble(PluginCall call) {
        start(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), TGBubbleService.class);
            intent.setAction(TGBubbleService.ACTION_STOP);
            getContext().startService(intent);
            JSObject ret = new JSObject();
            ret.put("stopped", true);
            ret.put("hidden", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop bubble service", e);
            call.reject("STOP_FAILED: " + e.getMessage());
        }
    }

    @PluginMethod
    public void hideBubble(PluginCall call) {
        stop(call);
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", TGBubbleService.isRunning());
        call.resolve(ret);
    }

    @PluginMethod
    public void bringToFront(PluginCall call) {
        try {
            Intent intent = getContext().getPackageManager()
                .getLaunchIntentForPackage(getContext().getPackageName());
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                getContext().startActivity(intent);
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.w(TAG, "bringToFront failed", e);
            call.reject("BRING_TO_FRONT_FAILED: " + e.getMessage());
        }
    }

    /**
     * Met a jour le rectangle decision affiche au-dessus de la bulle.
     * Params : { text: "ACHAT", color: "#22c55e" }
     */
    @PluginMethod
    public void setDecision(PluginCall call) {
        final String text = call.getString("text", "");
        final String color = call.getString("color");
        try {
            getBridge().getActivity().runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        TGBubbleService.setDecision(text == null ? "" : text, color);
                    } catch (Exception e) {
                        Log.w(TAG, "setDecision on UI thread failed", e);
                    }
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "Cannot post setDecision to UI thread", e);
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * Stub triggerScan : la bulle emet deja un event scan_tap quand l'user
     * tape sur le bouton scan. Cette methode est conservee pour compatibilite
     * avec l'API window.TGBubble.triggerScan() — elle emet juste l'event.
     */
    @PluginMethod
    public void triggerScan(PluginCall call) {
        try {
            Intent intent = new Intent(TGBubbleService.BROADCAST_BUBBLE_EVENT);
            intent.putExtra(TGBubbleService.EXTRA_EVENT_TYPE, TGBubbleService.EVENT_SCAN_TAP);
            intent.setPackage(getContext().getPackageName());
            getContext().sendBroadcast(intent);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("TRIGGER_SCAN_FAILED: " + e.getMessage());
        }
    }
}
