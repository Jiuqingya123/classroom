import type { ApiError } from '@classroom/shared';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientDeps {
  baseUrl: string;
  getAccessToken(): string | null;
  /** 401 时调一次，成功返回新 access token，失败返回 null */
  refreshAccessToken(): Promise<string | null>;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 极简 REST 客户端。
 * 401 时单飞刷新 access token 并重放一次 —— 多请求同时 401 只会触发一次刷新。
 */
export class ApiClient {
  private inflight: Promise<string | null> | null = null;

  constructor(private readonly deps: ApiClientDeps) {}

  private refreshOnce(): Promise<string | null> {
    if (!this.inflight) {
      this.inflight = this.deps
        .refreshAccessToken()
        .catch(() => null)
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  async request<T>(method: Method, path: string, body?: unknown, retry = true): Promise<T> {
    const token = this.deps.getAccessToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.deps.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      // fetch 对 CORS 拒绝、DNS 失败、连接被拒只会抛同一个 TypeError，
      // 把目标地址带出来，至少能区分「地址写错」和「服务没起」
      const detail = (err as Error).message;
      throw new ApiClientError(
        0,
        'network_error',
        `无法连接服务器 ${this.deps.baseUrl}（${detail}）。请检查服务是否已启动、地址是否正确、CORS 白名单是否包含当前来源`,
      );
    } finally {
      clearTimeout(timer);
    }

    // 没带 access token 的 401 是登录失败（密码错），不能拿 refresh 去“修复”
    if (res.status === 401 && retry && token) {
      const fresh = await this.refreshOnce();
      if (fresh) return this.request<T>(method, path, body, false);
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const data: unknown = text ? safeJson(text) : null;

    if (!res.ok) {
      const e = data as ApiError | null;
      throw new ApiClientError(
        res.status,
        e?.error ?? 'unknown',
        e?.message ?? gatewayHint(res.status, this.deps.baseUrl),
      );
    }
    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, body);
  }
}

/**
 * 5xx 且响应体不是 JSON 时，基本可以断定是「中间有一层网关」在报错，
 * 而不是我们的服务端 —— 我们的错误响应永远是 JSON。
 *
 * 最常见的两种：服务刚重启（几秒内恢复），或者用户本机开了代理/VPN
 * 把请求拦截了，代理连不上上游就回一个 502 的 HTML 页。
 */
function gatewayHint(status: number, baseUrl: string): string {
  if (status === 502 || status === 503 || status === 504) {
    return (
      `网关返回 ${status}：服务可能正在重启，或你本机的代理/VPN 拦截了这个地址。` +
      `先关掉代理软件再重试；也可以在浏览器打开 ${baseUrl}/healthz 自检（正常会返回一段 JSON）`
    );
  }
  return `请求失败（${status}）`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: 'bad_response', message: text.slice(0, 200) };
  }
}
