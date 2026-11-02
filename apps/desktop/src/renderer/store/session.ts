import { create } from 'zustand';
import type { AuthResult, AuthTokens, RegisterInput, UserDTO } from '@classroom/shared';
import { getApi, tokenHolder } from '../lib/api';
import { runtime } from '../lib/config';
import { useNav } from './nav';

const API = '/api/v1';
const REFRESH_TIMEOUT_MS = 12_000;
const REFRESH_KEY = 'classroom.refreshToken';

let refreshToken: string | null = null;
/** 全局单飞：socket 握手与 REST 401 同时刷新时只能有一个请求 */
let refreshInflight: Promise<string | null> | null = null;
/** 由 room store 注册：登录态失效时必须先离开课堂，避免 socket/媒体流继续挂着 */
let authLostHandler: (() => void) | null = null;

export function setAuthLostHandler(fn: (() => void) | null): void {
  authLostHandler = fn;
}

async function persistRefresh(token: string | null): Promise<void> {
  refreshToken = token;
  if (window.desktop) {
    try {
      await window.desktop.setRefreshToken(token);
    } catch {
      /* 落盘失败不阻塞登录，内存里仍然可用 */
    }
    return;
  }
  // 浏览器 / Android 没有主进程，退化为 localStorage。
  // 未加密，只保存 refresh token；access token 始终只在内存里。
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* 存储不可用时不阻塞登录 */
  }
}

function readStoredRefresh(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

interface SessionState {
  status: 'booting' | 'anon' | 'authed';
  user: UserDTO | null;
  tokens: AuthTokens | null;
  error: string | null;
  busy: boolean;
  bootstrap(): Promise<void>;
  login(email: string, password: string): Promise<boolean>;
  register(input: RegisterInput): Promise<boolean>;
  logout(): Promise<void>;
  clearError(): void;
  setUser(user: UserDTO): void;
  /** socket 重连时要用最新的 rtc token */
  rtcToken(): string | null;
}

export const useSession = create<SessionState>((set, get) => {
  async function applyAuth(result: AuthResult): Promise<void> {
    tokenHolder.access = result.tokens.accessToken;
    await persistRefresh(result.tokens.refreshToken);
    set({ status: 'authed', user: result.user, tokens: result.tokens, busy: false, error: null });
  }

  function clearAuth(): void {
    tokenHolder.access = null;
    void persistRefresh(null);
    authLostHandler?.();
    set({ status: 'anon', user: null, tokens: null });
    useNav.getState().goLobby();
  }

  /**
   * 与 ApiClient 的约定：401 时调用这里换新 access token；失败则回到登录页。
   *
   * 这里必须用裸 fetch，不能走 ApiClient —— /auth/refresh 自己返回 401 时会再次
   * 触发 ApiClient 的 401 刷新，而那次刷新又在等当前这次，形成自等待死锁。
   */
  tokenHolder.refresh = () => {
    if (refreshInflight) return refreshInflight;
    const token = refreshToken;
    if (!token) return Promise.resolve(null);

    refreshInflight = (async (): Promise<string | null> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
      try {
        const res = await fetch(`${runtime.serverUrl}${API}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refreshToken: token }),
          signal: ctrl.signal,
        });
        if (!res.ok) return null;
        const result = (await res.json()) as AuthResult;
        // 请求期间用户已登出/换了账号：不要把旧会话写回来
        if (refreshToken !== token) return null;
        await applyAuth(result);
        return result.tokens.accessToken;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      refreshInflight = null;
    });

    return refreshInflight;
  };

  tokenHolder.onAuthLost = clearAuth;

  return {
    status: 'booting',
    user: null,
    tokens: null,
    error: null,
    busy: false,

    async bootstrap() {
      let stored: string | null = null;
      if (window.desktop) {
        try {
          stored = await window.desktop.getRefreshToken();
        } catch {
          stored = null;
        }
      } else {
        stored = readStoredRefresh();
      }
      if (!stored) {
        set({ status: 'anon' });
        return;
      }
      refreshToken = stored;
      const token = await tokenHolder.refresh?.();
      if (!token) set({ status: 'anon' });
    },

    async login(email, password) {
      set({ busy: true, error: null });
      try {
        const r = await getApi().post<AuthResult>(`${API}/auth/login`, { email, password });
        await applyAuth(r);
        return true;
      } catch (err) {
        set({ busy: false, error: (err as Error).message });
        return false;
      }
    },

    async register(input) {
      set({ busy: true, error: null });
      try {
        const r = await getApi().post<AuthResult>(`${API}/auth/register`, input);
        await applyAuth(r);
        return true;
      } catch (err) {
        set({ busy: false, error: (err as Error).message });
        return false;
      }
    },

    async logout() {
      const token = refreshToken;
      if (token) {
        try {
          await getApi().post(`${API}/auth/logout`, { refreshToken: token });
        } catch {
          /* 服务端不可达也要本地登出 */
        }
      }
      clearAuth();
    },

    clearError() {
      set({ error: null });
    },

    setUser(user) {
      set({ user });
    },

    rtcToken() {
      return get().tokens?.rtcToken ?? null;
    },
  };
});
