import { useState } from 'react';
import type { ProfileMemory, ProfileMemoryView } from '@shared/types';

/**
 * 「我记得您的事」——把记忆摊开给老人看，也让他当场改。
 *
 * 为什么这个面板必须存在：
 * 一个会记住你的产品，最该回答的问题就是「你记了我什么、凭什么、怎么删」。
 * 答不上来就等于要求老人凭信任交出自己的画像。
 *
 * 三档用大白话，不用「数字素养」这种词——
 * 让老人评价自己的「数字素养」，本身就是一道他答不上来的题。
 */

const LEVELS: Array<{ value: NonNullable<ProfileMemory['digitalLiteracy']>; label: string; hint: string }> = [
  { value: 'low', label: '慢点讲', hint: '字大、话短、一步一步来' },
  { value: 'medium', label: '一般', hint: '少说两句，重点留着' },
  { value: 'high', label: '我自己会', hint: '直接说点哪儿就行' },
];

function levelLabel(level: ProfileMemoryView['memory']['digitalLiteracy']): string {
  return LEVELS.find((item) => item.value === level)?.label ?? '慢点讲';
}

export function ProfileMemoryPanel({
  view,
  disabled,
  onChange,
  onForget,
}: {
  view: ProfileMemoryView | null;
  disabled: boolean;
  onChange: (patch: ProfileMemory) => void;
  onForget: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!view) {
    return (
      <div className="memory-panel memory-empty">
        <div className="memory-head">我记得您的事</div>
        <p className="muted small">还没开始办事，办一次之后我就知道该怎么跟您说话了。</p>
      </div>
    );
  }

  const { memory, source, expiresAt } = view;
  const daysLeft = expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 86_400_000)) : null;

  return (
    <div className="memory-panel">
      <div className="memory-head">
        我记得您的事
        <span className={`memory-tag ${source === 'stored' ? 'stored' : ''}`}>
          {source === 'stored' ? '上次记下的' : '这次刚记下'}
        </span>
      </div>

      <p className="memory-line">
        {memory.displayName ?? '这位老人'} · {memory.age ? `${memory.age} 岁` : '年龄没填'} ·{' '}
        {memory.livingAlone ? '一个人住' : '和家人住'}
      </p>

      <div className="memory-level">
        <span className="memory-label">怎么给您讲</span>
        <div className="memory-level-btns">
          {LEVELS.map((level) => (
            <button
              key={level.value}
              className={`memory-level-btn ${memory.digitalLiteracy === level.value ? 'on' : ''}`}
              disabled={disabled}
              title={level.hint}
              onClick={() => onChange({ digitalLiteracy: level.value })}
              type="button"
            >
              {level.label}
            </button>
          ))}
        </div>
      </div>
      <p className="memory-hint">
        现在是「{levelLabel(memory.digitalLiteracy)}」：{LEVELS.find((l) => l.value === memory.digitalLiteracy)?.hint}
      </p>

      <p className="memory-note">
        只记称呼、年龄、怎么讲话。身份证号、手机号、家里收入一律不存。
        {daysLeft !== null && <>这条记录 {daysLeft} 天后自动忘掉。</>}
      </p>

      {confirming ? (
        <div className="memory-confirm">
          <span>确定忘掉？忘掉后我得重新问您一遍。</span>
          <button
            className="link-btn danger"
            onClick={() => {
              setConfirming(false);
              onForget();
            }}
            type="button"
          >
            确定忘掉
          </button>
          <button className="link-btn" onClick={() => setConfirming(false)} type="button">
            算了
          </button>
        </div>
      ) : (
        <button className="link-btn" onClick={() => setConfirming(true)} type="button">
          忘掉我的信息
        </button>
      )}
    </div>
  );
}
