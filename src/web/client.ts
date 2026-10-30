import type { AnswerPayload, FlowId, GuideAction, Intent, ScreenId, SessionMetrics, SlotName, TaskId, UserProfile } from '@shared/types';
import type { ToolPayload } from '@core/domain/tools';
import type { PreflightResult } from '@core/domain/preflight';
import type { LifeScan } from '@core/domain/lifecycle';
import type { ScamAssessment } from '@core/domain/scam';
import type { CollabTicket } from '@core/domain/collab';

const BASE = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `请求失败（${res.status}）`);
  }
  return (await res.json()) as T;
}

export interface SessionResponse {
  sessionId: string;
  profile: UserProfile;
  screenId: ScreenId;
  tasks: Array<{ taskId: TaskId; title: string; category: string; hotkey: string }>;
}

export interface InterpretResponse {
  ok: boolean;
  /** guide：要办事，进入逐屏引导；answer：在问知识；tool：进了管家的某项能力 */
  mode: 'guide' | 'answer' | 'tool';
  intent: Intent | null;
  suggestions: FlowId[];
  message: string;
  source: 'llm' | 'rule' | 'none';
  /** mode === 'answer' 时的回答内容 */
  answer?: AnswerPayload;
  /** mode === 'tool' 时的结果 */
  tool?: ToolPayload;
  /** 事项未收录、由模型现场规划时才有；前端据此打「AI 现场规划」标 */
  planned?: {
    title: string;
    coverage: 'full' | 'partial';
    steps: number;
    issues: string[];
    injectedGuardrails: string[];
  };
}

export interface MetaResponse {
  llm: { available: boolean; healthy?: boolean; model: string; mode: string; lastError?: string };
  guardrailMode: string;
  screens: number;
}

export const api = {
  meta: () => request<MetaResponse>('/api/meta'),
  createSession: (profile?: Partial<UserProfile>) =>
    request<SessionResponse>('/api/session', { method: 'POST', body: JSON.stringify({ profile }) }),
  interpret: (sessionId: string, utterance: string) =>
    request<InterpretResponse>('/api/intent', { method: 'POST', body: JSON.stringify({ sessionId, utterance }) }),
  guide: (params: {
    sessionId: string;
    screenId: ScreenId;
    slots: Partial<Record<SlotName, string>>;
    attemptsOnScreen: number;
    asksForHelp: boolean;
    tappedControlId?: string;
  }) => request<GuideAction>('/api/guide', { method: 'POST', body: JSON.stringify(params) }),
  extractSlots: (sessionId: string, utterance: string, slot?: string, label?: string) =>
    request<{ slots: Partial<Record<SlotName, string>>; confidence: number; source: string }>('/api/slots/extract', {
      method: 'POST',
      body: JSON.stringify({ sessionId, utterance, slot, label }),
    }),
  rescue: (sessionId: string) =>
    request<{ script: string; hotline: string }>('/api/rescue', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  metrics: (sessionId: string) => request<SessionMetrics>(`/api/session/${sessionId}/metrics`),

  /* 管家能力：与自然语言那条路共用同一批服务方法，结论不会有两套 */
  preflight: (taskId?: TaskId) =>
    request<PreflightResult>('/api/preflight', { method: 'POST', body: JSON.stringify(taskId ? { taskId } : {}) }),
  lifecycle: () => request<LifeScan>('/api/lifecycle'),
  scam: (text: string) => request<ScamAssessment>('/api/scam', { method: 'POST', body: JSON.stringify({ text }) }),
  collabOpen: (sessionId: string) =>
    request<CollabTicket>('/api/collab/open', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  collabJoin: (code: string, helper: string) =>
    request<CollabTicket>('/api/collab/join', { method: 'POST', body: JSON.stringify({ code, helper }) }),
  collabHint: (code: string, text: string) =>
    request<CollabTicket>('/api/collab/hint', { method: 'POST', body: JSON.stringify({ code, text }) }),
  collabClose: (code: string) =>
    request<CollabTicket>('/api/collab/close', { method: 'POST', body: JSON.stringify({ code }) }),
};
