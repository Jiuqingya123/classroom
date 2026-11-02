import type {
  PageMeta,
  ParticipantDTO,
  QuizPublicState,
  Role,
  RoomAnnouncement,
  RoomDTO,
  RoomSigninState,
  RoomStatus,
  RoomTimerState,
  WhiteboardElement,
} from '@classroom/shared';
import { DEFAULT_PAGE_HEIGHT, DEFAULT_PAGE_WIDTH, ROOM_GC_DELAY_MS, compareByOrder } from '@classroom/shared';
import { randomUUID } from 'node:crypto';
import type { Repos } from '../db/repos';

export interface Member {
  userId: string;
  displayName: string;
  role: Role;
  /** 按当前房间计算的权限：创建者、管理员或课程助教 */
  staff: boolean;
  socketId: string;
  hasVideo: boolean;
  hasAudio: boolean;
  sharing: boolean;
  handRaised: boolean;
  handRaisedAt: number | null;
  joinedAt: number;
}

export interface QuizRuntime {
  quizId: string;
  questionId: string | null;
  stem: string;
  type: 'single' | 'multiple' | 'judge';
  options: Array<{ key: string; text: string }>;
  correctAnswer: string[];
  analysis: string;
  durationSec: number;
  startedAt: number;
  endsAt: number;
  byName: string;
  ended: boolean;
  answers: Map<string, { answer: string[]; at: number }>;
}

export interface SigninRuntime {
  signinId: string;
  startedAt: number;
  endsAt: number;
  done: boolean;
  /** userId -> 签到时间 */
  signed: Map<string, number>;
}

/** 白板文档的内存形态，与 shared 的 WbDoc 结构一致 */
export interface RoomDocState {
  pages: PageMeta[];
  elements: Map<string, WhiteboardElement>;
}

export interface RoomRuntime {
  id: string;
  title: string;
  hostId: string;
  hostName: string;
  joinCode: string;
  status: RoomStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  courseId: string | null;
  lessonId: string | null;
  courseTitle: string | null;
  lessonTitle: string | null;

  seq: number;
  studentsCanDraw: boolean;
  /** 当前展示的页；老师翻页会广播给所有人 */
  activePageId: string;
  sharingUserId: string | null;
  doc: RoomDocState;

  members: Map<string, Member>;
  /** 被请下台的学生；不在集合里的学生默认在台上 */
  offStage: Set<string>;
  forceMuted: Set<string>;
  forceCameraOff: Set<string>;
  allMuted: boolean;
  rewards: Map<string, number>;
  announcement: RoomAnnouncement | null;
  timer: RoomTimerState | null;
  quiz: QuizRuntime | null;
  signin: SigninRuntime | null;
  /** 是否已从 DB 恢复过奖励/公告等互动状态 */
  interactiveLoaded: boolean;

  /** 最后一次访问时间，用于空房间回收 */
  lastActiveAt: number;
  /** 有未落库的改动 */
  dirty: boolean;
}

interface StoredDoc {
  pages?: PageMeta[];
  elements?: WhiteboardElement[];
  seq?: number;
  activePageId?: string;
  studentsCanDraw?: boolean;
}

