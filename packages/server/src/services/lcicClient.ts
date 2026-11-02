import { createHash, createHmac } from 'node:crypto';

const API_VERSION = '2022-08-17';
const SERVICE = 'lcic';

/** 腾讯云 LCIC 返回的业务错误；requestId 用于提工单，不含任何密钥。 */
export class LcicApiError extends Error {
  readonly code: string;
  readonly requestId: string;

  constructor(code: string, message: string, requestId: string) {
    super(message);
    this.name = 'LcicApiError';
    this.code = code;
    this.requestId = requestId;
  }
}

export interface LcicClient {
  call<T extends object>(action: string, payload?: Record<string, unknown>): Promise<T>;
}

interface Tc3Input {
  secretId: string;
  secretKey: string;
  action: string;
  payload: string;
  timestamp: number;
  host: string;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * TC3-HMAC-SHA256 签名。单独导出是为了能用固定时间戳做回归测试，
 * 不依赖腾讯侧网络。
 */
export function buildTc3Headers(input: Tc3Input): Record<string, string> {
  const { secretId, secretKey, action, payload, timestamp, host } = input;
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload),
  ].join('\n');
  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    Authorization:
      `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': contentType,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': API_VERSION,
  };
}

interface LcicEnvelope {
  Error?: { Code?: string; Message?: string };
  RequestId?: string;
}

export interface LcicClientOptions {
  endpoint: string;
  secretId: string;
  secretKey: string;
  timeoutMs?: number;
}

export function createLcicClient(opts: LcicClientOptions): LcicClient {
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    async call<T extends object>(action: string, payload: Record<string, unknown> = {}) {
      const body = JSON.stringify(payload);
      const timestamp = Math.floor(Date.now() / 1000);
      const headers = buildTc3Headers({
        secretId: opts.secretId,
        secretKey: opts.secretKey,
        action,
        payload: body,
        timestamp,
        host: opts.endpoint,
      });

      let res: globalThis.Response;
      try {
        res = await fetch(`https://${opts.endpoint}`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new LcicApiError('NetworkError', `无法连接腾讯云接口：${reason}`, '');
      }

      const text = await res.text();
      let envelope: LcicEnvelope & { Response?: LcicEnvelope & T };
      try {
        envelope = JSON.parse(text) as typeof envelope;
      } catch {
        throw new LcicApiError('BadResponse', `腾讯云返回了非 JSON 响应（HTTP ${res.status}）`, '');
      }

      const response = envelope.Response;
      if (!response) {
        throw new LcicApiError('BadResponse', '腾讯云响应缺少 Response 字段', '');
      }
      if (response.Error) {
        throw new LcicApiError(
          response.Error.Code ?? 'UnknownError',
          response.Error.Message ?? '腾讯云返回未知错误',
          response.RequestId ?? '',
        );
      }
      if (!res.ok) {
        throw new LcicApiError('HttpError', `腾讯云 HTTP ${res.status}`, response.RequestId ?? '');
      }
      return response as unknown as T;
    },
  };
}
