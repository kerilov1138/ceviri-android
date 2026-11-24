package com.ceviri.app;

import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.nl.languageid.IdentifiedLanguage;
import com.google.mlkit.nl.languageid.LanguageIdentification;
import com.google.mlkit.nl.languageid.LanguageIdentificationOptions;
import com.google.mlkit.nl.languageid.LanguageIdentifier;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.TranslateRemoteModel;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;

import java.util.HashMap;
import java.util.Map;

/**
 * CEVIRI yerel araclari:
 *  - Cevrimdisi ceviri (Google ML Kit, dil paketleri cihaza indirilir)
 *  - Metnin dilini tanima (konusani dilden anlamak icin)
 *  - Kulaklik dugmesi (oynat/duraklat) ile konusmayi baslat/durdur
 *  - Canli ceviri sirasinda ekran acik kalsin
 *  - Konusma dokumunu PDF olarak kaydetme (sistemin yazdir / PDF kaydet ekrani)
 */
@CapacitorPlugin(name = "CeviriTools")
public class CeviriToolsPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Translator> translators = new HashMap<>();
    private LanguageIdentifier languageId;
    private MediaSession session;
    private boolean mediaWanted = false;
    private long lastButtonAt = 0;
    private WebView printWebView;

    // ------------------------------------------------------------------ ceviri

    private static String mlCode(String tag) {
        if (tag == null) return null;
        String t = tag.trim();
        if (t.isEmpty()) return null;
        String base = t.split("[-_]")[0].toLowerCase();
        if (base.equals("iw")) base = "he";
        if (base.equals("nb") || base.equals("nn")) base = "no";
        return TranslateLanguage.fromLanguageTag(base);
    }

    @PluginMethod
    public void offlineSupported(PluginCall call) {
        String code = mlCode(call.getString("lang", ""));
        JSObject ret = new JSObject();
        ret.put("supported", code != null);
        ret.put("code", code == null ? "" : code);
        call.resolve(ret);
    }

    @PluginMethod
    public void offlineModels(PluginCall call) {
        RemoteModelManager.getInstance()
            .getDownloadedModels(TranslateRemoteModel.class)
            .addOnSuccessListener(models -> {
                JSArray arr = new JSArray();
                arr.put(TranslateLanguage.ENGLISH); // Ingilizce her zaman cihazda
                for (TranslateRemoteModel m : models) {
                    if (!TranslateLanguage.ENGLISH.equals(m.getLanguage())) arr.put(m.getLanguage());
                }
                JSObject ret = new JSObject();
                ret.put("languages", arr);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject("models", e));
    }

    @PluginMethod
    public void downloadOffline(PluginCall call) {
        String code = mlCode(call.getString("lang", ""));
        if (code == null) {
            call.reject("unsupported");
            return;
        }
        if (TranslateLanguage.ENGLISH.equals(code)) {
            call.resolve();
            return;
        }
        TranslateRemoteModel model = new TranslateRemoteModel.Builder(code).build();
        RemoteModelManager.getInstance()
            .download(model, new DownloadConditions.Builder().build())
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject("download", e));
    }

    @PluginMethod
    public void deleteOffline(PluginCall call) {
        String code = mlCode(call.getString("lang", ""));
        if (code == null || TranslateLanguage.ENGLISH.equals(code)) {
            call.resolve();
            return;
        }
        TranslateRemoteModel model = new TranslateRemoteModel.Builder(code).build();
        RemoteModelManager.getInstance()
            .deleteDownloadedModel(model)
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject("delete", e));
    }

    @PluginMethod
    public void translateOffline(PluginCall call) {
        final String text = call.getString("text", "");
        final String src = mlCode(call.getString("source", ""));
        final String tgt = mlCode(call.getString("target", ""));
        if (src == null || tgt == null) {
            call.reject("OFFLINE_UNSUPPORTED");
            return;
        }
        if (src.equals(tgt)) {
            JSObject ret = new JSObject();
            ret.put("text", text);
            call.resolve(ret);
            return;
        }
        // Paket yoksa ceviri sessizce indirmeye kalkmasin: once kontrol et
        RemoteModelManager.getInstance()
            .getDownloadedModels(TranslateRemoteModel.class)
            .addOnSuccessListener(models -> {
                boolean haveSrc = TranslateLanguage.ENGLISH.equals(src);
                boolean haveTgt = TranslateLanguage.ENGLISH.equals(tgt);
                for (TranslateRemoteModel m : models) {
                    if (m.getLanguage().equals(src)) haveSrc = true;
                    if (m.getLanguage().equals(tgt)) haveTgt = true;
                }
                if (!haveSrc || !haveTgt) {
                    call.reject("OFFLINE_MODEL_MISSING");
                    return;
                }
                String key = src + ">" + tgt;
                Translator tr = translators.get(key);
                if (tr == null) {
                    tr = Translation.getClient(new TranslatorOptions.Builder()
                        .setSourceLanguage(src)
                        .setTargetLanguage(tgt)
                        .build());
                    translators.put(key, tr);
                }
                tr.translate(text)
                    .addOnSuccessListener(out -> {
                        JSObject ret = new JSObject();
                        ret.put("text", out);
                        call.resolve(ret);
                    })
                    .addOnFailureListener(e -> call.reject("translate", e));
            })
            .addOnFailureListener(e -> call.reject("models", e));
    }

    // ------------------------------------------------------------ dil tanima

    @PluginMethod
    public void identifyLanguage(PluginCall call) {
        String text = call.getString("text", "");
        if (languageId == null) {
            languageId = LanguageIdentification.getClient(
                new LanguageIdentificationOptions.Builder().setConfidenceThreshold(0.05f).build());
        }
        languageId.identifyPossibleLanguages(text)
            .addOnSuccessListener(list -> {
                JSArray arr = new JSArray();
                for (IdentifiedLanguage il : list) {
                    JSObject o = new JSObject();
                    o.put("lang", il.getLanguageTag());
                    o.put("confidence", il.getConfidence());
                    arr.put(o);
                }
                JSObject ret = new JSObject();
                ret.put("languages", arr);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject("identify", e));
    }

    // ------------------------------------------------------- ekran acik kalsin

    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    // ------------------------------------------------------- kulaklik dugmesi

    @PluginMethod
    public void setMediaButtons(PluginCall call) {
        mediaWanted = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        main.post(() -> {
            if (mediaWanted) startSession();
            else stopSession();
            call.resolve();
        });
    }

    private void startSession() {
        if (session == null) {
            session = new MediaSession(getContext(), "CEVIRI");
            session.setCallback(new MediaSession.Callback() {
                @Override
                public boolean onMediaButtonEvent(Intent intent) {
                    KeyEvent ev = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                    if (ev != null) {
                        int k = ev.getKeyCode();
                        boolean ours = k == KeyEvent.KEYCODE_HEADSETHOOK
                            || k == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                            || k == KeyEvent.KEYCODE_MEDIA_PLAY
                            || k == KeyEvent.KEYCODE_MEDIA_PAUSE;
                        if (ours) {
                            if (ev.getAction() == KeyEvent.ACTION_DOWN && ev.getRepeatCount() == 0) fireButton();
                            return true;
                        }
                    }
                    return super.onMediaButtonEvent(intent);
                }

                @Override public void onPlay() { fireButton(); }
                @Override public void onPause() { fireButton(); }
            });
            session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE)
                .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                .build());
        }
        if (!session.isActive()) {
            session.setActive(true);
            claimMediaButtons();
        }
    }

    private void stopSession() {
        if (session != null) {
            try { session.setActive(false); } catch (Exception ignored) {}
            try { session.release(); } catch (Exception ignored) {}
            session = null;
        }
    }

    private void fireButton() {
        long now = System.currentTimeMillis();
        if (now - lastButtonAt < 400) return; // bazi kulakliklar ayni basista iki olay yollar
        lastButtonAt = now;
        notifyListeners("mediaButton", new JSObject());
    }

    // Android dugmeleri en son ses calan uygulamaya yollar: cok kisa sessizlik cal
    private void claimMediaButtons() {
        try {
            final int rate = 8000;
            final int n = rate / 10;
            final AudioTrack at = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build())
                .setAudioFormat(new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build())
                .setBufferSizeInBytes(n * 2)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build();
            at.write(new short[n], 0, n);
            at.play();
            main.postDelayed(() -> {
                try { at.stop(); } catch (Exception ignored) {}
                at.release();
            }, 400);
        } catch (Exception ignored) {
            // sessizlik calinamadi: dugmeler yine de cogu cihazda gelir
        }
    }

    @Override
    protected void handleOnPause() {
        // Arka planda muzik uygulamalarinin dugmelerini calmayalim
        main.post(this::stopSession);
    }

    @Override
    protected void handleOnResume() {
        main.post(() -> { if (mediaWanted) startSession(); });
    }

    // ------------------------------------------------------------- PDF kaydet

    @PluginMethod
    public void printHtml(PluginCall call) {
        final String html = call.getString("html", "");
        final String name = call.getString("name", "CEVIRI");
        getActivity().runOnUiThread(() -> {
            try {
                WebView wv = new WebView(getActivity());
                wv.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                        PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(name);
                        pm.print(name, adapter, new PrintAttributes.Builder()
                            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                            .build());
                        call.resolve();
                    }
                });
                printWebView = wv; // yazdirma bitene kadar bellekte kalsin
                wv.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            } catch (Exception e) {
                call.reject("print", e);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        for (Translator t : translators.values()) {
            try { t.close(); } catch (Exception ignored) {}
        }
        translators.clear();
        if (languageId != null) languageId.close();
        stopSession();
    }
}
