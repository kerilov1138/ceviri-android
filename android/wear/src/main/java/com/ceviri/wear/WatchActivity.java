package com.ceviri.wear;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.android.gms.wearable.MessageClient;
import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;

/**
 * CEVIRI saat ekrani (Galaxy Watch / Wear OS).
 *
 * Canli Dongu ve Yuz Yuze: saatin mikrofonu SENI dinler, yaziya dokup telefona
 * yollar; telefon cevirip seslendirir. Karsidaki telefona konusur.
 * Online Oda: son mesaj, "Konus / Durdur" (telefon mikrofonu) ve kapida
 * bekleyenler icin "Kabul et / Reddet".
 * Telefon konusurken saat dinlemeyi duraklatir (yanki olmasin).
 */
public class WatchActivity extends Activity implements MessageClient.OnMessageReceivedListener {

    private static final int REQ_MIC = 1;
    private static final int REQ_VOICE = 2;

    private TextView modeText;
    private TextView lastWho;
    private TextView lastText;
    private TextView statusText;
    private Button micBtn;
    private Button closeBtn;
    private LinearLayout lobbyBox;

    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private boolean recognizerAvailable;

    private String mode = "";
    private String myLang = "tr-TR";
    private JSONObject ui = new JSONObject();
    private String mainLabel = "";
    private String lastId = "";
    private boolean connected = false;

