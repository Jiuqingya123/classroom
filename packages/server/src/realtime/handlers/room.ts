import { randomInt, randomUUID } from 'node:crypto';
import {
  type AwardKind,
  type ChatMessageDTO,
  type ClientToServerEvents,
  type InterServerEvents,
  type JoinRoomResult,
  type PresenceMediaPayload,
  type QuizResultState,
  type QuizStartInput,
  type RoomControlPayload,
  type RoomTimerMode,
  type ServerToClientEvents,
  type SocketData,
} from '@classroom/shared';
import type { Server } from 'socket.io';
import type { AppSocket } from '../context';
import { ctxOf } from '../context';
import type { RealtimeDeps } from '../deps';
import type { RoomRuntime } from '../RoomRegistry';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const MAX_CHAT_LEN = 500;
const MAX_ANNOUNCE_LEN = 500;

function ackOf<T>(a: unknown, b?: unknown): (r: T) => void {
  const fn = typeof a === 'function' ? a : typeof b === 'function' ? b : null;
  return (fn as ((r: T) => void) | null) ?? (() => {});
}

/** 课堂内的教学权限：创建者、管理员，或本课程的助教 */
function roomStaff(room: RoomRuntime, userId: string): boolean {
  return room.members.get(userId)?.staff === true;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort().join(',');
  const sb = [...b].sort().join(',');
  return sa === sb;
}

async function record(
  deps: RealtimeDeps,
  roomId: string,
  userId: string | null,
  kind: string,
  payload: Record<string, unknown>,
  id = randomUUID(),
): Promise<void> {
  try {
    await deps.repos.activities.add({ id, roomId, userId, kind, payload, at: Date.now() });
  } catch (err) {
    deps.log.warn({ err, roomId, kind }, 'activity persist failed');
  }
}

function emitMember(io: IO, room: RoomRuntime, userId: string, registry: RealtimeDeps['registry']): void {
  const p = registry.participant(room, userId);
  if (p) io.to(room.id).emit('member:updated', { participant: p });
}

function broadcastSignin(io: IO, room: RoomRuntime, deps: RealtimeDeps): void {
  for (const m of room.members.values()) {
    const state = deps.registry.signinPublic(room, m.staff);
    if (state) io.to(m.socketId).emit('signin:state', state);
  }
}

