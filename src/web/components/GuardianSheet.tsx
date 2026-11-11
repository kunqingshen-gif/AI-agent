import { useEffect, useState } from 'react';
import type { ScreenId, TaskId } from '@shared/types';
import type { ToolPayload } from '@core/domain/tools';
import type { CollabTicket } from '@core/domain/collab';
import { COLLAB_TTL_MS, MAX_HINTS, collabRemainingMs, isCollabExpired } from '@core/domain/collab';
import { api } from '../client';

/**
 * 管家的四个抽屉。
 *
 * 之所以做成同一张抽屉里的四种内容，而不是四个独立页面：
 * 这四件事在老人的心里是同一种事——「我有个说不清的问题，你替我看一眼」。
 * 分开做就是又一个政务 App 的目录；合起来才是「管家」。
 */

export type GuardianKind = 'preflight' | 'lifecycle' | 'scam' | 'collab';

const KIND_META: Record<GuardianKind, { label: string; sub: string }> = {
  preflight: { label: '办前体检', sub: '提交之前，先把会被退回的理由找出来' },
  lifecycle: { label: '要操心的事', sub: '到期、年检、复核，一件都不漏' },
  scam: { label: '这句话不对劲', sub: '把可疑的话说给我听' },
  collab: { label: '叫人陪我办', sub: '家人能看着，但按不按由您自己定' },
};

const PREFLIGHT_HEAD: Record<'ready' | 'at-risk' | 'blocked', string> = {
  ready: '可以一次办成',
  'at-risk': '能交上去，但有风险',
  blocked: '现在提交会被退回',
};

interface Props {
  kind: GuardianKind;
  payload: ToolPayload | null;
  loading: boolean;
  onClose: () => void;
  onResult: (payload: ToolPayload) => void;
  onCollabSync: (ticket: CollabTicket) => void;
  onStartTask: (taskId: TaskId) => void;
  onOpenScreen: (screenId: ScreenId) => void;
  onToast: (text: string) => void;
}

