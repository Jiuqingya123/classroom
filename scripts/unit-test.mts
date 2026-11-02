/**
 * 不依赖 Electron/浏览器的核心回归测试。
 *
 * 覆盖：白板 reducer 边界、客户端页面上限与同步兜底、房间运行时恢复、
 * CSP 策略。运行：npm run test:unit
 */
import { MAX_PAGES, applyOp, type PageMeta, type WbDoc } from '@classroom/shared';
import { WhiteboardClient, type WhiteboardDeps } from '@classroom/client-core';
import { RoomRegistry } from '../packages/server/src/realtime/RoomRegistry.ts';
import { buildCsp } from '../apps/desktop/src/main/csp.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

function pages(n: number): PageMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    index: i,
    name: `第 ${i + 1} 页`,
    width: 1600,
    height: 900,
    background: null,
  }));
}

const teacher = {
  by: 'teacher-1',
  role: 'teacher' as const,
  studentsCanDraw: true,
  now: Date.now(),
};

/* ── 白板 reducer ─────────────────────────────────────────── */

{
  const doc: WbDoc = { pages: pages(2), elements: new Map() };
  const out = applyOp(doc, { kind: 'page.reorder', order: ['p0', 'p0'] }, teacher);
  check('page.reorder 拒绝重复 id', !out.ok && out.reason === 'bad_op');
  check('page.reorder 被拒后页序不变', doc.pages.map((p) => p.id).join(',') === 'p0,p1');
}

{
  const doc: WbDoc = { pages: pages(MAX_PAGES), elements: new Map() };
  const out = applyOp(
    doc,
    {
      kind: 'page.add',
      page: { id: 'overflow', index: MAX_PAGES, name: 'x', width: 1600, height: 900, background: null },
    },
    teacher,
  );
  check('page.add 超过 MAX_PAGES 被拒绝', !out.ok && out.reason === 'too_large');
  check('被拒绝的页没有进入文档', doc.pages.length === MAX_PAGES);
}

{
  const doc: WbDoc = { pages: pages(2), elements: new Map() };
  doc.elements.set('el-1', {
    id: 'el-1',
    pageId: 'p1',
    type: 'pen',
    order: 'a0',
    points: [0, 0, 10, 10],
    style: { stroke: '#000', strokeWidth: 2, opacity: 1 },
    rev: 1,
    createdBy: 't',
    updatedAt: 1,
    deleted: false,
  } as never);
  const out = applyOp(doc, { kind: 'page.del', pageId: 'p1' }, teacher);
  check('page.del 成功', out.ok);
  check('page.del 清理该页元素', doc.elements.size === 0 && doc.pages.length === 1);
}

/* ── 客户端页面管理 ───────────────────────────────────────── */

function makeClient(role: 'teacher' | 'student' = 'teacher'): {
  client: WhiteboardClient;
  sent: { ops: number; pages: string[] };
} {
  const sent = { ops: 0, pages: [] as string[] };
  const deps: WhiteboardDeps = {
    selfId: 'self',
    role,
    sendOp: () => {
      sent.ops += 1;
    },
    sendPreview: () => {},
    sendCursor: () => {},
    sendPage: (pageId) => sent.pages.push(pageId),
    sendLock: () => {},
  };
  return { client: new WhiteboardClient(deps), sent };
}

{
  const { client } = makeClient();
  client.applySync({
    pageId: 'missing',
    seq: 1,
    pages: pages(2),
    elements: [],
    studentsCanDraw: true,
  });
  check('applySync 对不存在的页回退到第一页', client.activePageId === 'p0');
}

{
  const { client } = makeClient();
  client.applySync({
    pageId: 'p1',
    seq: 1,
    pages: pages(2),
    elements: [],
    studentsCanDraw: true,
  });
  client.applyBroadcast({ pageId: 'p1', seq: 2, by: 't', opId: 'o', ops: [{ kind: 'page.del', pageId: 'p1' }], revs: {} });
  check('广播删除当前页后自动切到剩余页', client.activePageId === 'p0');
  check('广播删除后文档只剩一页', client.doc.pages.length === 1);
}

