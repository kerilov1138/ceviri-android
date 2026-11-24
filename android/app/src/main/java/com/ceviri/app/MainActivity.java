package com.ceviri.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Kulaklik algilama ve "telefondan da cal" icin uygulamanin kendi eklentisi
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
