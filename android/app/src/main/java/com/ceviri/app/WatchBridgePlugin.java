package com.ceviri.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.wear.remote.interactions.RemoteActivityHelper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.wearable.CapabilityClient;
import com.google.android.gms.wearable.MessageClient;
import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Telefon <-> Galaxy Watch (Wear OS) koprusu.
 *
 *  - Saatte CEVIRI saat uygulamasi kuruluysa: uygulamayi saatte acar, son
 *    ceviriyi / durumu gonderir, saatten gelen konusmayi ("Ben") alir.
 *  - Kurulu degilse: ceviriyi ve dugmeleri bir bildirimle gosterir; Android bu
 *    bildirimi bagli saate de yansitir (saatteki dugmeler telefonda calisir).
 *
 * Saat uygulamasi ayni paket adi (com.ceviri.app) ve ayni imza anahtariyla
 * derlenir; Google'in saat-telefon baglantisi bunu sart kosar.
 */
@CapacitorPlugin(
    name = "WatchBridge",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class WatchBridgePlugin extends Plugin implements MessageClient.OnMessageReceivedListener {

    private static final String CAPABILITY = "ceviri_watch";
    private static final String CHANNEL = "ceviri_watch";
    private static final String CHANNEL_LOBBY = "ceviri_watch_lobby";
    private static final String ACTION = "com.ceviri.app.WATCH_ACTION";
    private static final int NOTIF_MAIN = 4101;
    private static final int NOTIF_LOBBY = 4102;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final List<String> watchNodes = new ArrayList<>();
    private BroadcastReceiver actionReceiver;
    private int requestCode = 1;
    private String lastLobbyKey = "";

    @Override
    public void load() {
        Wearable.getMessageClient(getContext()).addListener(this);
        actionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                JSObject ev = new JSObject();
                ev.put("id", intent.getStringExtra("id"));
                ev.put("target", intent.getStringExtra("target"));
                notifyListeners("notificationAction", ev);
            }
        };
        ContextCompat.registerReceiver(getContext(), actionReceiver, new IntentFilter(ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    // ------------------------------------------------------------- saatten mesaj

    @Override
    public void onMessageReceived(MessageEvent event) {
        String path = event.getPath();
        if (path == null || !path.startsWith("/ceviri/")) return;
        if (!watchNodes.contains(event.getSourceNodeId())) watchNodes.add(event.getSourceNodeId());
        JSObject ev = new JSObject();
        ev.put("path", path);
        byte[] data = event.getData();
        ev.put("data", data == null ? "" : new String(data, StandardCharsets.UTF_8));
        notifyListeners("watchMessage", ev);
    }

    // ------------------------------------------------------ saat uygulamasi var mi

    @PluginMethod
    public void isWatchAppAvailable(PluginCall call) {
        Wearable.getCapabilityClient(getContext())
            .getCapability(CAPABILITY, CapabilityClient.FILTER_REACHABLE)
            .addOnSuccessListener(info -> {
                Set<Node> nodes = info.getNodes();
                watchNodes.clear();
                for (Node n : nodes) watchNodes.add(n.getId());
                JSObject ret = new JSObject();
                ret.put("available", !nodes.isEmpty());
                call.resolve(ret);
            })
            .addOnFailureListener(e -> {
                // Telefonda Google saat hizmeti yoksa: saat uygulamasi yok say
                JSObject ret = new JSObject();
                ret.put("available", false);
                call.resolve(ret);
            });
    }

    @PluginMethod
    public void openWatchApp(PluginCall call) {
        if (watchNodes.isEmpty()) {
            call.reject("no-watch");
            return;
        }
        RemoteActivityHelper helper = new RemoteActivityHelper(getContext(), executor);
        Intent intent = new Intent(Intent.ACTION_VIEW)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .setData(Uri.parse("ceviri://open"));
        final int[] pending = { watchNodes.size() };
        final boolean[] ok = { false };
        for (String node : new ArrayList<>(watchNodes)) {
            com.google.common.util.concurrent.ListenableFuture<Void> f = helper.startRemoteActivity(intent, node);
            f.addListener(() -> {
                try {
                    f.get();
                    ok[0] = true;
                } catch (Exception ignored) {
                    // bu saatte acilamadi
                }
                synchronized (pending) {
                    pending[0] -= 1;
                    if (pending[0] == 0) {
                        if (ok[0]) call.resolve();
                        else call.reject("open-failed");
                    }
                }
            }, executor);
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        String path = call.getString("path", "/ceviri/state");
        String data = call.getString("data", "");
        if (watchNodes.isEmpty()) {
            call.resolve();
            return;
        }
        byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
        for (String node : new ArrayList<>(watchNodes)) {
            Wearable.getMessageClient(getContext()).sendMessage(node, path, bytes);
        }
        call.resolve();
    }

    // --------------------------------------------------- bildirim (yedek yol)

    @PluginMethod
    public void ensureNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "CEVIRI ⌚", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CHANNEL_LOBBY) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_LOBBY, "CEVIRI ⌚ 🚪", NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(ch);
        }
    }

    private PendingIntent actionIntent(String id, String target) {
        Intent i = new Intent(ACTION).setPackage(getContext().getPackageName());
        i.putExtra("id", id);
        if (target != null) i.putExtra("target", target);
        return PendingIntent.getBroadcast(getContext(), requestCode++ % 1000, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent openAppIntent() {
        Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
        if (launch == null) launch = new Intent();
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(getContext(), 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @PluginMethod
    public void showNotification(PluginCall call) {
        try {
            ensureChannels();
            String title = call.getString("title", "CEVIRI");
            String text = call.getString("text", "");
            NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_ceviri)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setAutoCancel(false)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setContentIntent(openAppIntent());
            JSONArray actions = new JSONArray(call.getString("actions", "[]"));
            for (int i = 0; i < actions.length() && i < 3; i++) {
                JSONObject a = actions.getJSONObject(i);
                b.addAction(0, a.optString("label"), actionIntent(a.optString("id"), null));
            }
            NotificationManagerCompat.from(getContext()).notify(NOTIF_MAIN, b.build());

            // Oda sahibine "kapida bekliyor": ayri, titresimli bildirim
            JSONArray lobby = new JSONArray(call.getString("lobby", "[]"));
            String acceptLabel = call.getString("acceptLabel", "OK");
            String rejectLabel = call.getString("rejectLabel", "X");
            if (lobby.length() == 0) {
                NotificationManagerCompat.from(getContext()).cancel(NOTIF_LOBBY);
                lastLobbyKey = "";
            } else {
                JSONObject first = lobby.getJSONObject(0);
                String key = first.optString("id");
                if (!key.equals(lastLobbyKey)) {
                    lastLobbyKey = key;
                    NotificationCompat.Builder lb = new NotificationCompat.Builder(getContext(), CHANNEL_LOBBY)
                        .setSmallIcon(R.drawable.ic_stat_ceviri)
                        .setContentTitle("CEVIRI")
                        .setContentText(first.optString("text"))
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .setAutoCancel(true)
                        .setContentIntent(openAppIntent())
                        .addAction(0, acceptLabel, actionIntent("accept", key))
                        .addAction(0, rejectLabel, actionIntent("reject", key));
                    NotificationManagerCompat.from(getContext()).notify(NOTIF_LOBBY, lb.build());
                }
            }
            call.resolve();
        } catch (SecurityException e) {
            call.reject("permission");
        } catch (Exception e) {
            call.reject("notify", e);
        }
    }

    @PluginMethod
    public void cancelNotification(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(NOTIF_MAIN);
        NotificationManagerCompat.from(getContext()).cancel(NOTIF_LOBBY);
        lastLobbyKey = "";
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        try { Wearable.getMessageClient(getContext()).removeListener(this); } catch (Exception ignored) {}
        try { getContext().unregisterReceiver(actionReceiver); } catch (Exception ignored) {}
        NotificationManagerCompat.from(getContext()).cancel(NOTIF_MAIN);
        NotificationManagerCompat.from(getContext()).cancel(NOTIF_LOBBY);
        executor.shutdown();
    }
}