function quizResultOf(room: RoomRuntime, includeAnswers: boolean): QuizResultState | null {
  const q = room.quiz;
  if (!q) return null;
  const totalStudents = [...room.members.values()].filter((m) => !m.staff).length;
  const counts = new Map<string, number>();
  for (const a of q.answers.values()) {
    for (const k of a.answer) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const base: QuizResultState = {
    quizId: q.quizId,
    questionId: q.questionId,
    stem: q.stem,
    type: q.type,
    options: q.options,
    durationSec: q.durationSec,
    startedAt: q.startedAt,
    endsAt: q.endsAt,
    byName: q.byName,
    answeredCount: q.answers.size,
    totalStudents,
    counts: q.options.map((o) => ({ key: o.key, count: counts.get(o.key) ?? 0 })),
    correctAnswer: q.correctAnswer,
    analysis: q.analysis,
  };
  if (includeAnswers) {
    base.answers = [...q.answers.entries()].map(([userId, a]) => ({
      userId,
      displayName: room.members.get(userId)?.displayName ?? '已离开',
      answer: a.answer,
      correct: sameSet(a.answer, q.correctAnswer),
    }));
  }
  return base;
}

async function ensureInteractive(deps: RealtimeDeps, room: RoomRuntime): Promise<void> {
  if (room.interactiveLoaded) return;
  room.interactiveLoaded = true;
  try {
    room.rewards = await deps.repos.activities.rewardTotals(room.id);
    const acts = await deps.repos.activities.listByRoom(room.id, 200);
    const ann = acts.find((a) => a.kind === 'announce');
    if (ann) {
      const p = ann.payload as { content?: unknown; by?: unknown; byName?: unknown };
      if (typeof p.content === 'string') {
        room.announcement = {
          id: ann.id,
          content: p.content,
          by: typeof p.by === 'string' ? p.by : '',
          byName: typeof p.byName === 'string' ? p.byName : '老师',
          at: ann.createdAt,
        };
      }
    }
  } catch (err) {
    deps.log.warn({ err, roomId: room.id }, 'interactive state restore failed');
  }
}

export function registerRoomHandlers(io: IO, deps: RealtimeDeps): void {
  io.on('connection', (socket: AppSocket) => {
    const user = socket.data.user;
    deps.log.debug({ userId: user.id, sid: socket.id }, 'socket connected');

    socket.on('room:join', async (payload, ack) => {
      const reply = (r: JoinRoomResult) => {
        if (typeof ack === 'function') ack(r);
      };
      try {
        const result = await handleJoin(io, deps, socket, payload.roomId, payload.code);
        reply(result);
      } catch (err) {
        deps.log.error({ err, roomId: payload?.roomId }, 'room:join failed');
        reply({ ok: false, error: 'not_found' });
      }
    });

    socket.on('room:leave', () => {
      void leaveRoom(io, deps, socket, 'left');
    });

    socket.on('room:end', async (payloadOrAck: unknown, maybeAck?: unknown) => {
      const finish = ackOf<{ ok: boolean; error?: string }>(payloadOrAck, maybeAck);
      const roomId = socket.data.roomId;
      if (!roomId) return finish({ ok: false, error: 'not_in_room' });

      const room = deps.registry.get(roomId);
      if (!room) return finish({ ok: false, error: 'not_found' });
      if (room.hostId !== user.id && user.role !== 'admin') {
        return finish({ ok: false, error: 'forbidden' });
      }

      try {
        // 写库、关闭考勤、更新 runtime、广播 room:ended、清场统一由 roomService 完成
        await deps.roomService.end(roomId, user.id, { isAdmin: user.role === 'admin' });
        finish({ ok: true });
      } catch (err) {
        deps.log.error({ err, roomId }, 'room:end failed');
        finish({ ok: false, error: 'internal' });
      }
    });

    socket.on('presence:media', (payload: PresenceMediaPayload) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = deps.registry.get(roomId);
      if (!room) return;
      const me = room.members.get(user.id);
      if (!me) return;

      if (payload.sharing && room.sharingUserId && room.sharingUserId !== user.id) {
        socket.emit('presence:reject', { reason: 'sharing_occupied' });
        return;
      }

      const micBlocked = room.forceMuted.has(user.id);
      const camBlocked = room.forceCameraOff.has(user.id);
      if (payload.hasAudio && micBlocked) {
        socket.emit('room:control', {
          action: 'mute',
          by: 'system',
          byName: '课堂管理',
          targetId: user.id,
        });
      }
      if (payload.hasVideo && camBlocked) {
        socket.emit('room:control', {
          action: 'camera_off',
          by: 'system',
          byName: '课堂管理',
          targetId: user.id,
        });
      }

      const handChanged = me.handRaised !== !!payload.handRaised;
      me.hasVideo = !!payload.hasVideo && !camBlocked;
      me.hasAudio = !!payload.hasAudio && !micBlocked;
      me.sharing = !!payload.sharing;
      me.handRaised = !!payload.handRaised;
      me.handRaisedAt = me.handRaised ? me.handRaisedAt ?? Date.now() : null;
      room.sharingUserId = me.sharing ? user.id : room.sharingUserId === user.id ? null : room.sharingUserId;

      socket.to(roomId).emit('presence:media', {
        userId: user.id,
        hasVideo: me.hasVideo,
        hasAudio: me.hasAudio,
        sharing: me.sharing,
        handRaised: me.handRaised,
      });
      if (handChanged) emitMember(io, room, user.id, deps.registry);
    });

    /* ── 课堂控制 ── */

    socket.on('room:control', async (payload: RoomControlPayload, ack) => {
      const fail = (error: string) => ack?.({ ok: false, error });
      const roomId = socket.data.roomId;
      if (!roomId) return fail('not_in_room');
      const room = deps.registry.get(roomId);
      if (!room) return fail('not_found');
      if (!roomStaff(room, user.id)) return fail('forbidden');

      const action = payload?.action;
      const targetId = payload?.targetId;
      const target = targetId ? room.members.get(targetId) : null;
      const needTarget: string[] = [
        'mute',
        'unmute',
        'camera_off',
        'camera_on',
        'approve_hand',
        'reject_hand',
        'invite_stage',
        'remove_stage',
        'kick',
      ];
      if (needTarget.includes(action) && !target) return fail('target_not_found');

      const affected = new Set<string>();
      switch (action) {
        case 'mute_all': {
          room.allMuted = true;
          for (const m of room.members.values()) {
            if (m.staff) continue;
            room.forceMuted.add(m.userId);
            m.hasAudio = false;
            affected.add(m.userId);
          }
          break;
        }
        case 'unmute_all': {
          room.allMuted = false;
          for (const m of room.members.values()) {
            if (m.staff) continue;
            room.forceMuted.delete(m.userId);
            affected.add(m.userId);
          }
          break;
        }
        case 'mute': {
          if (!target) break;
          room.forceMuted.add(target.userId);
          target.hasAudio = false;
          affected.add(target.userId);
          break;
        }
        case 'unmute': {
          if (!target) break;
          room.forceMuted.delete(target.userId);
          affected.add(target.userId);
          break;
        }
        case 'camera_off': {
          if (!target) break;
          room.forceCameraOff.add(target.userId);
          target.hasVideo = false;
          affected.add(target.userId);
          break;
        }
        case 'camera_on': {
          if (!target) break;
          room.forceCameraOff.delete(target.userId);
          affected.add(target.userId);
          break;
        }
        case 'approve_hand': {
          if (!target) break;
          target.handRaised = false;
          target.handRaisedAt = null;
          room.offStage.delete(target.userId);
          room.forceMuted.delete(target.userId);
          affected.add(target.userId);
          break;
        }
        case 'reject_hand': {
          if (!target) break;
          target.handRaised = false;
          target.handRaisedAt = null;
          affected.add(target.userId);
          break;
        }
        case 'invite_stage': {
          if (!target) break;
          room.offStage.delete(target.userId);
          room.forceMuted.delete(target.userId);
          room.forceCameraOff.delete(target.userId);
          target.handRaised = false;
          target.handRaisedAt = null;
          affected.add(target.userId);
          break;
        }
        case 'remove_stage': {
          if (!target) break;
          room.offStage.add(target.userId);
          room.forceMuted.add(target.userId);
          target.hasAudio = false;
          target.hasVideo = false;
          target.sharing = false;
          if (room.sharingUserId === target.userId) room.sharingUserId = null;
          affected.add(target.userId);
          break;
        }
        case 'kick': {
          if (!target) break;
          if (target.staff) return fail('cannot_kick_staff');
          io.to(target.socketId).emit('room:kicked', { reason: '老师将你移出课堂', byName: user.displayName });
          const s = io.sockets.sockets.get(target.socketId);
          if (s) {
            setTimeout(() => s.disconnect(true), 50);
          }
          break;
        }
        default:
          return fail('bad_action');
      }

      if (action !== 'kick') {
        io.to(roomId).emit('room:control', {
          action,
          by: user.id,
          byName: user.displayName,
          targetId,
          allMuted: room.allMuted,
        });
        for (const id of affected) emitMember(io, room, id, deps.registry);
      }
      await record(deps, roomId, user.id, 'control', { action, targetId: targetId ?? null });
      ack?.({ ok: true });
    });

    socket.on('room:announce', async (payload, ack) => {
      const fail = (error: string) => ack?.({ ok: false, error });
      const roomId = socket.data.roomId;
      if (!roomId) return fail('not_in_room');
      const room = deps.registry.get(roomId);
      if (!room) return fail('not_found');
      if (!roomStaff(room, user.id)) return fail('forbidden');
      const content = String(payload?.content ?? '').trim();
      if (!content) return fail('empty');
      if (content.length > MAX_ANNOUNCE_LEN) return fail('too_long');

      const announcement = {
        id: randomUUID(),
        content,
        by: user.id,
        byName: user.displayName,
        at: Date.now(),
      };
      room.announcement = announcement;
      await record(deps, roomId, user.id, 'announce', { content, by: user.id, byName: user.displayName }, announcement.id);
      io.to(roomId).emit('room:announce', announcement);
      ack?.({ ok: true });
    });

    socket.on('room:award', async (payload, ack) => {
      const fail = (error: string) => ack?.({ ok: false, error });
      const roomId = socket.data.roomId;
      if (!roomId) return fail('not_in_room');
      const room = deps.registry.get(roomId);
      if (!room) return fail('not_found');
      if (!roomStaff(room, user.id)) return fail('forbidden');
      const target = room.members.get(String(payload?.toUserId ?? ''));
      if (!target) return fail('target_not_found');
      const kind = payload?.kind as AwardKind;
      if (!['star', 'trophy', 'flower'].includes(kind)) return fail('bad_kind');
      const points = Math.max(1, Math.min(100, Math.round(Number(payload?.points) || 1)));
      const remark = String(payload?.remark ?? '').trim().slice(0, 100);
      const total = (room.rewards.get(target.userId) ?? 0) + points;
      room.rewards.set(target.userId, total);
      const id = randomUUID();
      await record(
        deps,
        roomId,
        target.userId,
        'award',
        {
          kind,
          points,
          remark,
          by: user.id,
          byName: user.displayName,
          toName: target.displayName,
        },
        id,
      );
      io.to(roomId).emit('room:award', {
        id,
        toUserId: target.userId,
        toName: target.displayName,
        kind,
        points,
        remark,
        by: user.id,
        byName: user.displayName,
        totalForUser: total,
        at: Date.now(),
      });
      emitMember(io, room, target.userId, deps.registry);
      ack?.({ ok: true });
    });

    socket.on('room:random_pick', async (ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) return ack?.({ ok: false, error: 'not_in_room' });
      const room = deps.registry.get(roomId);
      if (!room) return ack?.({ ok: false, error: 'not_found' });
      if (!roomStaff(room, user.id)) return ack?.({ ok: false, error: 'forbidden' });
      const pool = [...room.members.values()].filter((m) => !m.staff);
      if (pool.length === 0) return ack?.({ ok: false, error: 'no_students' });
      const picked = pool[randomInt(0, pool.length)];
      if (!picked) return ack?.({ ok: false, error: 'no_students' });
      io.to(roomId).emit('room:picked', {
        userId: picked.userId,
        displayName: picked.displayName,
        byName: user.displayName,
      });
      await record(deps, roomId, user.id, 'random_pick', { toUserId: picked.userId });
      ack?.({ ok: true, userId: picked.userId, displayName: picked.displayName });
    });

    /* ── 答题 ── */

    socket.on('quiz:start', async (payload: QuizStartInput, ack) => {
      const fail = (error: string) => ack?.({ ok: false, error });
      const roomId = socket.data.roomId;
      if (!roomId) return fail('not_in_room');
      const room = deps.registry.get(roomId);
      if (!room) return fail('not_found');
      if (!roomStaff(room, user.id)) return fail('forbidden');

      const type = payload?.type;
      if (!['single', 'multiple', 'judge'].includes(type)) return fail('bad_type');
      const stem = String(payload?.stem ?? '').trim();
      if (!stem || stem.length > 1000) return fail('bad_stem');
      let options = Array.isArray(payload?.options) ? payload.options : [];
      if (type === 'judge') {
        options = [
          { key: 'T', text: '正确' },
          { key: 'F', text: '错误' },
        ];
      }
      options = options
        .map((o) => ({ key: String(o.key).slice(0, 4), text: String(o.text).slice(0, 300) }))
        .filter((o) => o.key && o.text);
      if (options.length < 2 || options.length > 8) return fail('bad_options');
      const keys = new Set(options.map((o) => o.key));
      if (keys.size !== options.length) return fail('bad_options');
      const correctAnswer = Array.isArray(payload?.correctAnswer)
        ? payload.correctAnswer.map(String).filter((k) => keys.has(k))
        : [];
      if (correctAnswer.length === 0) return fail('bad_answer');
      if (type !== 'multiple' && correctAnswer.length !== 1) return fail('bad_answer');

      const durationSec = Math.max(10, Math.min(600, Math.round(Number(payload?.durationSec) || 60)));
      const now = Date.now();
      const q = {
        quizId: randomUUID(),
        questionId: payload?.questionId ?? null,
        stem,
        type,
        options,
        correctAnswer,
        analysis: String(payload?.analysis ?? '').slice(0, 1000),
        durationSec,
        startedAt: now,
        endsAt: now + durationSec * 1000,
        byName: user.displayName,
        ended: false,
        answers: new Map(),
      };
      room.quiz = q;
      await record(deps, roomId, user.id, 'quiz_start', {
        quizId: q.quizId,
        questionId: q.questionId,
        stem: q.stem,
        correctAnswer,
      });
      const pub = deps.registry.quizPublic(room);
      if (pub) io.to(roomId).emit('quiz:state', pub);
      ack?.({ ok: true });
    });

    socket.on('quiz:answer', async (payload, ack) => {
      const fail = (error: string) => ack?.({ ok: false, error });
      const roomId = socket.data.roomId;
      if (!roomId) return fail('not_in_room');
      const room = deps.registry.get(roomId);
      if (!room) return fail('not_found');
      const me = room.members.get(user.id);
      if (!me) return fail('not_in_room');
      if (me.staff) return fail('staff_cannot_answer');
      const q = room.quiz;
      if (!q || q.ended) return fail('no_quiz');
      if (String(payload?.quizId ?? '') !== q.quizId) return fail('quiz_mismatch');
      if (Date.now() > q.endsAt + 1500) return fail('quiz_ended');
      const keys = new Set(q.options.map((o) => o.key));
      const answer = Array.isArray(payload?.answer) ? payload.answer.map(String).filter((k) => keys.has(k)) : [];
      if (answer.length === 0) return fail('bad_answer');
      if (q.type !== 'multiple' && answer.length !== 1) return fail('bad_answer');
      q.answers.set(user.id, { answer, at: Date.now() });
      await record(deps, roomId, user.id, 'quiz_answer', { quizId: q.quizId, answer });
      const pub = deps.registry.quizPublic(room);
      if (pub) io.to(roomId).emit('quiz:state', pub);
      ack?.({ ok: true });
    });

    socket.on('quiz:end', async (payload, ack) => {
      const fail = (error: string) => ack?.({ ok: false, error });
      const roomId = socket.data.roomId;
      if (!roomId) return fail('not_in_room');
      const room = deps.registry.get(roomId);
      if (!room) return fail('not_found');
      if (!roomStaff(room, user.id)) return fail('forbidden');
      const q = room.quiz;
      if (!q || q.ended) return fail('no_quiz');
      if (payload?.quizId && payload.quizId !== q.quizId) return fail('quiz_mismatch');
      q.ended = true;
      const staffResult = quizResultOf(room, true);
      const studentResult = quizResultOf(room, false);
      for (const m of room.members.values()) {
        const result = m.staff ? staffResult : studentResult;
        if (result) io.to(m.socketId).emit('quiz:result', result);
      }
      await record(deps, roomId, user.id, 'quiz_end', {
        quizId: q.quizId,
        answered: q.answers.size,
        correctAnswer: q.correctAnswer,
      });
      ack?.({ ok: true });
    });

    /* ── 计时器 ── */

    socket.on('timer:start', async (payload, ack) => {
      const fail = (error: string) => ack?.({ ok: false, error });
      const roomId = socket.data.roomId;
      if (!roomId) return fail('not_in_room');
      const room = deps.registry.get(roomId);
      if (!room) return fail('not_found');
      if (!roomStaff(room, user.id)) return fail('forbidden');
      const mode = payload?.mode as RoomTimerMode;
      if (mode !== 'countdown' && mode !== 'stopwatch') return fail('bad_mode');
      const durationSec = Math.max(5, Math.min(3600, Math.round(Number(payload?.durationSec) || 60)));
      const now = Date.now();
      room.timer = {
        mode,
        durationSec: mode === 'countdown' ? durationSec : 0,
        startedAt: now,
        endsAt: mode === 'countdown' ? now + durationSec * 1000 : null,
        running: true,
        byName: user.displayName,
      };
      io.to(roomId).emit('timer:state', room.timer);
      await record(deps, roomId, user.id, 'timer_start', { mode, durationSec });
      ack?.({ ok: true });
    });

    socket.on('timer:stop', async (ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) return ack?.({ ok: false, error: 'not_in_room' });
      const room = deps.registry.get(roomId);
      if (!room) return ack?.({ ok: false, error: 'not_found' });
      if (!roomStaff(room, user.id)) return ack?.({ ok: false, error: 'forbidden' });
      room.timer = null;
      io.to(roomId).emit('timer:state', null);
      ack?.({ ok: true });
    });

    /* ── 签到 ── */

    socket.on('signin:start', async (payload, ack) => {
      const fail = (error: string) => ack?.({ ok: false, error });
      const roomId = socket.data.roomId;
      if (!roomId) return fail('not_in_room');
      const room = deps.registry.get(roomId);
      if (!room) return fail('not_found');
      if (!roomStaff(room, user.id)) return fail('forbidden');
      const durationSec = Math.max(15, Math.min(600, Math.round(Number(payload?.durationSec) || 60)));
      const now = Date.now();
      room.signin = {
        signinId: randomUUID(),
        startedAt: now,
        endsAt: now + durationSec * 1000,
        done: false,
        signed: new Map(),
      };
      await record(deps, roomId, user.id, 'signin_start', { signinId: room.signin.signinId, durationSec });
      broadcastSignin(io, room, deps);
      ack?.({ ok: true });
    });

    socket.on('signin:mark', async (ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) return ack?.({ ok: false, error: 'not_in_room' });
      const room = deps.registry.get(roomId);
      if (!room) return ack?.({ ok: false, error: 'not_found' });
      const me = room.members.get(user.id);
      if (!me) return ack?.({ ok: false, error: 'not_in_room' });
      if (me.staff) return ack?.({ ok: false, error: 'staff_cannot_signin' });
      const s = room.signin;
      if (!s) return ack?.({ ok: false, error: 'no_signin' });
      if (s.done) return ack?.({ ok: false, error: 'signin_done' });
      if (Date.now() > s.endsAt + 1500) return ack?.({ ok: false, error: 'signin_expired' });
      const now = Date.now();
      s.signed.set(user.id, now);
      try {
        await deps.repos.activities.markSignin(roomId, user.id, now);
      } catch (err) {
        deps.log.warn({ err, roomId }, 'signin persist failed');
      }
      broadcastSignin(io, room, deps);
      ack?.({ ok: true });
    });

    socket.on('signin:end', async (ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) return ack?.({ ok: false, error: 'not_in_room' });
      const room = deps.registry.get(roomId);
      if (!room) return ack?.({ ok: false, error: 'not_found' });
      if (!roomStaff(room, user.id)) return ack?.({ ok: false, error: 'forbidden' });
      const s = room.signin;
      if (!s) return ack?.({ ok: false, error: 'no_signin' });
      s.done = true;
      await record(deps, roomId, user.id, 'signin_end', {
        signinId: s.signinId,
        signed: s.signed.size,
      });
      broadcastSignin(io, room, deps);
      ack?.({ ok: true });
    });

    /* ── 聊天 ── */

    socket.on('chat:send', async (payload, ack) => {
      const fail = (error: string) => {
        if (typeof ack === 'function') ack({ ok: false, error });
      };
      const roomId = socket.data.roomId;
      if (!roomId) return fail('not_in_room');
      if (!ctxOf(socket).chat.take()) return fail('rate_limited');

      const room = deps.registry.get(roomId);
      if (!room) return fail('not_found');

      const content = String(payload?.content ?? '').trim();
      if (!content) return fail('empty');
      if (content.length > MAX_CHAT_LEN) return fail('too_long');

      const toUserId = typeof payload?.toUserId === 'string' && payload.toUserId ? payload.toUserId : null;
      let target: { socketId: string; displayName: string } | null = null;
      if (toUserId) {
        const member = room.members.get(toUserId);
        if (!member) return fail('target_not_found');
        if (member.userId === user.id) return fail('self_chat');
        const me = room.members.get(user.id);
        if (!me) return fail('not_in_room');
        if (!me.staff && !member.staff) return fail('private_denied');
        target = { socketId: member.socketId, displayName: member.displayName };
      }

      const msg: ChatMessageDTO = {
        id: randomUUID(),
        roomId,
        userId: user.id,
        displayName: user.displayName,
        kind: 'text',
        content,
        toUserId,
        toName: target?.displayName ?? null,
        createdAt: Date.now(),
      };

      try {
        await deps.repos.messages.insert(msg);
      } catch (err) {
        deps.log.error({ err, roomId }, 'chat persist failed');
        return fail('internal');
      }

      if (target) {
        io.to(target.socketId).emit('chat:message', msg);
        socket.emit('chat:message', msg);
      } else {
        io.to(roomId).emit('chat:message', msg);
      }
      if (typeof ack === 'function') ack({ ok: true, message: msg });
    });

    socket.on('disconnect', (reason) => {
      void leaveRoom(io, deps, socket, reason);
    });
  });
}

