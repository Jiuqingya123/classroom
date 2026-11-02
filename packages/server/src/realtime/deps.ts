import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import type { Repos } from '../db/repos';
import type { AuthService } from '../services/authService';
import type { RoomService } from '../services/roomService';
import type { TurnService } from '../services/turnService';
import type { RoomRegistry } from './RoomRegistry';

export interface RealtimeDeps {
  config: Config;
  repos: Repos;
  registry: RoomRegistry;
  roomService: RoomService;
  turn: TurnService;
  auth: AuthService;
  log: FastifyBaseLogger;
}
