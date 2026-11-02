import { config as loadEnv } from 'dotenv';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '..', '..');

/** 仅开发/测试用的兜底密钥。生产环境缺 JWT_SECRET 会直接启动失败。 */
const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me-please-32bytes';

// 先加载仓库根的 .env，再用包内的覆盖（已存在的变量不会被二次覆盖）
loadEnv({ path: resolve(repoRoot, '.env'), quiet: true });
loadEnv({ path: resolve(serverRoot, '.env'), quiet: true });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  DB_PATH: z.string().default('./data/app.db'),
  DATA_DIR: z.string().default('./data'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET 至少 16 个字符').optional(),
  ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  RTC_TTL_SECONDS: z.coerce.number().int().positive().default(7200),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),

  ALLOWED_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://localhost:5273,http://localhost,https://localhost,capacitor://localhost,file://,null',
    ),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),

  TURN_HOST: z.string().default(''),
  TURN_PORT: z.coerce.number().int().default(3478),
  TURN_TLS_PORT: z.coerce.number().int().default(5349),
  TURN_REALM: z.string().default(''),
  TURN_SECRET: z.string().default(''),
  TURN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  MAX_PARTICIPANTS: z.coerce.number().int().positive().default(5),
  /** 课件/作业允许上传 PPT、PDF、音视频，默认 50MB */
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(50),

  /** 首次启动时确保存在一个管理员账号；为空则不创建 */
  ADMIN_EMAIL: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),
  ADMIN_NAME: z.string().default('系统管理员'),

  /** 腾讯云实时互动-教育版（LCIC）并列入口；三项凭据齐全且未显式关闭时启用 */
  LCIC_ENABLED: z.string().default('true'),
  LCIC_SDK_APP_ID: z.string().regex(/^\d*$/, 'LCIC_SDK_APP_ID 应为数字').default(''),
  LCIC_SECRET_ID: z.string().default(''),
  LCIC_SECRET_KEY: z.string().default(''),
  LCIC_API_ENDPOINT: z.string().default('lcic.tencentcloudapi.com'),
  LCIC_CLASS_DOMAIN: z.string().default('class.qcloudclass.com'),
  LCIC_ROOM_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(24),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  isProd: boolean;
  port: number;
  host: string;
  logLevel: string;
  dbPath: string;
  dataDir: string;
  uploadsDir: string;
  jwtSecret: string;
  accessTtl: number;
  rtcTtl: number;
  refreshTtlMs: number;
  allowedOrigins: string[];
  publicBaseUrl: string;
  turn: {
    host: string;
    port: number;
    tlsPort: number;
    realm: string;
    secret: string;
    ttl: number;
  };
  maxParticipants: number;
  maxUploadBytes: number;
  bootstrapAdmin: { email: string; password: string; name: string };
  lcic: {
    enabled: boolean;
    sdkAppId: number;
    secretId: string;
    secretKey: string;
    endpoint: string;
    classDomain: string;
    roomTtlSeconds: number;
  };
}

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(serverRoot, p);
}

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`环境变量校验失败：\n${detail}`);
  }
  const e = parsed.data;
  const dataDir = abs(e.DATA_DIR);

  const isProd = e.NODE_ENV === 'production';
  if (isProd && !e.JWT_SECRET) {
    throw new Error('生产环境必须设置 JWT_SECRET：openssl rand -base64 48');
  }
  const jwtSecret = e.JWT_SECRET ?? DEV_JWT_SECRET;
  const lcicConfigured =
    e.LCIC_SDK_APP_ID !== '' && e.LCIC_SECRET_ID !== '' && e.LCIC_SECRET_KEY !== '';

  return {
    env: e.NODE_ENV,
    isProd,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    dbPath: abs(e.DB_PATH),
    dataDir,
    uploadsDir: resolve(dataDir, 'uploads'),
    jwtSecret,
    accessTtl: e.ACCESS_TTL_SECONDS,
    rtcTtl: e.RTC_TTL_SECONDS,
    refreshTtlMs: e.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
    allowedOrigins: e.ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    turn: {
      host: e.TURN_HOST,
      port: e.TURN_PORT,
      tlsPort: e.TURN_TLS_PORT,
      realm: e.TURN_REALM,
      secret: e.TURN_SECRET,
      ttl: e.TURN_TTL_SECONDS,
    },
    maxParticipants: e.MAX_PARTICIPANTS,
    maxUploadBytes: e.MAX_UPLOAD_MB * 1024 * 1024,
    bootstrapAdmin: { email: e.ADMIN_EMAIL, password: e.ADMIN_PASSWORD, name: e.ADMIN_NAME },
    lcic: {
      enabled: e.LCIC_ENABLED !== 'false' && lcicConfigured,
      sdkAppId: lcicConfigured ? Number(e.LCIC_SDK_APP_ID) : 0,
      secretId: e.LCIC_SECRET_ID,
      secretKey: e.LCIC_SECRET_KEY,
      endpoint: e.LCIC_API_ENDPOINT,
      classDomain: e.LCIC_CLASS_DOMAIN,
      roomTtlSeconds: e.LCIC_ROOM_TTL_HOURS * 60 * 60,
    },
  };
}
