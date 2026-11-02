import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config';
import { migrate, openDb } from './db';
import { createRepos } from './db/repos';
import { isAllowedOrigin } from './lib/cors';
import { registerErrorHandler } from './plugins/errorHandler';
import { RoomRegistry } from './realtime/RoomRegistry';
import { apiRoutes } from './routes';
import { publicFileRoutes } from './routes/files';
import { createAuthService } from './services/authService';
import { createLcicService } from './services/lcicService';
import { createRoomService } from './services/roomService';
import { createTurnService } from './services/turnService';

export async function buildServer(configArg?: Config): Promise<FastifyInstance> {
  const config = configArg ?? loadConfig();

  const app = Fastify({
    logger: config.env === 'test' ? false : { level: config.logLevel },
    // nginx 后面必开，否则 request.ip 全是 127.0.0.1，限流和日志都失效
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  });

  const db = openDb(config.dbPath);
  const applied = migrate(db);
  if (applied.length > 0) app.log.info({ migrations: applied }, '数据库迁移已应用');

  const repos = createRepos(db);

  await app.register(cors, {
    origin(origin, cb) {
      if (isAllowedOrigin(config, origin)) return cb(null, true);
      cb(new Error('origin_not_allowed'), false);
    },
    credentials: false,
  });
  await app.register(jwt, { secret: config.jwtSecret });
  // global:false —— 只在显式声明 config.rateLimit 的路由上生效
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 8,
    },
  });

  const auth = createAuthService({
    config,
    repos,
    sign: (claims, ttlSeconds) => app.jwt.sign(claims, { expiresIn: ttlSeconds }),
    verify: (token) => app.jwt.verify(token),
  });

  app.decorate('appConfig', config);
  app.decorate('db', db);
  app.decorate('repos', repos);
  app.decorate('auth', auth);
  app.decorate('turn', createTurnService(config));
  const registry = new RoomRegistry(repos);
  app.decorate('registry', registry);
  app.decorate('roomService', createRoomService({ config, repos, registry }));
  app.decorate('lcic', createLcicService({ config, repos }));
  app.decorateRequest('claims', null);

  if (config.bootstrapAdmin.email && config.bootstrapAdmin.password) {
    await auth.ensureAdmin(
      config.bootstrapAdmin.email,
      config.bootstrapAdmin.password,
      config.bootstrapAdmin.name,
    );
  }

  await registerErrorHandler(app);
  await app.register(apiRoutes, { prefix: '/api/v1' });
  // 文件读取不在 /api/v1 下：它会被 <img src> / Konva.Image 直接引用，只认签名
  await app.register(publicFileRoutes);

  app.get('/healthz', async () => ({
    ok: true,
    env: config.env,
    uptime: Math.round(process.uptime()),
    rooms: app.registry.size,
    turn: config.turn.host.length > 0 ? 'configured' : 'stun-only',
  }));

  app.addHook('onClose', async () => {
    db.close();
  });

  return app;
}
