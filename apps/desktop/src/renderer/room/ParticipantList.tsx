import { useState } from 'react';
import type { ParticipantDTO, RoomControlAction } from '@classroom/shared';
import { ROLE_LABEL } from '@classroom/shared';
import { Avatar } from '../components/Avatar';
import { MicIcon, MicOffIcon } from '../components/Icons';

interface Props {
  participants: ParticipantDTO[];
  selfId: string | null;
  canManage: boolean;
  onPrivateChat(p: ParticipantDTO): void;
  onControl(action: RoomControlAction, targetId: string): void;
  onAward(p: ParticipantDTO): void;
}

function statusLine(p: ParticipantDTO): string {
  if (p.handRaised) return '正在举手';
  if (p.sharing) return '正在共享屏幕';
  if (!p.onStage) return '已下台';
  if (p.hasVideo) return '视频已开启';
  if (p.hasAudio) return '语音在线';
  return '已静音';
}

export function ParticipantList({
  participants,
  selfId,
  canManage,
  onPrivateChat,
  onControl,
  onAward,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (participants.length === 0) {
    return <div className="pitem-sub" style={{ padding: '12px 8px' }}>还没有其他人进入</div>;
  }

  const raised = participants.filter((p) => p.handRaised);

  return (
    <div className="plist">
      {raised.length > 0 && (
        <div className="hand-queue">
          <span className="hand-queue-title">{raised.length} 人举手</span>
          <div className="hand-queue-list">
            {raised.map((p) => (
              <span key={p.userId} className="hand-chip">
                {p.displayName}
              </span>
            ))}
          </div>
        </div>
      )}
      {participants.map((p) => {
        const isSelf = p.userId === selfId;
        const canChat = !isSelf && (canManage || p.isStaff);
        const canControl = canManage && !isSelf && !p.isStaff;
        const open = openId === p.userId;
        return (
          <div className="pitem-wrap" key={p.userId}>
            <button
              className="pitem"
              data-open={open}
              onClick={() => setOpenId(open ? null : p.userId)}
            >
              <Avatar name={p.displayName} size={30} />
              <div className="pitem-main">
                <div className="pitem-name">
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.displayName}
                    {isSelf ? '（我）' : ''}
                  </span>
                  {p.isStaff && (
                    <span className="tag tag-teacher">
                      {p.role === 'student' ? '助教' : ROLE_LABEL[p.role]}
                    </span>
                  )}
                  {p.rewardCount > 0 && <span className="reward-chip">+{p.rewardCount}</span>}
                </div>
                <div className="pitem-sub">{statusLine(p)}</div>
              </div>
              <div className="pitem-icons">
                {p.handRaised && <span className="hand-dot" title="举手" />}
                {p.forceMuted && !isSelf && <span className="tag tag-muted">静音</span>}
                <span className={p.hasAudio ? '' : 'muted'} title={p.hasAudio ? '麦克风已开' : '麦克风已关'}>
                  {p.hasAudio ? <MicIcon size={14} /> : <MicOffIcon size={14} />}
                </span>
              </div>
            </button>

            {open && (canChat || canControl) && (
              <div className="pitem-actions">
                {canChat && (
                  <button className="mini-btn" onClick={() => onPrivateChat(p)}>
                    私聊
                  </button>
                )}
                {canControl && (
                  <>
                    <button
                      className="mini-btn"
                      onClick={() => onControl(p.forceMuted ? 'unmute' : 'mute', p.userId)}
                    >
                      {p.forceMuted ? '解除静音' : '静音'}
                    </button>
                    <button
                      className="mini-btn"
                      onClick={() => onControl(p.forceCameraOff ? 'camera_on' : 'camera_off', p.userId)}
                    >
                      {p.forceCameraOff ? '开摄像头' : '关摄像头'}
                    </button>
                    <button
                      className="mini-btn"
                      onClick={() => onControl(p.onStage ? 'remove_stage' : 'invite_stage', p.userId)}
                    >
                      {p.onStage ? '请下台' : '请上台'}
                    </button>
                    {p.handRaised && (
                      <>
                        <button className="mini-btn primary" onClick={() => onControl('approve_hand', p.userId)}>
                          同意发言
                        </button>
                        <button className="mini-btn" onClick={() => onControl('reject_hand', p.userId)}>
                          拒绝举手
                        </button>
                      </>
                    )}
                    <button className="mini-btn" onClick={() => onAward(p)}>
                      奖励
                    </button>
                    <button
                      className="mini-btn danger"
                      onClick={() => {
                        if (window.confirm(`将 ${p.displayName} 移出课堂？`)) onControl('kick', p.userId);
                      }}
                    >
                      移出
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
