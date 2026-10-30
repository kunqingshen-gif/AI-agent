import type { FlowId, GuideAction, Intent, ScreenId, SessionMetrics, SlotName, TaskId, UserProfile } from '@shared/types';

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
  intent: Intent | null;
  suggestions: FlowId[];
  message: string;
  source: 'llm' | 'rule' | 'none';
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
};
