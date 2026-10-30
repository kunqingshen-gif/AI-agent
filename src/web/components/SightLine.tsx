import { useEffect, useState } from 'react';

/**
 * 把 Agent 的「视线」画在手机屏上。
 *
 * ## 为什么要这个东西
 *
 * 一般 AI 助手和大屏演示的共同问题是：**AI 永远待在右边的对话框里**。
 * 左边是人的世界（手机），右边是 AI 的世界（聊天），中间没有任何连接。
 * 评委看完只会说「哦，一个会说话的搜索框」。
 *
 * 但本产品的核心技术动作是「读屏 → 定位控件 → 指到具体那一个像素」。
 * 这件事如果只写在文档里，评委看不见；画在屏幕上，第一眼就成立：
 * **它真的看见了这一屏，而且知道该指哪。**
 *
 * ## 为什么必须现算坐标
 *
 * 如果坐标写死，换个字号、换个窗口大小、把「字体调大」打开就全错位——
 * 那样画出来的线是骗人的。这里用 `getBoundingClientRect()` 现算，
 * 并用 `ResizeObserver` 跟着屏幕尺寸重算，保证「线指到的就是真的那个控件」。
 * 这也是真机无障碍服务（AccessibilityService 给的是节点 bounds）的同一套语义。
 */
interface Props {
  /** 当前要指的控件 id；没有就只显示「已读完这一屏」 */
  targetId?: string;
  /** 这一屏能被读到的控件数——AI 读屏读到的就是这些 */
  controlCount: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  sw: number;
}

export function SightLine({ targetId, controlCount }: Props) {
  const [box, setBox] = useState<Box | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const measure = () => {
      const root = document.querySelector('.phone-screen');
      if (!root) return;
      const base = root.getBoundingClientRect();
      if (!targetId) {
        setBox(null);
        return;
      }
      const el = root.querySelector<HTMLElement>(`[data-cid="${CSS.escape(targetId)}"]`);
      if (!el) {
        setBox(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setBox({
        x: r.left - base.left,
        y: r.top - base.top,
        w: r.width,
        h: r.height,
        sw: base.width,
      });
    };
    /* 目标刚换、屏幕刚滚、字体刚调大，都要重算 */
    const id = window.setTimeout(measure, 40);
    measure();
    const root = document.querySelector('.phone-screen');
    const ro = root ? new ResizeObserver(measure) : null;
    if (root && ro) ro.observe(root);
    return () => {
      window.clearTimeout(id);
      ro?.disconnect();
    };
  }, [targetId, tick]);

  /* 屏幕内部滚动会让目标移位，用一次性的 rAF 轮询兜住（轻量，仅演示端） */
  useEffect(() => {
    let alive = true;
    let last = '';
    const loop = () => {
      if (!alive) return;
      const root = document.querySelector('.phone-screen');
      const el = targetId && root ? root.querySelector<HTMLElement>(`[data-cid="${CSS.escape(targetId)}"]`) : null;
      const now = el ? el.getBoundingClientRect().top.toFixed(0) : '';
      if (now !== last) {
        last = now;
        setTick((n) => n + 1);
      }
      window.setTimeout(loop, 320);
    };
    const t = window.setTimeout(loop, 320);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [targetId]);

  /*
   * 没目标时：不说「该点哪」（那会抢走老人的注意力），只报告一件事——
   * 这一屏我读完了、有几个入口、我在等您开口。
   *
   * 这一条是给评委看的：它证明 Agent 在用户说话之前就已经把屏幕拆开了，
   * 不是「先问一句、再去现找」。
   */
  if (!targetId || !box) {
    if (targetId) return null;
    return (
      <div className="sight-track" aria-hidden="true">
        <span className="sight-dot" />
        <span className="sight-track-text">已读完这一屏 · {controlCount} 个入口 · 等您说一句话</span>
      </div>
    );
  }

  const pad = 5;
  const bx = box.x - pad;
  const by = box.y - pad;
  const bw = box.w + pad * 2;
  const bh = box.h + pad * 2;
  const cy = by + bh / 2;

  /* 目标贴右边时标签没地方放，就只留三角，不硬塞 */
  const room = box.sw - (bx + bw);
  const showTag = room > 54;

  /*
   * 这里刻意**不画第二个框**——
   * 橙色脉冲环已经是「您点这里」（对老人说的），
   * 蓝色三角是「我看见这里」（对评委说的）。两个语义各用各的颜色，
   * 叠一个框上去只会让人分不清哪个是让他点的。
   */
  return (
    <div className="sight" aria-hidden="true">
      <span className="sight-marker" style={{ top: cy }} />
      {/* 从屏幕边缘牵一条虚线到目标：让「看见」和「指到」在画面上是连续的 */}
      {room > 10 && (
        <span className="sight-lead" style={{ top: cy, left: bx + bw + 4, width: room - 8 }} />
      )}
      {showTag && (
        <span className="sight-tag" style={{ top: cy }}>
          AI 看见这里
        </span>
      )}
    </div>
  );
}
