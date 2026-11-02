import { desktopCapturer, systemPreferences, type Session } from 'electron';
import type { ScreenSource, ScreenSourceList } from '../shared/ipc';

/**
 * 用户在选择器里挑的那个源。getDisplayMedia() 本身不接受「选哪个源」的参数，
 * 只能由主进程在 setDisplayMediaRequestHandler 里决定，所以这里用一个一次性交接变量。
 */
let pendingSourceId: string | null = null;

export function setPendingScreenSource(id: string): void {
  pendingSourceId = id;
}

/**
 * Electron 45 的正确做法是 setDisplayMediaRequestHandler。
 * 老写法 `getUserMedia({video:{mandatory:{chromeMediaSource:'desktop'}}})` 已被移除，
 * 继续用会拿到空流或直接抛错。
 */
export function registerDisplayMediaHandler(ses: Session): void {
  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const wanted = pendingSourceId;
      pendingSourceId = null;

      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 },
        });

        const chosen =
          (wanted ? sources.find((s) => s.id === wanted) : undefined) ??
          // 没有指定就优先整个屏幕，实在没有再退到第一个窗口
          sources.find((s) => s.id.startsWith('screen:')) ??
          sources[0];

        if (!chosen) {
          callback({});
          return;
        }
        callback({ video: chosen });
      } catch {
        callback({});
      }
    },
    // 用自己的选择器（能显示缩略图、能区分屏幕与窗口），不用 macOS 原生弹窗
    { useSystemPicker: false },
  );
}

export function screenPermissionGranted(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.getMediaAccessStatus('screen') === 'granted';
}

export async function listScreenSources(): Promise<ScreenSourceList> {
  const platform = process.platform;
  const hasPermission = screenPermissionGranted();

  let sources: ScreenSource[] = [];
  try {
    const raw = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
    sources = raw
      // 自己这个窗口没必要出现在列表里
      .filter((s) => !s.name.includes('ClassRoom'))
      .map((s) => ({
        id: s.id,
        name: s.name || (s.id.startsWith('screen:') ? '整个屏幕' : '窗口'),
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        isScreen: s.id.startsWith('screen:'),
      }));
  } catch {
    sources = [];
  }

  return { hasPermission, platform, sources };
}
