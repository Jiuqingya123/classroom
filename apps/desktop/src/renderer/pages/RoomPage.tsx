import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MAX_PARTICIPANTS, type AwardKind, type ParticipantDTO } from '@classroom/shared';
import { runtime } from '../lib/config';
import { useNav } from '../store/nav';
import { useRoom } from '../store/room';
import { useSession } from '../store/session';
import { ChatPanel } from '../room/ChatPanel';
import { ControlBar } from '../room/ControlBar';
import { CoursewareModal } from '../room/CoursewareModal';
import { DiagnosticsPanel } from '../room/DiagnosticsPanel';
import { InteractionPanel } from '../room/InteractionPanel';
import { ParticipantList } from '../room/ParticipantList';
import { QuizOverlay } from '../room/QuizOverlay';
import { ScreenPicker } from '../room/ScreenPicker';
import { VideoTile } from '../room/VideoTile';
import { WhiteboardPanel } from '../wb/WhiteboardPanel';
import { Modal } from '../components/ui';
import { CopyIcon, UsersIcon, ChatIcon, LogoutIcon, ScreenIcon } from '../components/Icons';
import { formatDuration } from '../lib/format';

/**
 * 远端音频独立播放。视频瓦片会随白板/共享视图、摄像头开关而卸载，
 * 把音频绑在 <video> 上会导致「关摄像头就听不见」——这是课堂级故障。
 */
function RemoteAudioSink({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (!stream) {
      a.srcObject = null;
      return;
    }
    if (a.srcObject !== stream) a.srcObject = stream;

    const tryPlay = (): void => {
      void a.play().catch(() => {
        /* autoplay 被拦时等用户第一次交互再补播 */
      });
    };
    tryPlay();
    window.addEventListener('pointerdown', tryPlay, { once: true });
    return () => window.removeEventListener('pointerdown', tryPlay);
  }, [stream]);

  return <audio ref={ref} autoPlay playsInline />;
}

function ScreenView({
  stream,
  name,
  isSelf,
}: {
  stream: MediaStream | null;
  name: string;
  isSelf: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (stream) {
      if (v.srcObject !== stream) v.srcObject = stream;
      void v.play().catch(() => {
        /* 自动播放被拦时点一下即可 */
      });
    } else {
      v.srcObject = null;
    }
  }, [stream]);

  return (
    <div className="share-main">
      {stream ? (
        <video ref={ref} autoPlay playsInline muted={isSelf} />
      ) : (
        <div className="share-waiting">
          <span className="spinner" />
          正在接收 {name} 的屏幕…
        </div>
      )}
      <div className="share-label">
        <ScreenIcon size={13} />
        {name} 正在共享屏幕
      </div>
    </div>
  );
}

