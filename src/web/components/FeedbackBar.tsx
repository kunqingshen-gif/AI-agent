import { useState } from 'react';
import type { FeedbackVerdict } from '@shared/types';

/**
 * 办完之后问一句「办成了吗」。
 *
 * ## 为什么只给三个按钮
 *
 * 老人不填量表。问「您对本次服务满意吗」，得到的是沉默或者「还行」——
 * 前者没有信息，后者无法归因。但问「这事儿办成了没有」，
 * 他能立刻答，因为这是事实，不是评价。
 *
 * 三档刻意不对等：
 *  - 办成了 → 算真实一次办成率
 *  - 没办成 → 归因于外部（窗口关门、材料没带），不算产品的错
 *  - 它说错了 → **唯一能反哺提示词和知识库的信号**，权重最高
 *
 * ## 为什么点完就地变一行字
 *
 * 不弹 toast、不弹窗、不跳页。老人点完按钮，界面轻轻变一句话就够了；
 * 再弹一个「感谢您的反馈」反而是打断。这里的原则和整个产品一致：
 * 系统的动作要出现在原地，不要把人带到别处去。
 */
export function FeedbackBar({ onSend }: { onSend: (verdict: FeedbackVerdict) => void }) {
  const [sent, setSent] = useState<FeedbackVerdict | null>(null);

  const pick = (verdict: FeedbackVerdict) => {
    setSent(verdict);
    onSend(verdict);
  };

  if (sent) {
    return (
      <div className="fb fb-done" role="status">
        <span className="fb-done-icon" aria-hidden="true">
          ✓
        </span>
        <span>
          {sent === 'wrong' ? '记下了，这句话我以后不这么说。' : '记下了，谢谢您。'}
        </span>
      </div>
    );
  }

  return (
    <div className="fb">
      <p className="fb-q">这件事办成了吗？</p>
      <div className="fb-btns">
        <button className="fb-btn fb-btn-ok" type="button" onClick={() => pick('worked')}>
          办成了
        </button>
        <button className="fb-btn" type="button" onClick={() => pick('failed')}>
          没办成
        </button>
        <button className="fb-btn fb-btn-wrong" type="button" onClick={() => pick('wrong')}>
          它说错了
        </button>
      </div>
    </div>
  );
}
