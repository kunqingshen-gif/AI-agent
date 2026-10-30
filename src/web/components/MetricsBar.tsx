import type { SessionMetrics } from '@shared/types';

interface Props {
  metrics: SessionMetrics | null;
  active: boolean;
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}分${String(sec).padStart(2, '0')}秒` : `${sec}秒`;
}

/**
 * 对照指标：左边是「没有 Agent 时的基线」，右边是本次实测。
 * 基线来自设计阶段的任务走查（写进产品说明书），不是自测自评的数据。
 */
export function MetricsBar({ metrics, active }: Props) {
  const baselineSteps = metrics?.baselineSteps ?? 12;
  const baselineMs = metrics?.baselineMs ?? 520000;
  const steps = metrics?.stepsGuided ?? 0;
  const elapsed = metrics?.elapsedMs ?? 0;
  const stepRatio = active && steps > 0 ? Math.min(1.4, steps / baselineSteps) : 0;

  return (
    <section className="metrics">
      <div className="metrics-head">
        <span className="metrics-title">本次办理实测</span>
        <span className={`metrics-state ${metrics?.completed ? 'done' : ''}`}>{metrics?.completed ? '已完成' : active ? '进行中' : '未开始'}</span>
      </div>
      <div className="metrics-grid">
        <div className="metric">
          <span className="metric-value">{active ? steps : '—'}</span>
          <span className="metric-label">引导步数 / 基线 {baselineSteps}</span>
          <div className="metric-track">
            <div className="metric-fill" style={{ width: `${Math.min(100, stepRatio * 100)}%` }} />
          </div>
        </div>
        <div className="metric">
          <span className="metric-value">{active ? fmtDuration(elapsed) : '—'}</span>
          <span className="metric-label">已用时长 / 基线 {fmtDuration(baselineMs)}</span>
          <div className="metric-track">
            <div className="metric-fill alt" style={{ width: `${Math.min(100, (elapsed / baselineMs) * 100)}%` }} />
          </div>
        </div>
        <div className="metric">
          <span className="metric-value">{metrics?.wrongTurns ?? 0}</span>
          <span className="metric-label">走错并被纠偏</span>
        </div>
        <div className="metric">
          <span className="metric-value">{metrics?.guardrailsTriggered ?? 0}</span>
          <span className="metric-label">高危动作拦截</span>
        </div>
      </div>
    </section>
  );
}