export function GuardianSheet(props: Props) {
  const { kind, payload, loading, onClose, onResult, onCollabSync, onStartTask, onOpenScreen, onToast } = props;
  const meta = KIND_META[kind];

  return (
    <div className="sheet-mask" onClick={onClose}>
      <aside className="sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={meta.label}>
        <header className="sheet-head">
          <div>
            <span className={`sheet-tag tag-${kind}`}>{meta.label}</span>
            <h3>{meta.sub}</h3>
          </div>
          <button className="sheet-close" onClick={onClose} type="button" aria-label="收起">
            ✕
          </button>
        </header>

        <div className="sheet-body">
          {loading && <p className="muted">正在看……</p>}

          {!loading && kind === 'scam' && !payload && (
            <ScamEntry
              onResult={(result) => onResult(result)}
              onToast={onToast}
            />
          )}

          {!loading && payload?.kind === 'preflight' && (
            <PreflightBody data={payload.data} onToast={onToast} />
          )}

          {!loading && payload?.kind === 'lifecycle' && (
            <LifecycleBody data={payload.data} onStartTask={onStartTask} onOpenScreen={onOpenScreen} />
          )}

          {!loading && payload?.kind === 'scam' && <ScamBody data={payload.data} onToast={onToast} />}

          {!loading && payload?.kind === 'collab' && (
            <CollabBody
              ticket={payload.data}
              onSync={(ticket) => {
                onCollabSync(ticket);
                onResult({ kind: 'collab', data: ticket });
              }}
              onToast={onToast}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

/* ────────────────────────── 办前体检 ────────────────────────── */

function PreflightBody({ data, onToast }: { data: Extract<ToolPayload, { kind: 'preflight' }>['data']; onToast: (text: string) => void }) {
  const tone = data.verdict === 'ready' ? 'ok' : data.verdict === 'at-risk' ? 'warn' : 'bad';
  return (
    <div className="pf">
      <div className={`pf-verdict pf-${tone}`}>
        <strong>{PREFLIGHT_HEAD[data.verdict]}</strong>
        <p>{data.summary}</p>
      </div>

      <div className="pf-meter">
        <div className="pf-meter-head">
          <span>材料就绪度</span>
          <b>{data.score}</b>
          <span className="muted">/ 100</span>
          <span className="pf-rate">估算一次办成率 {data.onePassRate}%</span>
        </div>
        <div className="gauge">
          <div className={`gauge-fill gauge-${tone}`} style={{ width: `${data.score}%` }} />
        </div>
      </div>

      <ul className="pf-list">
        {data.items.map((item) => (
          <li key={item.materialId} className={`pf-row pf-row-${item.level}`}>
            <span className="pf-dot" aria-hidden>
              {item.level === 'blocker' ? '✕' : item.level === 'warning' ? '!' : '✓'}
            </span>
            <div>
              <span className="pf-name">{item.name}</span>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ul>

      {data.fixes.length > 0 && (
        <div className="pf-fixes">
          <p className="pf-fixes-title">现在可以做的：</p>
          {data.fixes.map((fix) => (
            <button
              key={fix.label}
              className="fix-row"
              type="button"
              onClick={() => {
                if (fix.script) {
                  void navigator.clipboard?.writeText(fix.script);
                  onToast('已复制，去窗口可以直接念给工作人员听');
                } else {
                  onToast('这一项在表单里跟您确认');
                }
              }}
            >
              <span className="fix-label">{fix.label}</span>
              <span className="fix-where">{fix.where}</span>
            </button>
          ))}
        </div>
      )}

      <p className="pf-basis">{data.basis}</p>
    </div>
  );
}

/* ────────────────────────── 要操心的事 ────────────────────────── */

const URGENCY_LABEL: Record<string, string> = { overdue: '已过期', urgent: '这周', soon: '要准备', later: '还早' };

function LifecycleBody({
  data,
  onStartTask,
  onOpenScreen,
}: {
  data: Extract<ToolPayload, { kind: 'lifecycle' }>['data'];
  onStartTask: (taskId: TaskId) => void;
  onOpenScreen: (screenId: ScreenId) => void;
}) {
  return (
    <div className="life">
      <div className={`life-summary ${data.overdue > 0 ? 'life-summary-bad' : ''}`}>
        <strong>{data.summary}</strong>
      </div>

      <ul className="life-list">
        {data.entries.map((entry) => (
          <li key={entry.id} className={`life-row life-${entry.urgency}`}>
            <div className="life-top">
              <span className="life-title">{entry.title}</span>
              <span className={`life-badge badge-${entry.urgency}`}>{URGENCY_LABEL[entry.urgency]}</span>
            </div>
            <p className="life-when">
              {entry.phrase} · 截止 {entry.dueAt}
            </p>
            <p className="life-consequence">{entry.consequence}</p>
            <div className="life-actions">
              {entry.relatedTaskId && (
                <button className="btn-soft btn-soft-accent" type="button" onClick={() => onStartTask(entry.relatedTaskId as TaskId)}>
                  {entry.actionLabel}
                </button>
              )}
              {!entry.relatedTaskId && entry.targetScreenId && (
                <button className="btn-soft" type="button" onClick={() => onOpenScreen(entry.targetScreenId as ScreenId)}>
                  {entry.actionLabel}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ────────────────────────── 可疑话术 ────────────────────────── */

const SCAM_HEAD: Record<string, string> = {
  high: '这是诈骗',
  medium: '高度可疑',
  low: '有几处不对劲',
  none: '没听出诈骗的套路',
};

function ScamBody({ data, onToast }: { data: Extract<ToolPayload, { kind: 'scam' }>['data']; onToast: (text: string) => void }) {
  return (
    <div className="scam">
      <div className={`scam-head scam-${data.level}`}>
        <strong>{data.alreadyExposed ? '钱可能已经出去了' : SCAM_HEAD[data.level]}</strong>
        <p>{data.verdict}</p>
      </div>

      {data.hits.length > 0 && (
        <>
          <p className="scam-label">听出这几处：</p>
          <ul className="hit-chips">
            {data.hits.map((hit) => (
              <li key={hit.id}>{hit.label}</li>
            ))}
          </ul>
        </>
      )}

      <p className="scam-label">接下来这么做：</p>
      <ol className="scam-advice">
        {data.advice.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>

      <div className="hotlines">
        {data.hotlines.map((line) => (
          <a key={line.phone} className="hotline" href={`tel:${line.phone}`}>
            <span>{line.name}</span>
            <b>{line.phone}</b>
          </a>
        ))}
      </div>

      {data.familyNote && (
        <button
          className="btn-soft btn-soft-accent scam-share"
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(data.familyNote);
            onToast('已复制，发给家人就行');
          }}
        >
          把这段话发给家人
        </button>
      )}
    </div>
  );
}

function ScamEntry({ onResult, onToast }: { onResult: (payload: ToolPayload) => void; onToast: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const samples = ['有人让我把钱转到安全账户', '说我医保卡涉案，要冻结', '让我下载软件、共享屏幕'];

  const submit = async (text: string) => {
    const value = text.trim();
    if (!value) {
      onToast('把那句话打在这里，或者照着念一遍');
      return;
    }
    setBusy(true);
    try {
      const result = await api.scam(value);
      onResult({ kind: 'scam', data: result, quote: value });
    } catch {
      onToast('网络不太好，再试一次');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scam-entry">
      <p className="muted small">不用讲得有条理，把对方说的那句话照着打出来就行。</p>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={4}
        placeholder="例如：他说我的医保卡在上海违规使用，要我把钱转到安全账户……"
      />
      <div className="scam-samples">
        {samples.map((sample) => (
          <button key={sample} className="chip" type="button" onClick={() => setDraft(sample)}>
            {sample}
          </button>
        ))}
      </div>
      <button className="btn-soft btn-soft-accent" type="button" disabled={busy} onClick={() => void submit(draft)}>
        {busy ? '正在看……' : '帮我看看'}
      </button>
    </div>
  );
}

/* ────────────────────────── 协办码 ────────────────────────── */

const PRESET_HINTS = ['点右上角的返回', '先别点提交，等我看看', '户口簿那格还空着'];

/** 把毫秒念成人话：老人不需要自己算「生成到现在过了多久」 */
function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`;
}

function CollabBody({ ticket, onSync, onToast }: { ticket: CollabTicket; onSync: (ticket: CollabTicket) => void; onToast: (text: string) => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const joined = ticket.status === 'joined';
  const closed = ticket.status === 'closed';

  /*
   * 每秒重算一次剩余时间。
   * 只依赖 closed：票根没换就不重启定时器，换码后由新的 ticket 重新挂载。
   */
  useEffect(() => {
    if (closed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [closed, ticket.code]);

  const expired = !closed && isCollabExpired(ticket, now);
  const remaining = collabRemainingMs(ticket, now);
  const hintsLeft = Math.max(0, MAX_HINTS - ticket.hints.length);
  const canHint = joined && !expired && hintsLeft > 0;

  const run = async (task: () => Promise<CollabTicket>) => {
    setBusy(true);
    try {
      onSync(await task());
    } catch (error) {
      onToast(error instanceof Error ? error.message : '没成功，再试一次');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="collab">
      <div className="code-display" aria-label={`协办码 ${ticket.code}`}>
        {[...ticket.code].map((char, index) => (
          <span key={`${char}-${index}`} className="code-digit">
            {char}
          </span>
        ))}
      </div>
      <p className="collab-note">
        {closed
          ? '这次协办已经结束。需要时重新生成一个码。'
          : expired
            ? `这个码已经过期了（生成后 ${COLLAB_TTL_MS / 60000} 分钟内有效）。`
            : `还剩 ${formatRemaining(remaining)} 有效。`}
        {!closed && !expired && '把这个码念给家人，他在自己手机上输入，就能看到您这一屏。'}
      </p>

      {expired && (
        <div className="collab-expiry" role="status">
          <strong>家人现在接不进来了</strong>
          <span>过期后接入和发言都会被拒绝。重新生成一个码，再念给家人。</span>
          <button
            className="btn-soft btn-soft-accent"
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.collabOpen(ticket.sessionId))}
          >
            重新生成一个码
          </button>
        </div>
      )}

      <div className="collab-safety">
        <strong>他看得到，但按不了。</strong>
        <span>付钱、刷脸、签协议仍然要您自己来。这条边界不因为家人在线而放宽。</span>
      </div>

      <div className="collab-status">
        <span className={joined ? 'dot dot-on' : 'dot'} />
        {joined ? `${ticket.helper} 已接入 · 正在看「${ticket.screenTitle}」` : '等待家人接入……'}
      </div>

      {!joined && (
        <button
          className="btn-soft btn-soft-accent"
          type="button"
          disabled={busy || expired}
          onClick={() => void run(() => api.collabJoin(ticket.code, '女儿'))}
        >
          模拟女儿接入（演示用）
        </button>
      )}

      {joined && (
        <>
          <p className="scam-label">
            {ticket.helper ?? '家人'}可以说一句话，会出现在您的手机屏幕上：
            <span className="hint-quota">还能发 {hintsLeft} 条（一次最多 {MAX_HINTS} 条）</span>
          </p>
          <div className="hint-presets">
            {PRESET_HINTS.map((hint) => (
              <button
                key={hint}
                className="chip"
                type="button"
                disabled={busy || !canHint}
                onClick={() => {
                  void run(() => api.collabHint(ticket.code, hint));
                  onToast('已经发到老人手机上');
                }}
              >
                {hint}
              </button>
            ))}
          </div>
          <div className="hint-input">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={canHint ? '或者自己写一句，最多 40 字' : '这次协办不能再发了'}
              disabled={!canHint}
            />
            <button
              className="btn-soft"
              type="button"
              disabled={busy || !canHint}
              onClick={() => {
                void run(() => api.collabHint(ticket.code, draft));
                setDraft('');
              }}
            >
              发送
            </button>
          </div>

          <ul className="hint-log">
            {ticket.hints.map((hint) => (
              <li key={`${hint.at}-${hint.text}`}>
                <span className="hint-from">{hint.from}</span>
                {hint.text}
              </li>
            ))}
            {ticket.hints.length === 0 && <li className="muted small">还没有发过话。</li>}
          </ul>
        </>
      )}

      <button className="link-btn collab-close" type="button" onClick={() => void run(() => api.collabClose(ticket.code))}>
        结束这次协办
      </button>
    </div>
  );
}
