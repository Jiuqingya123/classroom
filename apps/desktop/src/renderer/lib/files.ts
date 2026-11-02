import type { FileDTO } from '@classroom/shared';
import { tokenHolder } from './api';
import { runtime } from './config';

/**
 * 文件上传与签名 URL 缓存。
 *
 * 图片要直接进 <img src> / Konva.Image，两者都带不了 Authorization 头，
 * 所以服务端给的是「签名 URL」。签名 12 小时过期，这里按过期时间缓存，
 * 过期前 5 分钟重新签，避免课堂上集体 401。
 */

interface CachedUrl {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, CachedUrl>();
const inflight = new Map<string, Promise<void>>();
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function authHeader(): Record<string, string> {
  const token = tokenHolder.access;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function absoluteFileUrl(relPath: string): string {
  return relPath.startsWith('http') ? relPath : `${runtime.serverUrl}${relPath}`;
}

/** 已在缓存里且未临近过期就直接返回，否则返回 null */
export function cachedFileUrl(fileId: string): string | null {
  const hit = cache.get(fileId);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt - REFRESH_MARGIN_MS) return null;
  return absoluteFileUrl(hit.url);
}

export async function uploadImage(
  blob: Blob,
  opts: { roomId?: string; width?: number; height?: number; filename?: string } = {},
): Promise<FileDTO> {
  const qs = new URLSearchParams();
  if (opts.roomId) qs.set('roomId', opts.roomId);
  if (opts.width) qs.set('width', String(Math.round(opts.width)));
  if (opts.height) qs.set('height', String(Math.round(opts.height)));

  const form = new FormData();
  form.append('file', blob, opts.filename ?? 'image.png');

  const res = await fetch(`${runtime.serverUrl}/api/v1/files${qs.size ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: authHeader(),
    body: form,
  });

  if (!res.ok) {
    let message = `上传失败（${res.status}）`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* 非 JSON 响应 */
    }
    throw new Error(message);
  }

  const data = (await res.json()) as { file: FileDTO };
  cache.set(data.file.id, { url: data.file.url, expiresAt: data.file.expiresAt });
  return data.file;
}

/** 批量取签名 URL（一个请求签一批，避免每张图一次往返） */
export async function ensureFileUrls(fileIds: string[]): Promise<void> {
  const need = [...new Set(fileIds)].filter((id) => id && !cachedFileUrl(id));
  if (need.length === 0) return;

  // 同一张图可能被当前页和预取同时需要：复用同一个在途请求，别把签名接口打两遍
  const waits: Promise<void>[] = [];
  const fresh: string[] = [];
  for (const id of need) {
    const pending = inflight.get(id);
    if (pending) waits.push(pending);
    else fresh.push(id);
  }

  if (fresh.length > 0) {
    const task = requestFileUrls(fresh).finally(() => {
      for (const id of fresh) {
        if (inflight.get(id) === task) inflight.delete(id);
      }
    });
    for (const id of fresh) inflight.set(id, task);
    waits.push(task);
  }

  await Promise.all(waits);
}

async function requestFileUrls(ids: string[]): Promise<void> {
  const res = await fetch(`${runtime.serverUrl}/api/v1/files/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ fileIds: ids }),
  });
  if (!res.ok) return;

  const data = (await res.json()) as { urls: Record<string, string> };
  for (const [id, url] of Object.entries(data.urls)) {
    // 服务端不返回逐条过期时间，这里按签名 TTL 保守估计
    cache.set(id, { url, expiresAt: Date.now() + 11 * 60 * 60 * 1000 });
  }
}

export async function ensureFileUrl(fileId: string): Promise<string | null> {
  const hit = cachedFileUrl(fileId);
  if (hit) return hit;
  await ensureFileUrls([fileId]);
  return cachedFileUrl(fileId);
}

export function clearFileUrlCache(): void {
  cache.clear();
}

/** 通用上传：课件、作业附件等非图片场景 */
export async function uploadFile(
  blob: Blob,
  opts: {
    filename?: string;
    roomId?: string;
    courseId?: string;
    purpose?: 'general' | 'avatar' | 'courseware' | 'homework';
  } = {},
): Promise<FileDTO> {
  const qs = new URLSearchParams();
  if (opts.roomId) qs.set('roomId', opts.roomId);
  if (opts.courseId) qs.set('courseId', opts.courseId);
  if (opts.purpose) qs.set('purpose', opts.purpose);

  const form = new FormData();
  form.append('file', blob, opts.filename ?? 'file.bin');

  const res = await fetch(`${runtime.serverUrl}/api/v1/files${qs.size ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: authHeader(),
    body: form,
  });
  if (!res.ok) {
    let message = `上传失败（${res.status}）`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* 非 JSON 响应 */
    }
    throw new Error(message);
  }
  const data = (await res.json()) as { file: FileDTO };
  cache.set(data.file.id, { url: data.file.url, expiresAt: data.file.expiresAt });
  return data.file;
}
