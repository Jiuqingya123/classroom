package com.hcf.classroom;

import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaPermissionsPlugin.class);
        super.onCreate(savedInstanceState);

        // 远端音频/视频必须能自动播放，否则学生进课堂听不到老师
        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setDomStorageEnabled(true);
    }
}
