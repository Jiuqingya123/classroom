import { useEffect, useRef } from 'react';
import type { Role } from '@classroom/shared';
import { colorForName, initial } from '../lib/format';
import { MicIcon, MicOffIcon } from '../components/Icons';

interface VideoTileProps {
  name: string;
  role: Role;
  isSelf: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  handRaised: boolean;
  stream: MediaStream | null;
  speaking?: boolean;
  /** 小条模式：屏幕共享时底部的成员头像条 */
  compact?: boolean;
}

export function VideoTile({
  name,
  role,
  isSelf,
  hasVideo,
  hasAudio,
  handRaised,
  stream,
  speaking,
  compact,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (stream && hasVideo) {
      if (v.srcObject !== stream) v.srcObject = stream;
      void v.play().catch(() => {
        /* autoplay 被拦时用户点一下视频即可 */
      });
    } else {
      v.srcObject = null;
    }
  }, [stream, hasVideo]);

  const showVideo = !!stream && hasVideo;

  return (
    <div className={compact ? 'tile tile-compact' : 'tile'} data-speaking={speaking ? 'true' : 'false'}>
      {showVideo ? (
        <video ref={videoRef} autoPlay playsInline muted className={isSelf ? 'mirror' : ''} />
      ) : (
        <div
          className="tile-avatar"
          style={{
            background: colorForName(name),
            fontSize: compact ? 18 : 24,
            width: compact ? 40 : 64,
            height: compact ? 40 : 64,
          }}
        >
          {initial(name)}
        </div>
      )}

      {role === 'teacher' && <div className="tile-badge">老师</div>}

      {handRaised && <div className="tile-hand">✋</div>}

      <div className="tile-bar">
        <span className="tile-name">
          {name}
          {isSelf ? '（我）' : ''}
        </span>
        <div className="tile-mic" data-on={hasAudio ? 'true' : 'false'}>
          {hasAudio ? <MicIcon size={13} /> : <MicOffIcon size={13} />}
        </div>
      </div>
    </div>
  );
}