    private boolean listening = false; // kullanici saatten dinlemeyi acti
    private boolean busy = false; // tanima su an calisiyor
    private boolean phoneSpeaking = false; // telefon ceviriyi seslendiriyor
    private int errorStreak = 0;
    private String error = "";
    private final Runnable startTask = this::startRecognition;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_watch);
        modeText = findViewById(R.id.modeText);
        lastWho = findViewById(R.id.lastWho);
        lastText = findViewById(R.id.lastText);
        statusText = findViewById(R.id.statusText);
        micBtn = findViewById(R.id.micBtn);
        closeBtn = findViewById(R.id.closeBtn);
        lobbyBox = findViewById(R.id.lobbyBox);

        recognizerAvailable = SpeechRecognizer.isRecognitionAvailable(this);
        micBtn.setOnClickListener(v -> onMicTap());
        closeBtn.setOnClickListener(v -> {
            sendToPhone("/ceviri/close", "");
            stopListening();
            finish();
        });
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
        }
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        Wearable.getMessageClient(this).addListener(this);
        sendToPhone("/ceviri/hello", ""); // telefon son durumu yollasin
    }

    @Override
    protected void onPause() {
        super.onPause();
        Wearable.getMessageClient(this).removeListener(this);
        stopListening();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (recognizer != null) {
            try { recognizer.destroy(); } catch (Exception ignored) {}
            recognizer = null;
        }
    }

    // ------------------------------------------------------------ yardimcilar

    private String s(String key, String def) {
        String v = ui.optString(key, "");
        return v.isEmpty() ? def : v;
    }

    private void sendToPhone(String path, String data) {
        final byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
        Wearable.getNodeClient(this).getConnectedNodes()
            .addOnSuccessListener(nodes -> {
                connected = !nodes.isEmpty();
                for (Node n : nodes) Wearable.getMessageClient(this).sendMessage(n.getId(), path, bytes);
                if (!connected) render();
            })
            .addOnFailureListener(e -> { connected = false; render(); });
    }

    private void vibrate() {
        try {
            Vibrator v = getSystemService(Vibrator.class);
            if (v != null) v.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE));
        } catch (Exception ignored) {}
    }

    private boolean watchMicMode() {
        return "loop".equals(mode) || "face".equals(mode);
    }

    // ---------------------------------------------------------- telefondan mesaj

    @Override
    public void onMessageReceived(MessageEvent event) {
        final String path = event.getPath();
        final String data = event.getData() == null ? "" : new String(event.getData(), StandardCharsets.UTF_8);
        main.post(() -> {
            if ("/ceviri/state".equals(path)) {
                applyState(data);
            } else if ("/ceviri/speaking".equals(path)) {
                phoneSpeaking = "1".equals(data);
                if (phoneSpeaking) {
                    cancelRecognition();
                } else if (listening) {
                    main.postDelayed(startTask, 450);
                }
                render();
            } else if ("/ceviri/finish".equals(path)) {
                stopListening();
                finish();
            }
        });
    }

    private void applyState(String json) {
        try {
            JSONObject st = new JSONObject(json);
            connected = true;
            String newMode = st.optString("mode", "");
            if (!newMode.equals(mode)) {
                stopListening();
                mode = newMode;
            }
            myLang = st.optString("myLang", myLang);
            JSONObject u = st.optJSONObject("ui");
            if (u != null) ui = u;
            mainLabel = st.optString("mainLabel", "");
            modeText.setText(st.optString("title", ""));

            JSONObject last = st.optJSONObject("last");
            if (last != null) {
                lastWho.setText(last.optString("who", ""));
                lastWho.setTextColor("me".equals(last.optString("side")) ? 0xFF34D399 : 0xFF818CF8);
                lastText.setText(last.optString("text", ""));
                String id = last.optString("id", "");
                if (!lastId.isEmpty() && !id.equals(lastId) && !"me".equals(last.optString("side"))) vibrate();
                lastId = id;
            } else {
                lastWho.setText("");
                lastText.setText(s("hint", ""));
            }

            // Oda sahibi icin kapida bekleyenler
            lobbyBox.removeAllViews();
            JSONArray lobby = st.optJSONArray("lobby");
            if (lobby != null) {
                for (int i = 0; i < lobby.length(); i++) {
                    JSONObject p = lobby.getJSONObject(i);
                    addLobbyRow(p.optString("id"), p.optString("text"));
                }
            }
            render();
        } catch (Exception ignored) {
            // bozuk mesaj
        }
    }

    private void addLobbyRow(final String id, String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(0xFFFACC15);
        tv.setTextSize(12);
        tv.setGravity(Gravity.CENTER);
        lobbyBox.addView(tv);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.addView(lobbyButton(s("accept", "OK"), 0xFF34D399, () -> sendLobby(id, true)));
        row.addView(lobbyButton(s("reject", "X"), 0xFFFCA5A5, () -> sendLobby(id, false)));
        lobbyBox.addView(row);
    }

    private Button lobbyButton(String label, int color, Runnable onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(11);
        b.setTextColor(color);
        b.setBackgroundResource(R.drawable.small_button);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(34));
        lp.setMargins(dp(3), dp(3), dp(3), dp(3));
        b.setLayoutParams(lp);
        b.setPadding(dp(10), 0, dp(10), 0);
        b.setOnClickListener(v -> onClick.run());
        return b;
    }

    private void sendLobby(String id, boolean accept) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("accept", accept);
            sendToPhone("/ceviri/lobby", o.toString());
        } catch (Exception ignored) {}
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ------------------------------------------------------------------ ekran

    private void render() {
        closeBtn.setText(s("close", "⌚ ✕"));
        if (!connected && mode.isEmpty()) {
            micBtn.setVisibility(View.GONE);
            statusText.setText(s("connecting", "…"));
            return;
        }
        if (watchMicMode()) {
            micBtn.setVisibility(View.VISIBLE);
            micBtn.setSelected(listening);
            micBtn.setText(listening ? s("stop", "⏹") : s("speakMe", "🎙"));
            if (!error.isEmpty()) statusText.setText(error);
            else if (listening && phoneSpeaking) statusText.setText(s("phoneSpeaking", "…"));
            else if (listening) statusText.setText(s("listening", "…"));
            else statusText.setText(s("tapToSpeak", ""));
        } else if ("online".equals(mode)) {
            micBtn.setVisibility(View.VISIBLE);
            micBtn.setSelected(false);
            micBtn.setText(mainLabel);
            statusText.setText("");
        } else {
            micBtn.setVisibility(View.GONE);
            statusText.setText("");
        }
        if (listening) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    // ------------------------------------------------------------- mikrofon

    private void onMicTap() {
        if ("online".equals(mode)) {
            sendToPhone("/ceviri/toggle", ""); // telefonun mikrofonu
            return;
        }
        if (!watchMicMode()) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
            return;
        }
        error = "";
        if (!recognizerAvailable) {
            // Saatte dogrudan tanima yoksa sistemin ses girisi ekranini kullan
            launchVoiceInput();
            return;
        }
        if (listening) {
            stopListening();
        } else {
            listening = true;
            errorStreak = 0;
            startRecognition();
        }
        render();
    }

    private void launchVoiceInput() {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, myLang);
        try {
            startActivityForResult(i, REQ_VOICE);
        } catch (ActivityNotFoundException e) {
            error = s("noSpeech", "!");
            render();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_VOICE || resultCode != RESULT_OK || data == null) return;
        ArrayList<String> res = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (res != null && !res.isEmpty() && !res.get(0).trim().isEmpty()) {
            sendToPhone("/ceviri/utterance", res.get(0).trim());
        }
    }

    private void startRecognition() {
        if (!listening || busy || phoneSpeaking || isFinishing()) return;
        try {
            if (recognizer == null) {
                recognizer = SpeechRecognizer.createSpeechRecognizer(this);
                recognizer.setRecognitionListener(listener);
            }
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, myLang);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            busy = true;
            recognizer.startListening(i);
        } catch (Exception e) {
            busy = false;
            retryLater();
        }
    }

    private void cancelRecognition() {
        if (recognizer != null && busy) {
            try { recognizer.cancel(); } catch (Exception ignored) {}
        }
        busy = false;
    }

    private void stopListening() {
        listening = false;
        main.removeCallbacks(startTask);
        cancelRecognition();
        render();
    }

    private void retryLater() {
        errorStreak++;
        if (errorStreak > 6) {
            // Surekli hata: dinlemeyi birak, kullaniciya soyle
            error = s("noSpeech", "!");
            listening = false;
            render();
            return;
        }
        main.postDelayed(startTask, Math.min(400L * errorStreak, 2000L));
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override public void onReadyForSpeech(Bundle params) {}
        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onPartialResults(Bundle partialResults) {}
        @Override public void onEvent(int eventType, Bundle params) {}

        @Override
        public void onResults(Bundle results) {
            busy = false;
            errorStreak = 0;
            ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty() && !list.get(0).trim().isEmpty()) {
                sendToPhone("/ceviri/utterance", list.get(0).trim());
            }
            if ("face".equals(mode)) {
                // Yuz Yuze: bir dokunus = bir cumle
                listening = false;
                render();
                return;
            }
            main.postDelayed(startTask, 250);
        }

        @Override
        public void onError(int code) {
            busy = false;
            if (!listening) return;
            if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                errorStreak = 0;
                if ("face".equals(mode)) {
                    listening = false;
                    render();
                    return;
                }
                main.postDelayed(startTask, 300);
                return;
            }
            if (code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                listening = false;
                render();
                requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
                return;
            }
            if (code == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || code == SpeechRecognizer.ERROR_CLIENT) {
                try { recognizer.destroy(); } catch (Exception ignored) {}
                recognizer = null;
            }
            retryLater();
        }
    };
}
