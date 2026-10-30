import { useEffect, useRef, useState } from 'react';

interface Props {
  open: boolean;
  /** 核验通过后继续办理 */
  onDone: () => void;
  /** 用户主动放弃 */
  onCancel: () => void;
}

type Phase = 'prep' | 'scan' | 'done';
type CamState = 'requesting' | 'live' | 'fallback';

/**
 * 真实的人脸核验体验：调起前置摄像头，椭圆取景框 + 扫描动画，通过后放行。
 *
 * 为什么做在演示层而不是只弹一张提示卡：人脸核验是这个产品最核心的护栏场景，
 * 评委亲手体验一次「AI 坚持让我自己按」的完整流程，胜过十行文案。
 *
 * 兜底：无摄像头 / 用户拒绝授权时，退化为模拟画面继续走完流程——
 * 演示现场任何一台机器（包括虚拟机）都不能在这一步卡死。
 * 注意：核验结果永远是「演示通过」，本产品不采集、不上传、不存储任何影像。
 */
export function FaceVerify({ open, onDone, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cam, setCam] = useState<CamState>('requesting');
  const [phase, setPhase] = useState<Phase>('prep');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    setPhase('prep');
    setCam('requesting');

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setCam('live');
      } catch {
        if (!cancelled) setCam('fallback');
      }
      if (cancelled) return;
      timers.push(setTimeout(() => setPhase('scan'), 700));
      /* 演示节奏：扫 2.6 秒后通过。真实产品里这里是活体检测服务的回调 */
      timers.push(
        setTimeout(() => {
          setPhase('done');
          streamRef.current?.getTracks().forEach((t) => t.stop());
        }, 3300),
      );
    };
    void start();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-mask" role="dialog" aria-modal="true" aria-label="人脸核验">
      <div className="modal face-modal" onClick={(event) => event.stopPropagation()}>
        <h3>请确认是您本人</h3>
        <p className="modal-note">人脸核验必须由本人完成，我不会替您按。</p>

        <div className={`face-stage ${phase === 'scan' ? 'is-scanning' : ''}`}>
          {cam === 'live' ? (
            <video ref={videoRef} className="face-video" muted playsInline autoPlay />
          ) : (
            <div className="face-fallback" aria-hidden="true">
              <svg viewBox="0 0 120 120" width="120" height="120">
                <circle cx="60" cy="44" r="22" fill="none" stroke="currentColor" strokeWidth="3" />
                <path d="M22 104c6-22 20-32 38-32s32 10 38 32" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              <span>{cam === 'requesting' ? '正在打开摄像头…' : '没有摄像头权限，正在用演示画面核验'}</span>
            </div>
          )}
          <div className="face-mask" aria-hidden="true" />
          {phase === 'scan' && <div className="face-scanline" aria-hidden="true" />}
          {phase === 'done' && (
            <div className="face-result" role="status">
              <span className="face-check" aria-hidden="true">✓</span>
              <span>核验通过</span>
            </div>
          )}
        </div>

        <p className="face-status" aria-live="polite">
          {phase === 'prep' && '请摘下口罩帽子，正对屏幕，光线亮一点。'}
          {phase === 'scan' && '请保持不动，正在核对…'}
          {phase === 'done' && '好了，是您本人没错。'}
        </p>

        <div className="modal-actions">
          {phase === 'done' ? (
            <button className="btn-soft btn-soft-accent" onClick={onDone} type="button">
              继续办理
            </button>
          ) : (
            <button className="btn-soft" onClick={onCancel} type="button">
              暂不核验
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