{
  const { client, sent } = makeClient();
  client.applySync({
    pageId: 'p0',
    seq: 1,
    pages: pages(MAX_PAGES),
    elements: [],
    studentsCanDraw: true,
  });
  client.addPage();
  check('客户端在 MAX_PAGES 时不再加页', client.doc.pages.length === MAX_PAGES);
  check('超限时不发送 page.add', sent.ops === 0);
}

{
  const { client, sent } = makeClient();
  client.applySync({
    pageId: 'p0',
    seq: 1,
    pages: pages(MAX_PAGES - 2),
    elements: [],
    studentsCanDraw: true,
  });
  const ids = client.addPagesWithBackground(
    Array.from({ length: 5 }, (_, i) => ({ name: `导入 ${i}`, width: 100, height: 100, fileId: `f${i}` })),
  );
  check('批量导入按剩余额度截断', ids.length === 2 && client.doc.pages.length === MAX_PAGES);
  check('批量导入只发一批 op', sent.ops === 1);
}

/* ── 房间运行时恢复 ───────────────────────────────────────── */

const row = (docJson: string) => ({
  id: 'room-1',
  title: '测试课堂',
  hostId: 'teacher-1',
  hostName: '王老师',
  joinCode: '123456',
  status: 'open' as const,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
  docJson,
  lastSeq: 7,
});

{
  const registry = new RoomRegistry(null as never);
  const room = registry.hydrate(
    row(
      JSON.stringify({
        pages: pages(2),
        elements: [],
        activePageId: 'deleted-page',
        studentsCanDraw: false,
      }),
    ),
  );
  check('恢复时无效 activePageId 回退到第一页', room.activePageId === 'p0');
  check('恢复时保留白板锁定状态', room.studentsCanDraw === false);
  check('恢复时保留 seq', room.seq === 7);
  const saved = JSON.parse(registry.serializeDoc(room)) as { studentsCanDraw?: boolean };
  check('序列化包含锁定状态', saved.studentsCanDraw === false);
}

{
  const release: { fn: (() => void) | null } = { fn: null };
  const gate = new Promise<void>((resolve) => {
    release.fn = resolve;
  });
  const fakeRepos = {
    rooms: {
      findById: () => gate.then(() => row(JSON.stringify({ pages: pages(1), elements: [] }))),
    },
  };
  const registry = new RoomRegistry(fakeRepos as never);
  const a = registry.getOrLoad('room-1');
  const b = registry.getOrLoad('room-1');
  release.fn?.();
  const [ra, rb] = await Promise.all([a, b]);
  check('并发首次加载复用同一个运行时', !!ra && ra === rb);
}

{
  const fakeRepos = {
    rooms: {
      findById: async () => row(JSON.stringify({ pages: pages(1), elements: [] })),
    },
  };
  const registry = new RoomRegistry(fakeRepos as never);
  const room = await registry.getOrLoad('room-1');
  if (!room) throw new Error('测试数据加载失败');
  registry.markDirty(room);
  room.lastActiveAt = 0;
  check('脏房间不会被 GC 回收', registry.collectGarbage().length === 0);
  room.dirty = false;
  check('干净且空闲的房间会被回收', registry.collectGarbage().length === 1);
}

/* ── CSP ──────────────────────────────────────────────────── */

{
  const server = 'http://classroom.test:9000';
  const prod = buildCsp(server, false);
  check('生产 CSP 放行课件图片源', /img-src[^;]*http:\/\/classroom\.test:9000/.test(prod));
  check('生产 CSP connect-src 含 API 与 WebSocket', /connect-src[^;]*http:\/\/classroom\.test:9000[^;]*ws:\/\/classroom\.test:9000/.test(prod));
  check('生产 CSP 不放行任意 https/wss', !/connect-src[^;]*(https:|wss:)/.test(prod));
  check('生产 CSP 禁止 eval', !/script-src[^;]*unsafe-eval/.test(prod));

  const dev = buildCsp(server, true);
  check('开发 CSP 保留 eval（Vite HMR）', /script-src[^;]*unsafe-eval/.test(dev));
  check('开发 CSP 放行 localhost HMR', /ws:\/\/localhost:\*/.test(dev));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