/**
 * 房间运行时状态：单进程内存 Map，不入 Redis。
 * 进程重启后第一次 join 会从 rooms.doc_json 懒加载，课堂内容不会丢。
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, RoomRuntime>();

  constructor(private readonly repos: Repos) {}

  get(roomId: string): RoomRuntime | undefined {
    return this.rooms.get(roomId);
  }

  /** 取或从数据库懒加载。room 必须在 DB 中存在。 */
  async getOrLoad(roomId: string): Promise<RoomRuntime | null> {
    const cached = this.rooms.get(roomId);
    if (cached) return cached;

    const row = await this.repos.rooms.findById(roomId);
    if (!row) return null;

    // 两个 socket 同时首次进房时都可能在 await 期间通过上面的缓存检查；
    // 后完成的一方直接复用已 hydrate 的实例，避免两套内存状态分叉
    const raced = this.rooms.get(roomId);
    if (raced) return raced;

    const runtime = this.hydrate(row);
    this.rooms.set(roomId, runtime);
    return runtime;
  }

  /** 用 DB 行构造运行时（供 getOrLoad 与测试复用） */
  hydrate(row: {
    id: string;
    title: string;
    hostId: string;
    hostName: string;
    joinCode: string;
    status: RoomStatus;
    createdAt: number;
    startedAt: number | null;
    endedAt: number | null;
    docJson: string;
    lastSeq: number;
    courseId?: string | null;
    lessonId?: string | null;
    courseTitle?: string | null;
    lessonTitle?: string | null;
  }): RoomRuntime {
    let parsed: StoredDoc = {};
    try {
      parsed = JSON.parse(row.docJson || '{}') as StoredDoc;
    } catch {
      parsed = {};
    }

    const pages =
      parsed.pages && parsed.pages.length > 0
        ? parsed.pages
        : [
            {
              id: randomUUID(),
              index: 0,
              name: '第 1 页',
              width: DEFAULT_PAGE_WIDTH,
              height: DEFAULT_PAGE_HEIGHT,
              background: null,
            },
          ];

    const elements = new Map<string, WhiteboardElement>();
    for (const el of parsed.elements ?? []) elements.set(el.id, el);

    const firstPageId = pages[0]?.id ?? '';
    const restoredActive =
      parsed.activePageId && pages.some((p) => p.id === parsed.activePageId)
        ? parsed.activePageId
        : firstPageId;

    return {
      id: row.id,
      title: row.title,
      hostId: row.hostId,
      hostName: row.hostName,
      joinCode: row.joinCode,
      status: row.status,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      courseId: row.courseId ?? null,
      lessonId: row.lessonId ?? null,
      courseTitle: row.courseTitle ?? null,
      lessonTitle: row.lessonTitle ?? null,
      seq: Math.max(row.lastSeq, parsed.seq ?? 0),
      studentsCanDraw: parsed.studentsCanDraw !== false,
      activePageId: restoredActive,
      sharingUserId: null,
      doc: { pages, elements },
      members: new Map(),
      offStage: new Set(),
      forceMuted: new Set(),
      forceCameraOff: new Set(),
      allMuted: false,
      rewards: new Map(),
      announcement: null,
      timer: null,
      quiz: null,
      signin: null,
      interactiveLoaded: false,
      lastActiveAt: Date.now(),
      dirty: false,
    };
  }

  serializeDoc(room: RoomRuntime): string {
    const elements = [...room.doc.elements.values()].sort(compareByOrder);
    return JSON.stringify({
      seq: room.seq,
      pages: room.doc.pages,
      elements,
      activePageId: room.activePageId,
      studentsCanDraw: room.studentsCanDraw,
    });
  }

  markDirty(room: RoomRuntime): void {
    room.dirty = true;
    room.lastActiveAt = Date.now();
  }

  addMember(room: RoomRuntime, member: Member): Member | null {
    const existing = room.members.get(member.userId) ?? null;
    room.members.set(member.userId, member);
    room.lastActiveAt = Date.now();
    return existing;
  }

  removeMember(room: RoomRuntime, userId: string): Member | undefined {
    const m = room.members.get(userId);
    if (!m) return undefined;
    room.members.delete(userId);
    room.offStage.delete(userId);
    room.forceMuted.delete(userId);
    room.forceCameraOff.delete(userId);
    if (room.sharingUserId === userId) room.sharingUserId = null;
    room.lastActiveAt = Date.now();
    return m;
  }

  participant(room: RoomRuntime, userId: string): ParticipantDTO | null {
    const m = room.members.get(userId);
    if (!m) return null;
    const onStage = m.staff || !room.offStage.has(m.userId);
    return {
      userId: m.userId,
      displayName: m.displayName,
      role: m.role,
      isStaff: m.staff,
      hasVideo: m.hasVideo,
      hasAudio: m.hasAudio,
      sharing: m.sharing,
      handRaised: m.handRaised,
      handRaisedAt: m.handRaisedAt,
      onStage,
      forceMuted: room.forceMuted.has(m.userId),
      forceCameraOff: room.forceCameraOff.has(m.userId),
      rewardCount: room.rewards.get(m.userId) ?? 0,
      joinedAt: m.joinedAt,
    };
  }

  participants(room: RoomRuntime): ParticipantDTO[] {
    return [...room.members.values()]
      .sort((a, b) => {
        if (a.staff !== b.staff) return a.staff ? -1 : 1;
        const rank = (r: Role): number => (r === 'admin' ? 0 : r === 'teacher' ? 1 : r === 'assistant' ? 2 : 3);
        if (a.role !== b.role) return rank(a.role) - rank(b.role);
        return a.joinedAt - b.joinedAt;
      })
      .map((m) => this.participant(room, m.userId) as ParticipantDTO);
  }

  quizPublic(room: RoomRuntime): QuizPublicState | null {
    const q = room.quiz;
    if (!q || q.ended) return null;
    const totalStudents = [...room.members.values()].filter((m) => !m.staff).length;
    const counts = new Map<string, number>();
    for (const a of q.answers.values()) {
      for (const k of a.answer) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return {
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
    };
  }

  signinPublic(room: RoomRuntime, isStaff: boolean): RoomSigninState | null {
    const s = room.signin;
    if (!s) return null;
    const totalStudents = [...room.members.values()].filter((m) => !m.staff).length;
    const base: RoomSigninState = {
      signinId: s.signinId,
      startedAt: s.startedAt,
      endsAt: s.endsAt,
      done: s.done,
      signedCount: s.signed.size,
      totalStudents,
    };
    if (isStaff) {
      base.signed = [...s.signed.entries()].map(([userId, at]) => ({
        userId,
        displayName: room.members.get(userId)?.displayName ?? '已离开',
        at,
      }));
    }
    return base;
  }

  toDTO(room: RoomRuntime, viewerId: string): RoomDTO {
    const canSeeCode = room.hostId === viewerId;
    return {
      id: room.id,
      title: room.title,
      hostId: room.hostId,
      hostName: room.hostName,
      joinCode: canSeeCode ? room.joinCode : '******',
      status: room.status,
      createdAt: room.createdAt,
      startedAt: room.startedAt,
      endedAt: room.endedAt,
      participantCount: room.members.size,
      courseId: room.courseId,
      lessonId: room.lessonId,
      courseTitle: room.courseTitle,
      lessonTitle: room.lessonTitle,
    };
  }

  /** 进程退出前把所有脏房间刷一遍 */
  list(): RoomRuntime[] {
    return [...this.rooms.values()];
  }

  /** 无人且超过静默期 → 从内存移除（内容已落库，不影响恢复） */
  collectGarbage(): string[] {
    const now = Date.now();
    const dropped: string[] = [];
    for (const [id, room] of this.rooms) {
      if (room.members.size > 0) continue;
      // 没落库的房间不能丢，否则最后一笔会永久丢失
      if (room.dirty) continue;
      if (now - room.lastActiveAt < ROOM_GC_DELAY_MS) continue;
      this.rooms.delete(id);
      dropped.push(id);
    }
    return dropped;
  }

  get size(): number {
    return this.rooms.size;
  }
}
