import { buildServer } from './app';
import type { RealtimeDeps } from './realtime/deps';
import { createIo } from './realtime/io';

async function main(): Promise<void> {
  const app = await buildServer();
  const config = app.appConfig;

  // 上一次进程被 kill 时来不及 close 的参与记录，启动时统一收尾
  await app.repos.participants.closeAllOpen(Date.now());

  // 必须先 ready，app.server 才可用
  await app.ready();

  const deps: RealtimeDeps = {
    config,
    repos: app.repos,
    registry: app.registry,
    roomService: app.roomService,
    turn: app.turn,
    auth: app.auth,
    log: app.log,
  };
  const io = createIo(app, deps);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `服务已启动  http://${config.host}:${config.port}  (socket.io: /socket.io, turn: ${
      config.turn.host || 'stun-only'
    })`,
  );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, '正在关闭…');
    try {
      // 把内存里未落库的白板先写回数据库，避免最后一笔丢失
      for (const room of app.registry.list()) {
        if (!room.dirty) continue;
        await app.repos.rooms.saveDoc(room.id, app.registry.serializeDoc(room), room.seq);
      }
      // 先断开所有 socket，再关 HTTP server —— 避免 io.close() 与 app.close() 争同一个 server
      io.disconnectSockets(true);
      await app.close();
    } catch (err) {
      app.log.error({ err }, '关闭时出错');
    } finally {
      process.exit(0);
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void shutdown(sig);
    });
  }
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
