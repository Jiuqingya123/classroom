import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { FileDTO } from '@classroom/shared';
import { AppError } from '../lib/errors';
import { signFileUrl, verifyFileUrl } from '../lib/fileToken';
import { requireAuth } from '../plugins/authGuard';

/** 白板贴图、课件库、作业附件共用的白名单 */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/ogg',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);
/** 签名 URL 有效期：够一节课反复用，又不至于永久有效 */
const URL_TTL_MS = 12 * 60 * 60 * 1000;

const UploadQuery = z.object({
  roomId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  purpose: z.enum(['general', 'avatar', 'courseware', 'homework']).optional(),
  width: z.coerce.number().int().positive().max(20000).optional(),
  height: z.coerce.number().int().positive().max(20000).optional(),
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

function storagePath(uploadsDir: string, id: string): string {
  // 按 id 前两位分桶，避免单目录塞几万个文件后 list 变慢
  return resolve(uploadsDir, id.slice(0, 2), id);
}

export const fileApiRoutes: FastifyPluginAsync = async (app) => {
  app.post('/url', { preHandler: [requireAuth] }, async (request) => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();

    const body = z
      .object({ fileIds: z.array(z.string().min(1).max(64)).max(60) })
      .safeParse(request.body);
    if (!body.success) throw AppError.badRequest('bad_request', '参数不正确');

    const out: Record<string, string> = {};
    const isAdmin = claims.role === 'admin';
    for (const id of body.data.fileIds) {
      const row = await app.repos.files.getById(id);
      if (!row) continue;
      let allowed = row.ownerId === claims.sub;
      if (!allowed) {
        if (row.purpose === 'homework') {
          // 作业附件只在本人与课程管理者之间共享；不能按课程可见性放行，
          // 否则同课程学生拿到 fileId 就能绕过作业接口的可见性约束。
          allowed =
            row.courseId !== null &&
            (await app.repos.courses.isManager(row.courseId, claims.sub, isAdmin));
        } else {
          if (row.roomId) {
            allowed = await app.repos.participants.hasJoined(row.roomId, claims.sub);
          }
          if (!allowed && row.courseId) {
            allowed = await app.repos.courses.canView(row.courseId, claims.sub, isAdmin);
          }
        }
      }
      if (!allowed) continue;
      out[id] = signFileUrl(app.appConfig.jwtSecret, id, URL_TTL_MS).url;
    }
    return { urls: out };
  });

  app.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
    const claims = request.claims;
    if (!claims) throw AppError.unauthorized();

    const q = UploadQuery.safeParse(request.query);
    if (!q.success) throw AppError.badRequest('bad_request', '参数不正确');
    const { roomId, width, height } = q.data;
    const courseId = q.data.courseId ?? null;
    const purpose = q.data.purpose ?? 'general';

    // 文件会按 roomId 授权给该课堂的参与者，不能让任意登录用户把文件挂到别人的课堂上
    if (roomId) {
      const room = await app.repos.rooms.findById(roomId);
      if (!room) throw AppError.notFound('课堂不存在');
      if (
        room.hostId !== claims.sub &&
        !(await app.repos.participants.hasJoined(roomId, claims.sub))
      ) {
        throw AppError.forbidden('你不在这个课堂里');
      }
    }

    if (courseId) {
      const course = await app.repos.courses.get(courseId, claims.sub, claims.role === 'admin', Date.now());
      if (!course) throw AppError.notFound('课程不存在');
      const manager = await app.repos.courses.isManager(courseId, claims.sub, claims.role === 'admin');
      if (purpose === 'courseware' && !manager) {
        throw AppError.forbidden('只有课程老师或助教可以上传课件');
      }
      if (purpose === 'homework' && !manager) {
        const member = await app.repos.courses.isMember(courseId, claims.sub);
        if (!member) throw AppError.forbidden('你不在这个课程里');
      }
    }

    if (!request.isMultipart()) throw AppError.badRequest('bad_request', '请用 multipart/form-data 上传');

    let part;
    try {
      part = await request.file({ limits: { fileSize: app.appConfig.maxUploadBytes, files: 1 } });
    } catch {
      throw AppError.badRequest('too_large', '文件超过大小限制');
    }
    if (!part) throw AppError.badRequest('bad_request', '没有收到文件');

    if (!ALLOWED_MIME.has(part.mimetype)) {
      throw AppError.badRequest('bad_mime', '不支持这种文件类型（支持图片、PDF、Office、音视频）');
    }

    let buf: Buffer;
    const maxMb = Math.round(app.appConfig.maxUploadBytes / 1024 / 1024);
    try {
      buf = await part.toBuffer();
    } catch {
      throw AppError.badRequest('too_large', `文件不能超过 ${maxMb}MB`);
    }
    if (part.file.truncated) {
      throw AppError.badRequest('too_large', `文件不能超过 ${maxMb}MB`);
    }

    const at = Date.now();
    // 先定 id 再写盘：落盘路径要按 id 分桶，反过来做就得写两次库
    const id = randomUUID();
    const filePath = storagePath(app.appConfig.uploadsDir, id);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buf);

    await app.repos.files.create({
      id,
      ownerId: claims.sub,
      roomId: roomId ?? null,
      courseId,
      purpose,
      mime: part.mimetype,
      size: buf.byteLength,
      path: filePath,
      width: width ?? null,
      height: height ?? null,
      at,
    });

    const signed = signFileUrl(app.appConfig.jwtSecret, id, URL_TTL_MS);
    const dto: FileDTO = {
      id,
      mime: part.mimetype,
      size: buf.byteLength,
      width: width ?? null,
      height: height ?? null,
      url: signed.url,
      expiresAt: signed.expiresAt,
    };
    reply.code(201);
    return { file: dto };
  });
};

/**
 * 公开的文件读取端点，只认签名不认登录态。
 * 路径故意不在 /api/v1 下 —— 它会被 <img src> 和 Konva 直接引用。
 */
export const publicFileRoutes: FastifyPluginAsync = async (app) => {
  app.get('/files/:id', async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) throw AppError.badRequest('bad_id', '文件 ID 不正确');

    const q = z
      .object({ exp: z.coerce.number(), sig: z.string().min(1) })
      .safeParse(request.query);
    if (!q.success) throw AppError.unauthorized('缺少访问签名');

    if (!verifyFileUrl(app.appConfig.jwtSecret, p.data.id, q.data.exp, q.data.sig)) {
      throw AppError.unauthorized('访问签名无效或已过期');
    }

    const row = await app.repos.files.getById(p.data.id);
    if (!row) throw AppError.notFound('文件不存在');

    reply
      .header('Cache-Control', 'private, max-age=3600')
      .header('Content-Type', row.mime)
      .header('Content-Length', String(row.size))
      .header('X-Content-Type-Options', 'nosniff');

    return reply.send(createReadStream(row.path));
  });
};
