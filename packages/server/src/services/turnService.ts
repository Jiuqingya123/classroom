import { createHmac } from 'node:crypto';
import type { IceServerConfig, IceServersResponse } from '@classroom/shared';
import type { Config } from '../config';

/**
 * TURN 凭据动态签发（coturn `use-auth-secret` 模式）。
 *
 * 为什么不硬编码：凭据会随 dmg 分发给每个学生 = 永久泄露，无法撤销、无法按用户封禁、无法设 TTL。
 * 这里用静态密钥 + HMAC-SHA1 派生短期凭据，coturn 侧无需数据库即可校验。
 */
export interface TurnService {
  iceServersFor(userId: string): IceServersResponse;
}

const FALLBACK_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

export function createTurnService(config: Config): TurnService {
  const { turn } = config;
  const enabled = turn.host.length > 0 && turn.secret.length > 0;

  return {
    iceServersFor(userId) {
      if (!enabled) {
        return {
          iceServers: [{ urls: FALLBACK_STUN }],
          ttlSeconds: turn.ttl,
          policy: 'all',
        };
      }

      const expiry = Math.floor(Date.now() / 1000) + turn.ttl;
      const username = `${expiry}:${userId}`;
      const credential = createHmac('sha1', turn.secret).update(username).digest('base64');

      const servers: IceServerConfig[] = [
        { urls: [`stun:${turn.host}:${turn.port}`] },
        {
          // 两种传输都挂在 3478 上：udp 优先，tcp 是 UDP 被封的网络里的兜底。
          // 不用 5349 —— 那是 coturn 的 TLS 端口，明文 TCP 打过去会被拒；
          // 而且很多安全组只放行了 3478。要用 TLS 必须额外配证书并改成 turns:。
          urls: [
            `turn:${turn.host}:${turn.port}?transport=udp`,
            `turn:${turn.host}:${turn.port}?transport=tcp`,
          ],
          username,
          credential,
        },
      ];

      return { iceServers: servers, ttlSeconds: turn.ttl, policy: 'all' };
    },
  };
}
