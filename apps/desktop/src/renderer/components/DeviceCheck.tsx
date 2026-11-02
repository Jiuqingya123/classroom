import { useCallback, useEffect, useRef, useState } from 'react';
import { requestNativeMediaPermissions } from '../lib/native';
import { Modal } from './ui';
import { MicIcon, VideoIcon } from './Icons';

export function DeviceCheck({ onClose }: { onClose(): void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [testing, setTesting] = useState(false);

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
  }, []);

  const start = useCallback(
    async (cam?: string, mic?: string) => {
      stop();
      setError(null);
      setReady(false);
      try {
        await requestNativeMediaPermissions();
        const stream = await navigator.mediaDevices.getUserMedia({
          video: cam ? { deviceId: { exact: cam } } : true,
          audio: mic ? { deviceId: { exact: mic } } : true,
        });
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setReady(true);

        const devices = await navigator.mediaDevices.enumerateDevices();
        setCameras(devices.filter((d) => d.kind === 'videoinput'));
        setMics(devices.filter((d) => d.kind === 'audioinput'));
        setSpeakers(devices.filter((d) => d.kind === 'audiooutput'));
        const v = stream.getVideoTracks()[0];
        const a = stream.getAudioTracks()[0];
        if (v) setCameraId(v.getSettings().deviceId ?? cam ?? '');
        if (a) setMicId(a.getSettings().deviceId ?? mic ?? '');

        if (a) {
          const ctx = new AudioContext();
          audioCtxRef.current = ctx;
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          src.connect(analyser);
          const buf = new Uint8Array(analyser.frequencyBinCount);
          const tick = (): void => {
            analyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (const x of buf) {
              const d = (x - 128) / 128;
              sum += d * d;
            }
            setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3.2));
            rafRef.current = requestAnimationFrame(tick);
          };
          tick();
        }
      } catch (e) {
        setError(`无法打开摄像头或麦克风：${(e as Error).message}`);
      }
    },
    [stop],
  );

  useEffect(() => {
    void start();
    return stop;
  }, [start, stop]);

  const testSpeaker = (): void => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTesting(true);
    setTimeout(() => {
      osc.stop();
      void ctx.close();
      setTesting(false);
    }, 650);
  };

  return (
    <Modal
      title="设备自检"
      width={640}
      onClose={() => {
        stop();
        onClose();
      }}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => void start(cameraId, micId)}>
            重新检测
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              stop();
              onClose();
            }}
          >
            完成
          </button>
        </>
      }
    >
      {error && <div className="alert alert-error">{error}</div>}
      <div className="device-grid">
        <div className="device-preview">
          <video ref={videoRef} autoPlay playsInline muted />
          {!ready && !error && (
            <div className="device-waiting">
              <span className="spinner" /> 正在打开设备…
            </div>
          )}
          <div className="device-badge">
            <VideoIcon size={13} /> 摄像头画面
          </div>
        </div>
        <div className="device-side">
          <div className="field">
            <label>摄像头</label>
            <select
              className="input"
              value={cameraId}
              onChange={(e) => {
                setCameraId(e.target.value);
                void start(e.target.value, micId);
              }}
            >
              {cameras.length === 0 && <option value="">未检测到摄像头</option>}
              {cameras.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `摄像头 ${i + 1}`}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>麦克风</label>
            <select
              className="input"
              value={micId}
              onChange={(e) => {
                setMicId(e.target.value);
                void start(cameraId, e.target.value);
              }}
            >
              {mics.length === 0 && <option value="">未检测到麦克风</option>}
              {mics.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `麦克风 ${i + 1}`}
                </option>
              ))}
            </select>
            <div className="mic-meter">
              <div className="mic-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <div className="assign-meta">
              <MicIcon size={12} /> 对着麦克风说话，绿色条会随音量变化
            </div>
          </div>
          <div className="field">
            <label>扬声器</label>
            <div className="assign-meta">
              检测到 {speakers.length} 个输出设备
            </div>
            <button className="btn btn-outline btn-sm" disabled={testing} onClick={testSpeaker}>
              {testing ? '正在播放…' : '播放测试音'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