export function RoomPage() {
  const roomId = useNav((s) => s.roomId);
  const code = useNav((s) => s.code);
  const goLobby = useNav((s) => s.goLobby);
  const sessionUser = useSession((s) => s.user);

  const status = useRoom((s) => s.status);
  const error = useRoom((s) => s.error);
  const notice = useRoom((s) => s.notice);
  const noticeMedia = useRoom((s) => s.noticeMedia);
  const room = useRoom((s) => s.room);
  const selfId = useRoom((s) => s.selfId);
  const participants = useRoom((s) => s.participants);
  const messages = useRoom((s) => s.messages);
  const peerViews = useRoom((s) => s.peers);
  const localStream = useRoom((s) => s.localStream);
  const hasVideo = useRoom((s) => s.hasVideo);
  const hasAudio = useRoom((s) => s.hasAudio);
  const handRaised = useRoom((s) => s.handRaised);

  const screenStream = useRoom((s) => s.screenStream);
  const sharing = useRoom((s) => s.sharing);
  const sharingUserId = useRoom((s) => s.sharingUserId);
  const shareSources = useRoom((s) => s.shareSources);
  const sharePickerOpen = useRoom((s) => s.sharePickerOpen);

  const diag = useRoom((s) => s.diag);
  const diagOpen = useRoom((s) => s.diagOpen);
  const wbClient = useRoom((s) => s.wb);

  const timer = useRoom((s) => s.timer);
  const announcement = useRoom((s) => s.announcement);
  const picked = useRoom((s) => s.picked);
  const chatTarget = useRoom((s) => s.chatTarget);
  const setChatTarget = useRoom((s) => s.setChatTarget);
  const dismissAnnouncement = useRoom((s) => s.dismissAnnouncement);
  const dismissPicked = useRoom((s) => s.dismissPicked);
  const control = useRoom((s) => s.control);
  const award = useRoom((s) => s.award);

  const connect = useRoom((s) => s.connect);
  const leave = useRoom((s) => s.leave);
  const toggleCamera = useRoom((s) => s.toggleCamera);
  const toggleMic = useRoom((s) => s.toggleMic);
  const toggleHand = useRoom((s) => s.toggleHand);
  const sendChat = useRoom((s) => s.sendChat);
  const endRoom = useRoom((s) => s.endRoom);
  const dismissNotice = useRoom((s) => s.dismissNotice);
  const openSharePicker = useRoom((s) => s.openSharePicker);
  const closeSharePicker = useRoom((s) => s.closeSharePicker);
  const chooseShareSource = useRoom((s) => s.chooseShareSource);
  const stopShare = useRoom((s) => s.stopShare);
  const toggleDiag = useRoom((s) => s.toggleDiag);

  const [tab, setTab] = useState<'people' | 'chat' | 'interaction'>('people');
  const [stageView, setStageView] = useState<'video' | 'board'>('video');
  const [now, setNow] = useState(Date.now());
  const [panelOpen, setPanelOpen] = useState(false);
  const [coursewareOpen, setCoursewareOpen] = useState(false);
  const [awardTarget, setAwardTarget] = useState<ParticipantDTO | null>(null);
  const [awardKind, setAwardKind] = useState<AwardKind>('star');
  const [awardPoints, setAwardPoints] = useState(5);
  const [awardRemark, setAwardRemark] = useState('');

  useEffect(() => {
    if (roomId) void connect(roomId, code);
  }, [roomId, code, connect]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!notice) return;
    // 带设备类型的提示要留给人点「打开设置」，6 秒比默认的 4.2 秒更从容
    const t = setTimeout(() => dismissNotice(), noticeMedia ? 12000 : 4200);
    return () => clearTimeout(t);
  }, [notice, noticeMedia, dismissNotice]);

  const isHost = room?.hostId === sessionUser?.id;
  const canManage = participants.find((p) => p.userId === selfId)?.isStaff ?? false;

  /**
   * 服务端的 presence 广播刻意排除了发起者自己（避免回声），所以「我」的
   * 摄像头/麦克风状态必须用本地真值覆盖，否则成员列表会一直停在进房那一刻的旧值。
   */
  const people = useMemo(() => {
    const list: ParticipantDTO[] = participants.map((p) =>
      p.userId === selfId ? { ...p, hasVideo, hasAudio, handRaised, sharing } : p,
    );
    if (!list.some((p) => p.userId === selfId)) {
      list.unshift({
        userId: selfId ?? 'self',
        displayName: sessionUser?.displayName ?? '我',
        role: sessionUser?.role ?? 'student',
        hasVideo,
        hasAudio,
        sharing,
        handRaised,
        handRaisedAt: handRaised ? Date.now() : null,
        onStage: true,
        isStaff: isHost,
        forceMuted: false,
        forceCameraOff: false,
        rewardCount: 0,
        joinedAt: room?.startedAt ?? Date.now(),
      });
    }
    return list;
  }, [participants, selfId, sessionUser, hasVideo, hasAudio, handRaised, sharing, room]);

  const tiles = useMemo(
    () =>
      people.map((p) => ({
        key: p.userId,
        name: p.displayName,
        role: p.role,
        isSelf: p.userId === selfId,
        hasVideo: p.hasVideo,
        hasAudio: p.hasAudio,
        handRaised: p.handRaised,
        onStage: p.onStage,
        stream: p.userId === selfId ? localStream : (peerViews[p.userId]?.cam ?? null),
        state: peerViews[p.userId]?.state ?? (p.userId === selfId ? 'connected' : 'new'),
      })),
    [people, selfId, localStream, peerViews],
  );

  const stageTiles = useMemo(() => tiles.filter((t) => t.onStage || t.isSelf), [tiles]);

  const selfParticipant = people.find((p) => p.userId === selfId);
  const micLocked = !!selfParticipant?.forceMuted;
  const cameraLocked = !!selfParticipant?.forceCameraOff;

  /**
   * 共享者是谁：本地正在共享时就是自己。
   *
   * 不能只看 sharingUserId —— 服务端的 presence 广播排除了发起者自己（防回声），
   * 所以共享者本人永远收不到自己的共享状态，只能靠本地的 sharing 标记。
   */
  const shareOwner = sharing ? selfId : sharingUserId;

  const shareView = useMemo(() => {
    if (!shareOwner) return null;
    if (shareOwner === selfId) {
      return { stream: screenStream, name: '你', isSelf: true };
    }
    const holder = people.find((p) => p.userId === shareOwner);
    return {
      stream: peerViews[shareOwner]?.screen ?? null,
      name: holder?.displayName ?? '对方',
      isSelf: false,
    };
  }, [shareOwner, selfId, screenStream, peerViews, people]);

  const nameMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of people) m[p.userId] = p.displayName;
    return m;
  }, [people]);

  const cols = tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : 3;
  const elapsed = room?.startedAt ? now - room.startedAt : 0;
  const timerText = timer
    ? timer.mode === 'countdown' && timer.endsAt
      ? formatDuration(Math.max(0, timer.endsAt - now))
      : formatDuration(now - timer.startedAt)
    : null;
  const showCode = room && room.joinCode !== '******';
  const sharingOccupied = !!sharingUserId && sharingUserId !== selfId;

  if (status === 'error') {
    return (
      <div className="room">
        <div className="room-header">
          <div className="room-title">无法进入课堂</div>
          <div className="topbar-spacer" />
          <button className="btn btn-ghost" style={{ color: '#e8ecf4' }} onClick={goLobby}>
            返回大厅
          </button>
        </div>
        <div className="stage" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="alert alert-error" style={{ maxWidth: 420 }}>
            {error ?? '未知错误'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="room">
      <header className="room-header">
        <div className="room-title">{room?.title ?? '正在连接…'}</div>

        {showCode && (
          <div className="room-code-chip">
            入会码 <strong>{room?.joinCode}</strong>
            <button
              className="icon-btn"
              title="复制入会码"
              onClick={() => void navigator.clipboard.writeText(room?.joinCode ?? '')}
            >
              <CopyIcon size={13} />
            </button>
          </div>
        )}

        {sharingOccupied && (
          <div className="room-code-chip" style={{ color: '#8fb0ff' }}>
            <ScreenIcon size={12} />
            {nameMap[sharingUserId ?? ''] ?? '对方'} 正在共享
          </div>
        )}

        {sharing && (
          <div className="room-code-chip" style={{ color: '#8fe3bf' }}>
            <ScreenIcon size={12} />
            你正在共享
          </div>
        )}

        <div className="topbar-spacer" />

        <div className="m-room-actions">
          <button
            className="icon-btn"
            title="成员"
            onClick={() => {
              setTab('people');
              setPanelOpen(true);
            }}
          >
            <UsersIcon size={17} />
            <span className="m-room-count">{people.length}</span>
          </button>
          <button
            className="icon-btn"
            title="聊天"
            onClick={() => {
              setTab('chat');
              setPanelOpen(true);
            }}
          >
            <ChatIcon size={17} />
          </button>
        </div>

        {wbClient && (
          <div className="room-view-toggle">
            <button data-active={stageView === 'video'} onClick={() => setStageView('video')}>
              视频
            </button>
            <button data-active={stageView === 'board'} onClick={() => setStageView('board')}>
              白板
            </button>
          </div>
        )}

        {canManage && wbClient && (
          <button className="btn btn-ghost btn-sm" style={{ color: '#e8ecf4' }} onClick={() => setCoursewareOpen(true)}>
            课件
          </button>
        )}

        {timerText && (
          <div className="room-timer timer-chip">
            <span className="timer-dot" />
            {timer?.mode === 'countdown' ? '倒计时 ' : '计时 '}
            {timerText}
          </div>
        )}

        <div className="room-timer">
          <span className="live-dot" />
          {formatDuration(elapsed)}
        </div>

        <button className="icon-btn" title="离开课堂" onClick={() => void leave()}>
          <LogoutIcon size={16} />
        </button>
      </header>

      {announcement && (
        <div className="announce-bar">
          <span className="announce-tag">公告</span>
          <span className="announce-text">{announcement.content}</span>
          <span className="announce-by">{announcement.byName}</span>
          <button className="mini-btn" onClick={dismissAnnouncement}>
            收起
          </button>
        </div>
      )}

      {/* 常驻在舞台之外：切换视频/白板/共享只卸载画面，不中断声音 */}
      {Object.entries(peerViews).map(([userId, view]) => (
        <RemoteAudioSink key={userId} stream={view.mic} />
      ))}

      <div className="room-body">
        <div className="stage">
          {stageView === 'board' && wbClient ? (
            <WhiteboardPanel client={wbClient} names={nameMap} />
          ) : shareView ? (
            <div className="share-wrap">
              <ScreenView stream={shareView.stream} name={shareView.name} isSelf={shareView.isSelf} />
              <div className="tile-strip">
                {tiles.map((t) => (
                  <VideoTile
                    key={t.key}
                    name={t.name}
                    role={t.role}
                    isSelf={t.isSelf}
                    hasVideo={t.hasVideo}
                    hasAudio={t.hasAudio}
                    handRaised={t.handRaised}
                    stream={t.stream}
                    compact
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="video-grid" style={{ '--cols': cols } as CSSProperties}>
              {stageTiles.map((t) => (
                <VideoTile
                  key={t.key}
                  name={t.name}
                  role={t.role}
                  isSelf={t.isSelf}
                  hasVideo={t.hasVideo}
                  hasAudio={t.hasAudio}
                  handRaised={t.handRaised}
                  stream={t.stream}
                />
              ))}
            </div>
          )}

          {picked && (
            <div className="picked-stage">
              <div className="picked-label">随机点名</div>
              <div className="picked-name">{picked.displayName}</div>
              <button className="mini-btn" onClick={dismissPicked}>
                知道了
              </button>
            </div>
          )}

          {stageView !== 'board' && (
            <div className="stage-note">
              <UsersIcon size={14} />
              {people.length}/{MAX_PARTICIPANTS} 人在线 · 点对点直连
              {diag && !diag.hasTurn ? ' · 未配置 TURN，跨网可能连不上' : ''}
            </div>
          )}

          <ControlBar
            hasVideo={hasVideo}
            hasAudio={hasAudio}
            handRaised={handRaised}
            isHost={!!isHost}
            sharing={sharing}
            sharingOccupied={sharingOccupied}
            boardActive={stageView === 'board'}
            diagOpen={diagOpen}
            micLocked={micLocked}
            cameraLocked={cameraLocked}
            onToggleCamera={() => void toggleCamera()}
            onToggleMic={toggleMic}
            onToggleHand={toggleHand}
            canShare={runtime.isElectron}
            onToggleShare={() => (sharing ? stopShare() : void openSharePicker())}
            onToggleBoard={() => setStageView((v) => (v === 'board' ? 'video' : 'board'))}
            onToggleDiag={toggleDiag}
            onEnd={() => void endRoom()}
            onLeave={() => void leave()}
          />

          {diagOpen && (
            <DiagnosticsPanel diag={diag} selfId={selfId} names={nameMap} onClose={toggleDiag} />
          )}

          {status === 'connecting' && (
            <div className="connecting">
              <div className="connecting-inner">
                <span className="spinner" />
                正在进入课堂…
              </div>
            </div>
          )}
        </div>

        {panelOpen && <button className="m-room-mask" aria-label="关闭侧栏" onClick={() => setPanelOpen(false)} />}

        <aside className="sidebar" data-open={panelOpen}>
          <div className="sidebar-tabs">
            <button className="sidebar-tab" data-active={tab === 'people'} onClick={() => setTab('people')}>
              <UsersIcon size={14} />
              成员
              <span className="sidebar-tab-count">{people.length}</span>
            </button>
            <button className="sidebar-tab" data-active={tab === 'chat'} onClick={() => setTab('chat')}>
              <ChatIcon size={14} />
              聊天
            </button>
            <button
              className="sidebar-tab"
              data-active={tab === 'interaction'}
              onClick={() => setTab('interaction')}
            >
              互动
            </button>
            <button className="sidebar-tab m-panel-close" onClick={() => setPanelOpen(false)}>
              收起
            </button>
          </div>

          {tab === 'people' ? (
            <div className="sidebar-body">
              <ParticipantList
                participants={people}
                selfId={selfId}
                canManage={canManage}
                onPrivateChat={(p) => {
                  setChatTarget({ userId: p.userId, displayName: p.displayName });
                  setTab('chat');
                }}
                onControl={(action, targetId) => void control(action, targetId)}
                onAward={(p) => {
                  setAwardTarget(p);
                  setAwardKind('star');
                  setAwardPoints(5);
                  setAwardRemark('');
                }}
              />
            </div>
          ) : tab === 'chat' ? (
            <ChatPanel
              messages={messages}
              selfId={selfId}
              target={chatTarget}
              onClearTarget={() => setChatTarget(null)}
              onSend={(text) => sendChat(text, chatTarget?.userId)}
            />
          ) : (
            <div className="sidebar-body">
              <InteractionPanel />
            </div>
          )}
        </aside>
      </div>

      {sharePickerOpen && (
        <ScreenPicker
          sources={shareSources}
          onPick={(id) => void chooseShareSource(id)}
          onClose={closeSharePicker}
        />
      )}

      {coursewareOpen && (
        <CoursewareModal onClose={() => setCoursewareOpen(false)} onGoBoard={() => setStageView('board')} />
      )}

      {awardTarget && (
        <Modal
          title="发放奖励"
          onClose={() => setAwardTarget(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setAwardTarget(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  void award(
                    awardTarget.userId,
                    awardKind,
                    awardPoints,
                    awardRemark.trim() || undefined,
                  ).then(() => setAwardTarget(null));
                }}
              >
                发放
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>学生</label>
              <div className="input" style={{ display: 'flex', alignItems: 'center' }}>
                {awardTarget.displayName}
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>类型</label>
                <select
                  className="input"
                  value={awardKind}
                  onChange={(e) => setAwardKind(e.target.value as AwardKind)}
                >
                  <option value="star">星星</option>
                  <option value="trophy">奖杯</option>
                  <option value="flower">红花</option>
                </select>
              </div>
              <div className="field">
                <label>分值</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={100}
                  value={awardPoints}
                  onChange={(e) => setAwardPoints(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                />
              </div>
            </div>
            <div className="field">
              <label>评语（可选）</label>
              <input
                className="input"
                maxLength={60}
                value={awardRemark}
                placeholder="例如：回答思路清晰"
                onChange={(e) => setAwardRemark(e.target.value)}
              />
            </div>
          </div>
        </Modal>
      )}

      <QuizOverlay />

      {notice && (
        <div className="toast-wrap">
          <div className="toast">
            <span>{notice}</span>
            {noticeMedia && window.desktop && (
              <button
                className="toast-action"
                onClick={() => {
                  void window.desktop?.openMediaSettings(noticeMedia);
                  dismissNotice();
                }}
              >
                打开设置
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
