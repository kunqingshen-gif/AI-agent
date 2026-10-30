import type { ReactNode } from 'react';
import type { Control, ScreenBlock, ScreenModel } from '@shared/types';

interface Props {
  screen: ScreenModel;
  highlightId?: string;
  values: Record<string, string>;
  errors: Record<string, boolean>;
  onControl: (controlId: string) => void;
  onField: (fieldId: string) => void;
  onBack?: () => void;
  /** 当前应高亮的底部标签 id（默认第一个） */
  activeTabId?: string;
  /** 字号档位：老人把「字体调大」拨到开，界面文字真的会变大 */
  size?: 'normal' | 'large';
}

const TILE_COLORS = ['#2f6fd0', '#2c8f7a', '#b46a2c', '#8a5cb8', '#c04b52', '#1f7fae', '#5a7d2a', '#a2562f'];

/**
 * 在当前屏幕里查一个控件（或表单格）的中文名。
 *
 * 「下一步」条上要写「点「社保服务」」，而不是「点第 3 个图标」——
 * 老人认名字，不认位置。
 */
function findLabel(screen: ScreenModel, id: string): string | null {
  for (const block of screen.blocks) {
    if (block.type === 'grid' || block.type === 'list' || block.type === 'actions') {
      const hit = block.items.find((item) => item.id === id);
      if (hit) return hit.label;
    }
    if (block.type === 'dialog') {
      const hit = block.items.find((item) => item.id === id);
      if (hit) return hit.label;
    }
    if (block.type === 'form') {
      const hit = block.fields.find((field) => field.id === id);
      if (hit) return hit.label;
    }
  }
  return null;
}

/** 目标是不是一格表单——是的话要打开填写器，而不是「点」它 */
function isFormField(screen: ScreenModel, id: string): boolean {
  return screen.blocks.some((block) => block.type === 'form' && block.fields.some((field) => field.id === id));
}

function Chevron() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
      <path d="M1 1l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 11l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Target({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className={active ? 'target-wrap active' : 'target-wrap'}>
      {children}
      {/* 视觉提示，读屏用户由引导卡片里的 instruction 承担语义，避免重复朗读 */}
      {active && (
        <span className="tap-hint" aria-hidden="true">
          点这里
        </span>
      )}
    </div>
  );
}

