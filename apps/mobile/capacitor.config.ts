import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hcf.classroom',
  appName: 'ClassRoom',
  webDir: 'www',
  // 老师/学生的课堂服务器可能是局域网 http 地址，WebView 必须允许明文与混合内容
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: true,
    // Android 15 起强制 edge-to-edge，WebView 默认会压到手势条下面
    adjustMarginsForEdgeToEdge: 'force',
  },
  plugins: {
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#ffffff',
      overlaysWebView: false,
    },
  },
};

export default config;
