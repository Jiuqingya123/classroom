import {
  BoardIcon,
  EndIcon,
  HandIcon,
  LogoutIcon,
  MicIcon,
  MicOffIcon,
  ScreenIcon,
  VideoIcon,
  VideoOffIcon,
} from '../components/Icons';

interface Props {
  hasVideo: boolean;
  hasAudio: boolean;
  handRaised: boolean;
  isHost: boolean;
  sharing: boolean;
  sharingOccupied: boolean;
  boardActive: boolean;
  diagOpen: boolean;
  /** 屏幕共享只在 Electron 端有采集通道，移动端隐藏按钮 */
  canShare: boolean;
  micLocked?: boolean;
  cameraLocked?: boolean;
  onToggleCamera(): void;
  onToggleBoard(): void;
  onToggleMic(): void;
  onToggleHand(): void;
  onToggleShare(): void;
  onToggleDiag(): void;
  onEnd(): void;
  onLeave(): void;
}

export function ControlBar({
  hasVideo,
  hasAudio,
  handRaised,
  isHost,
  sharing,
  sharingOccupied,
  boardActive,
  diagOpen,
  canShare,
  micLocked = false,
  cameraLocked = false,
  onToggleCamera,
  onToggleMic,
  onToggleHand,
  onToggleShare,
  onToggleBoard,
  onToggleDiag,
  onEnd,
  onLeave,
}: Props) {
  return (
    <div className="controlbar">
      <button
        className="ctrl"
        data-off={!hasAudio}
        data-locked={micLocked}
        disabled={micLocked}
        onClick={onToggleMic}
        title={micLocked ? '老师已静音你的麦克风' : hasAudio ? '关闭麦克风' : '打开麦克风'}
      >
        {hasAudio ? <MicIcon size={19} /> : <MicOffIcon size={19} />}
      </button>

      <button
        className="ctrl"
        data-off={!hasVideo}
        data-locked={cameraLocked}
        disabled={cameraLocked}
        onClick={onToggleCamera}
        title={cameraLocked ? '老师已关闭你的摄像头' : hasVideo ? '关闭摄像头' : '打开摄像头'}
      >
        {hasVideo ? <VideoIcon size={19} /> : <VideoOffIcon size={19} />}
      </button>

      <div className="ctrl-sep" />

      <button
        className="ctrl"
        data-warn={handRaised}
        onClick={onToggleHand}
        title={handRaised ? '放下手' : '举手'}
      >
        <HandIcon size={19} />
      </button>

      {canShare && (
        <button
          className="ctrl"
          data-active={sharing}
          disabled={sharingOccupied && !sharing}
          onClick={onToggleShare}
          title={
            sharing
              ? '停止共享'
              : sharingOccupied
                ? '已有其他人在共享屏幕'
                : '共享屏幕'
          }
        >
          <ScreenIcon size={19} />
        </button>
      )}

      <button
        className="ctrl"
        data-active={boardActive}
        onClick={onToggleBoard}
        title={boardActive ? '回到视频视图' : '打开白板'}
      >
        <BoardIcon size={19} />
      </button>

      <button
        className="ctrl"
        data-active={diagOpen}
        onClick={onToggleDiag}
        title="连接诊断"
        style={{ width: 38, fontSize: 11, fontWeight: 600 }}
      >
        诊断
      </button>

      <div className="ctrl-sep" />

      {isHost ? (
        <button className="ctrl ctrl-danger" onClick={onEnd} title="结束课堂（所有学生会被移出）">
          <EndIcon size={17} />
          下课
        </button>
      ) : (
        <button className="ctrl" onClick={onLeave} title="离开课堂">
          <LogoutIcon size={19} />
        </button>
      )}
    </div>
  );
}
