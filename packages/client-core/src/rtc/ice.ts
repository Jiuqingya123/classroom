import type { IceServerConfig, IceServersResponse } from '@classroom/shared';

/**
 * ICE 配置获取 + 缓存。
 *
 * TURN 凭据是短效的（默认 1 小时），但每次建连接都去请求一次纯属浪费；
 * 也不能永久缓存 —— 过期后 TURN 会鉴权失败，表现是「能连的还能连，新来的人连不上」，
 * 极难理解。所以在过期前 5 分钟主动刷新。
 */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class IceProvider {
  private cached: { servers: IceServerConfig[]; expiresAt: number } | null = null;
  private inflight: Promise<IceServerConfig[]> | null = null;

  constructor(private readonly fetchConfig: () => Promise<IceServersResponse>) {}

  async get(): Promise<IceServerConfig[]> {
    if (this.cached && Date.now() < this.cached.expiresAt - REFRESH_MARGIN_MS) {
      return this.cached.servers;
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const res = await this.fetchConfig();
        this.cached = {
          servers: res.iceServers,
          expiresAt: Date.now() + Math.max(60, res.ttlSeconds) * 1000,
        };
        return res.iceServers;
      } catch {
        // 拿不到就退回公共 STUN：同网段/非对称 NAT 下仍然可用，总比完全没有 ICE 好
        const fallback: IceServerConfig[] = [{ urls: 'stun:stun.l.google.com:19302' }];
        this.cached = { servers: fallback, expiresAt: Date.now() + 60_000 };
        return fallback;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  hasTurn(): boolean {
    return (this.cached?.servers ?? []).some((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:'));
    });
  }

  get count(): number {
    return this.cached?.servers.length ?? 0;
  }

  invalidate(): void {
    this.cached = null;
  }
}
