package com.ceviri.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Kulaklik algilama + "telefondan da cal".
 *
 * Kulaklik (Bluetooth / kablolu / USB) bagliyken Android normalde sesi yalnizca
 * kulakliga verir. speakBoth(), ceviriyi once ses dosyasina cevirir, sonra
 * "alarm" ses turunde calar: Android bu turu ayni anda hem kulakliktan hem
 * telefon hoparlorunden verir. Ses seviyesini telefonun alarm sesi belirler.
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    private AudioManager audioManager;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final List<Runnable> waitingForTts = new ArrayList<>();
    private MediaPlayer player;
    private PluginCall activeCall;
    private int utteranceCounter = 0;
    private final Handler main = new Handler(Looper.getMainLooper());

    private final AudioDeviceCallback deviceCallback = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
            notifyListeners("headsetChange", state());
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
            notifyListeners("headsetChange", state());
        }
    };

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager != null) audioManager.registerAudioDeviceCallback(deviceCallback, main);
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            List<Runnable> run = new ArrayList<>(waitingForTts);
            waitingForTts.clear();
            for (Runnable r : run) r.run();
        });
    }

    private static boolean isHeadset(int type) {
        if (type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
            || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || type == AudioDeviceInfo.TYPE_WIRED_HEADSET
            || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
            || type == AudioDeviceInfo.TYPE_USB_HEADSET) {
            return true;
        }
        if (Build.VERSION.SDK_INT >= 31) {
            return type == AudioDeviceInfo.TYPE_BLE_HEADSET;
        }
        return false;
    }

    private JSObject state() {
        JSObject ret = new JSObject();
        boolean connected = false;
        String name = "";
        if (audioManager != null) {
            for (AudioDeviceInfo d : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                if (isHeadset(d.getType())) {
                    connected = true;
                    CharSequence n = d.getProductName();
                    if (n != null && n.length() > 0) name = n.toString();
                    break;
                }
            }
        }
        ret.put("connected", connected);
        ret.put("name", name);
        return ret;
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void speakBoth(PluginCall call) {
        final String text = call.getString("text", "");
        final String lang = call.getString("lang", "tr-TR");
        final float rate = call.getFloat("rate", 1.0f);
        if (text == null || text.trim().isEmpty()) {
            call.resolve();
            return;
        }
        // Tum ses islemleri ana is parcaciginda (yaris olmasin)
        main.post(() -> {
            stopInternal();
            activeCall = call;
            Runnable work = () -> synthesizeAndPlay(call, text, lang, rate);
            if (ttsReady) work.run();
            else waitingForTts.add(work);
        });
    }

    private void synthesizeAndPlay(PluginCall call, String text, String lang, float rate) {
        if (!ttsReady || tts == null) {
            finish(call, "tts");
            return;
        }
        try {
            tts.setLanguage(Locale.forLanguageTag(lang));
            tts.setSpeechRate(rate);
            final File out = new File(getContext().getCacheDir(), "ceviri_tts.wav");
            final String id = "ceviri-" + (++utteranceCounter);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {}
                @Override public void onDone(String utteranceId) {
                    if (!id.equals(utteranceId)) return;
                    main.post(() -> play(call, out));
                }
                @Override public void onError(String utteranceId) {
                    if (id.equals(utteranceId)) main.post(() -> finish(call, "synth"));
                }
            });
            int r = tts.synthesizeToFile(text, new Bundle(), out, id);
            if (r != TextToSpeech.SUCCESS) finish(call, "synth");
        } catch (Exception e) {
            finish(call, "synth");
        }
    }

    private void play(PluginCall call, File file) {
        if (activeCall != call) return; // bu arada durduruldu ya da yenisi geldi
        try {
            releasePlayer();
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
            player.setDataSource(file.getAbsolutePath());
            player.setOnCompletionListener(mp -> finish(call, null));
            player.setOnErrorListener((mp, what, extra) -> { finish(call, "play"); return true; });
            player.prepare();
            player.start();
        } catch (Exception e) {
            finish(call, "play");
        }
    }

    private void finish(PluginCall call, String error) {
        if (activeCall == call) activeCall = null;
        releasePlayer();
        if (error == null) call.resolve();
        else call.reject(error);
    }

    private void releasePlayer() {
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
    }

    private void stopInternal() {
        PluginCall prev = activeCall;
        activeCall = null;
        try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
        releasePlayer();
        if (prev != null) prev.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            stopInternal();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (audioManager != null) audioManager.unregisterAudioDeviceCallback(deviceCallback);
        stopInternal();
        if (tts != null) tts.shutdown();
    }
}