async function handleJoin(
  io: IO,
  deps: RealtimeDeps,
  socket: AppSocket,
  roomId: string,
  code?: string,
): Promise<JoinRoomResult> {
  const user = socket.data.user;
  if (!roomId) return { ok: false, error: 'not_found' };

  const room = await deps.registry.getOrLoad(roomId);
  if (!room) return { ok: false, error: 'not_found' };
  if (room.status === 'ended') return { ok: false, error: 'ended' };

  const lesson = room.lessonId ? await deps.repos.lessons.get(room.lessonId) : null;
  const isAdminUser = user.role === 'admin';
  const isHost = room.hostId === user.id;
  const already = await deps.repos.participants.hasJoined(room.id, user.id);

  // 课堂权限不能只看全局角色：任何自助注册的老师都能凭入会码进别人的课，
  // 所以「是否教学人员」按房间计算 —— 创建者、平台管理员、本课程助教。
  const courseId = lesson?.courseId ?? room.courseId;
  const isCourseManager = courseId
    ? await deps.repos.courses.isManager(courseId, user.id, isAdminUser)
    : false;
  const isRoomStaff = isAdminUser || isHost || isCourseManager;

  if (lesson) {
    if (lesson.status === 'cancelled' || lesson.status === 'ended') return { ok: false, error: 'ended' };
    if (lesson.roomStatus === 'ended') return { ok: false, error: 'ended' };
    const member = isCourseManager || (await deps.repos.courses.isMember(lesson.courseId, user.id));
    if (!member && !isAdminUser) return { ok: false, error: 'not_member' };
    if (!isCourseManager && !isAdminUser && Date.now() < lesson.startsAt - 15 * 60 * 1000) {
      return { ok: false, error: 'too_early' };
    }
  } else if (!isHost && !already) {
    const provided = String(code ?? '').trim();
    if (!provided || provided !== room.joinCode) return { ok: false, error: 'bad_code' };
  }

  const isAlreadyIn = room.members.has(user.id);
  if (!isAlreadyIn && room.members.size >= deps.config.maxParticipants) {
    return { ok: false, error: 'full' };
  }

  const prev = room.members.get(user.id);
  if (prev && prev.socketId !== socket.id) {
    const old = io.sockets.sockets.get(prev.socketId);
    if (old) {
      old.emit('room:error', { code: 'superseded', message: '你在其他窗口进入了同一课堂' });
      old.disconnect(true);
    }
  }

  if (socket.data.roomId && socket.data.roomId !== room.id) {
    await leaveRoom(io, deps, socket, 'switched');
  }

  socket.join(room.id);
  socket.data.roomId = room.id;
  ctxOf(socket).roomId = room.id;

  await ensureInteractive(deps, room);

  const joinedAt = Date.now();
  deps.registry.addMember(room, {
    userId: user.id,
    displayName: user.displayName,
    role: user.role,
    staff: isRoomStaff,
    socketId: socket.id,
    hasVideo: false,
    hasAudio: false,
    sharing: false,
    handRaised: false,
    handRaisedAt: null,
    joinedAt,
  });
  // 全员静音期间进房的学生同样要受约束
  if (room.allMuted && !isRoomStaff) room.forceMuted.add(user.id);

  try {
    await deps.repos.participants.close(room.id, user.id, joinedAt);
    await deps.repos.participants.open(room.id, user.id, user.role, joinedAt);
  } catch (err) {
    deps.log.error({ err }, 'participant open failed');
  }

  if (room.status === 'open') {
    room.status = 'live';
    room.startedAt = joinedAt;
    await deps.repos.rooms.setStatus(room.id, 'live', joinedAt);
  }

  const participants = deps.registry.participants(room);
  const history = await deps.repos.messages.listForUser(room.id, user.id, 200);

  const self = deps.registry.participant(room, user.id) ?? undefined;
  if (self) socket.to(room.id).emit('peer:joined', { participant: self });

  return {
    ok: true,
    room: deps.registry.toDTO(room, user.id),
    self,
    participants,
    iceServers: deps.turn.iceServersFor(user.id).iceServers,
    studentsCanDraw: room.studentsCanDraw,
    history,
    announcement: room.announcement,
    timer: room.timer,
    quiz: deps.registry.quizPublic(room),
    signin: deps.registry.signinPublic(room, isRoomStaff),
    allMuted: room.allMuted,
  };
}

async function leaveRoom(
  io: IO,
  deps: RealtimeDeps,
  socket: AppSocket,
  reason: string,
): Promise<void> {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = deps.registry.get(roomId);
  socket.data.roomId = undefined;
  ctxOf(socket).roomId = null;
  socket.leave(roomId);

  if (!room) return;

  const member = room.members.get(socket.data.user.id);
  if (member && member.socketId !== socket.id) return;

  if (deps.registry.removeMember(room, socket.data.user.id)) {
    try {
      await deps.repos.participants.close(roomId, socket.data.user.id, Date.now());
    } catch (err) {
      deps.log.error({ err, roomId }, 'participant close failed');
    }
    io.to(roomId).emit('peer:left', { userId: socket.data.user.id, reason });
  }
  deps.registry.collectGarbage();
}
