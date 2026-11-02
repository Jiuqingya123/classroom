import type { Config } from './config';
import type { DB } from './db';
import type { Repos } from './db/repos';
import type { RoomRegistry } from './realtime/RoomRegistry';
import type { AuthService, TokenClaims } from './services/authService';
import type { LcicService } from './services/lcicService';
import type { RoomService } from './services/roomService';
import type { TurnService } from './services/turnService';

declare module 'fastify' {
  interface FastifyInstance {
    appConfig: Config;
    db: DB;
    repos: Repos;
    auth: AuthService;
    turn: TurnService;
    roomService: RoomService;
    lcic: LcicService;
    registry: RoomRegistry;
  }

  interface FastifyRequest {
    claims: TokenClaims | null;
  }
}