export function ScreenView({ screen, highlightId, values, errors, onControl, onField, onBack, activeTabId, size = 'normal' }: Props) {
  const isTarget = (id: string) => highlightId === id;

  const renderControl = (item: Control) => {
    if (item.role === 'icon') {
      const color = TILE_COLORS[(item.label.charCodeAt(0) + item.label.length) % TILE_COLORS.length] ?? '#2f6fd0';
      return (
        <Target key={item.id} active={isTarget(item.id)}>
          <button className="tile" onClick={() => onControl(item.id)} type="button" aria-label={item.label}>
            <span className="tile-icon" style={{ background: color }} aria-hidden="true">
              {item.label.slice(0, 2)}
            </span>
            <span className="tile-label">{item.label}</span>
          </button>
        </Target>
      );
    }

    if (item.role === 'tab') {
      return (
        <button key={item.id} className="tab" onClick={() => onControl(item.id)} type="button">
          {item.label}
        </button>
      );
    }

    if (item.role === 'button') {
      /* 破坏性操作（解除、注销、删除、取消）不该抢主按钮的位置 */
      const destructive = ['解除', '注销', '删除', '取消', '不是我'].some((word) => item.label.includes(word));
      const primary = !destructive;
      return (
        <Target key={item.id} active={isTarget(item.id)}>
          <button
            className={`btn ${primary ? 'btn-primary' : 'btn-ghost'} ${item.risky ? 'btn-risky' : ''}${destructive ? ' btn-destructive' : ''}`}
            onClick={() => onControl(item.id)}
            type="button"
          >
            {item.label}
            {item.risky && <span className="btn-lock">需本人确认</span>}
          </button>
        </Target>
      );
    }

    if (item.role === 'link') {
      return (
        <Target key={item.id} active={isTarget(item.id)}>
          <button className="link-btn" onClick={() => onControl(item.id)} type="button">
            {item.label}
          </button>
        </Target>
      );
    }

    // listItem
    return (
      <Target key={item.id} active={isTarget(item.id)}>
        <button
          className="list-row"
          onClick={() => onControl(item.id)}
          type="button"
          aria-label={item.hint ? `${item.label}，${item.hint}` : item.label}
        >
          <span className="list-main">
            <span className="list-label">{item.label}</span>
            {item.hint && <span className="list-hint">{item.hint}</span>}
          </span>
          <Chevron />
        </button>
      </Target>
    );
  };

  const renderBlock = (block: ScreenBlock) => {
    switch (block.type) {
      case 'search':
        return (
          <div key={block.id} className="search">
            <SearchIcon />
            <span>{block.placeholder}</span>
          </div>
        );
      case 'grid':
        return (
          <div key={block.id} className="grid" style={{ gridTemplateColumns: `repeat(${block.columns}, 1fr)` }}>
            {block.items.map(renderControl)}
          </div>
        );
      case 'list':
        return (
          <div key={block.id} className="list">
            {block.items.map(renderControl)}
          </div>
        );
      case 'text':
        return (
          <section key={block.id} className="text-block">
            {block.title && <h4>{block.title}</h4>}
            {block.paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </section>
        );
      case 'notice':
        return (
          <div key={block.id} className={`notice notice-${block.tone}`}>
            {block.text}
          </div>
        );
      case 'form':
        return (
          <div key={block.id} className="form">
            {block.fields.map((field) => (
              <Target key={field.id} active={isTarget(field.id)}>
                <label className={`field ${errors[field.id] ? 'field-error' : ''}`}>
                  <span className="field-label">
                    {field.label}
                    {field.required && <em>*</em>}
                  </span>
                  <button
                    className="field-input"
                    onClick={() => onField(field.id)}
                    type="button"
                    aria-label={`${field.label}${field.required ? '，必填' : ''}，当前${values[field.id] ? `已填 ${values[field.id]}` : '未填写'}`}
                  >
                    {values[field.id] ? (
                      <span className="field-value">{values[field.id]}</span>
                    ) : (
                      <span className="field-placeholder">{field.placeholder ?? '请填写'}</span>
                    )}
                  </button>
                </label>
              </Target>
            ))}
          </div>
        );
      case 'actions':
        return (
          <div key={block.id} className="actions">
            {block.items.map(renderControl)}
          </div>
        );
      case 'dialog':
        return (
          <div key={block.id} className="dialog-mask">
            <div className="dialog">
              <h4>{block.title}</h4>
              <p>{block.text}</p>
              <div className="dialog-actions">{block.items.map(renderControl)}</div>
            </div>
          </div>
        );
      case 'profile':
        return (
          <div key={block.id} className="profile-card">
            <div className="profile-head">
              <span className="profile-avatar" aria-hidden="true">
                {block.name.slice(0, 1)}
              </span>
              <span className="profile-id">
                <span className="profile-name">
                  {block.name}
                  <span className="profile-badge">{block.badge}</span>
                </span>
                {block.meta.map((line) => (
                  <span key={line} className="profile-meta">
                    {line}
                  </span>
                ))}
              </span>
            </div>
            <div className="profile-stats">
              {block.stats.map((item) => (
                <span key={item.label} className="profile-stat">
                  <strong>{item.value}</strong>
                  <em>{item.label}</em>
                </span>
              ))}
            </div>
          </div>
        );
      case 'result':
        return (
          <div key={block.id} className="result">
            <div className="result-badge">已受理</div>
            <h3>{block.title}</h3>
            <ul>
              {block.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className={`screen${size === 'large' ? ' screen-large' : ''}`} role="region" aria-label={`应用界面：${screen.title}`}>
      <div className="app-bar">
        {onBack ? (
          <button className="app-back" onClick={onBack} type="button" aria-label="返回上一页">
            ‹
          </button>
        ) : (
          <span className="app-back app-back-idle" aria-hidden="true">
            ‹
          </span>
        )}
        <span className="app-title">{screen.title}</span>
        <span className="app-more" aria-hidden="true">
          ⋯
        </span>
      </div>
      <div className="app-body">{screen.blocks.map(renderBlock)}</div>
      {/*
        * 「下一步」条——整套适老设计里最关键的一处。
        *
        * 老人真正的难点不是不会点，是**找不到该点哪个**。高亮环解决了一部分，
        * 但高亮的目标可能在小屏下半截、可能是第九个图标，老人还是要找。
        * 所以这里把那个目标复制成一个固定位置的大按钮：位置永远不变，
        * 老人只需要学会「按最下面那个大按钮」——这件事不用学。
        *
        * 弹窗页不挂这条：弹窗自己有两个大按钮，再挂一条会打架。
        */}
      {(() => {
        if (!highlightId) return null;
        if (screen.blocks.some((block) => block.type === 'dialog')) return null;
        const label = findLabel(screen, highlightId);
        if (!label) return null;
        const field = isFormField(screen, highlightId);
        return (
          <div className="next-bar">
            <button
              className="next-btn"
              type="button"
              onClick={() => (field ? onField(highlightId) : onControl(highlightId))}
            >
              <span className="next-btn-what">{field ? `填「${label}」` : `点「${label}」`}</span>
              <span className="next-btn-go" aria-hidden="true">
                下一步 →
              </span>
            </button>
          </div>
        );
      })()}
      {screen.tabs && (
        <div className="app-tabs">
          {screen.tabs.map((tab, i) => {
            const active = activeTabId ? tab.id === activeTabId : i === 0;
            return (
              <button
                key={tab.id}
                className={`tab ${active ? 'tab-active' : ''}`}
                onClick={() => onControl(tab.id)}
                type="button"
                aria-current={active ? 'page' : undefined}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
