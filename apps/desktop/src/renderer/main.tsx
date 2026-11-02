import { createRoot } from 'react-dom/client';
import App from './App';
import { initRuntime } from './lib/config';
import { initNativeChrome, isNativeApp } from './lib/native';
import './styles.css';

// 平台标识写进 <html data-platform>，样式里据此去掉 macOS 红绿灯的让位
document.documentElement.dataset['platform'] = window.desktop?.platform ?? (isNativeApp() ? 'android' : 'web');
initNativeChrome();

async function boot(): Promise<void> {
  // 先拿到主进程下发的服务器地址，再渲染 —— 避免第一批请求打到错误地址
  await initRuntime();

  const el = document.getElementById('root');
  if (!el) throw new Error('#root 不存在');

  // 刻意不开 StrictMode：dev 下 effect 双跑会让进房流程连两次，服务端会误判重复参会
  createRoot(el).render(<App />);
}

void boot();
