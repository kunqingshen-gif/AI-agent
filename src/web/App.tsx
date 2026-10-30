import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GuideAction, Intent, ScreenId, SessionMetrics, SlotName } from '@shared/types';
import { SCREENS } from '@shared/screens';
import { api, type InterpretResponse, type MetaResponse, type SessionResponse } from './client';
import { PARENT, resolveTarget } from './nav';
import { getRecognition, speak, stopSpeaking } from './useSpeech';
import { PhoneFrame } from './components/PhoneFrame';
import { ScreenView } from './components/ScreenView';
import { GuideCard } from './components/GuideCard';
import { FaceVerify } from './components/FaceVerify';
import { MetricsBar } from './components/MetricsBar';

/** 建立「表单控件 → 业务槽位」索引，用于把界面输入同步给 Agent */
const FIELD_SLOT: Record<string, SlotName> = {};
for (const screen of Object.values(SCREENS)) {
  for (const block of screen.blocks) {
    if (block.type !== 'form') continue;
    for (const field of block.fields) {
      if (field.slot) FIELD_SLOT[field.id] = field.slot;
    }
  }
}

const EXAMPLES = ['我想问一下低保那个复核，今年还没弄呢', '养老金要认证，我不会弄', '我要交水费'];

function collectSlots(values: Record<string, string>): Partial<Record<SlotName, string>> {
  const slots: Partial<Record<SlotName, string>> = {};
  for (const [fieldId, value] of Object.entries(values)) {
    const slot = FIELD_SLOT[fieldId];
    if (slot && value.trim()) slots[slot] = value.trim();
  }
  return slots;
}

function requiredMissing(screenId: ScreenId, values: Record<string, string>): string[] {
  const screen = SCREENS[screenId];
  const missing: string[] = [];
  for (const block of screen.blocks) {
    if (block.type !== 'form') continue;
    for (const field of block.fields) {
      if (field.required && !values[field.id]?.trim()) missing.push(field.id);
    }
  }
  return missing;
}

export function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  /** 仅当事项未收录、由模型现场规划时非空 */
  const [planNote, setPlanNote] = useState<InterpretResponse['planned'] | null>(null);
  const [screenId, setScreenId] = useState<ScreenId>('gov.home');
  const [action, setAction] = useState<GuideAction | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [speakOn, setSpeakOn] = useState(true);
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null);
  const [rescue, setRescue] = useState<{ script: string; hotline: string } | null>(null);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [fieldDraft, setFieldDraft] = useState('');
  const [trace, setTrace] = useState<string[]>([]);
  const [transcript, setTranscript] = useState('');
  /** 非空表示正在进行人脸核验，值为待放行的控件 id */
  const [faceVerify, setFaceVerify] = useState<string | null>(null);

  const valuesRef = useRef<Record<string, string>>({});
  const attemptsRef = useRef(0);
  /** 引导请求序号：只用最后一次请求的结果，避免慢响应覆盖新状态 */
  const reqSeqRef = useRef(0);
  useEffect(() => {
    valuesRef.current = values;
  }, [values]);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
    return () => stopSpeaking();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const guideWith = useCallback(
    async (sid: string, screen: ScreenId, attemptCount: number, asksForHelp = false, tappedControlId?: string) => {
      const token = ++reqSeqRef.current;
      setBusy(true);
      try {
        const next = await api.guide({
          sessionId: sid,
          screenId: screen,
          slots: collectSlots(valuesRef.current),
          attemptsOnScreen: attemptCount,
          asksForHelp,
          ...(tappedControlId ? { tappedControlId } : {}),
        });
        if (token !== reqSeqRef.current) return;
        setAction(next);
        speak(next.speak, speakOn);
        setTrace((prev) => [...prev.slice(-7), `${next.stepLabel}｜${next.kind}｜${next.source}｜${next.latencyMs}ms`]);
        api.metrics(sid).then(setMetrics).catch(() => undefined);
      } catch (error) {
        if (token === reqSeqRef.current) setToast(error instanceof Error ? error.message : '引导失败，请重试');
      } finally {
        if (token === reqSeqRef.current) setBusy(false);
      }
    },
    [speakOn],
  );

  const say = useCallback(
    async (text: string) => {
      const utterance = text.trim();
      if (!utterance) return;
      setBusy(true);
      setTranscript(utterance);
      try {
        let sid = session?.sessionId;
        if (!sid) {
          /* 关掉语音开关即视为听障/静音场景，服务端据此不再生成语音文案 */
          const created = await api.createSession({ hearingImpaired: !speakOn });
          setSession(created);
          sid = created.sessionId;
        }
        const result = await api.interpret(sid, utterance);
        if (!result.ok || !result.intent) {
          setToast(result.message);
          return;
        }
        setIntent(result.intent);
        setPlanNote(result.planned ?? null);
        setScreenId('gov.home');
        setAttempts(0);
        attemptsRef.current = 0;
        await guideWith(sid, 'gov.home', 0);
      } catch (error) {
        setToast(error instanceof Error ? error.message : '识别失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [session, guideWith, speakOn],
  );

  const advance = useCallback(
    async (controlId: string) => {
      if (!session) return;
      if (controlId === 'form.btn.submit') {
        const missing = requiredMissing(screenId, valuesRef.current);
        if (missing.length > 0) {
          setErrors(Object.fromEntries(missing.map((id) => [id, true])));
          setToast(`还有 ${missing.length} 格没填，我帮您一格一格来`);
          await guideWith(session.sessionId, screenId, 0);
          return;
        }
      }
      const { next, message } = resolveTarget(controlId);
      if (!next) {
        /*
         * 指到的入口点下去了，但演示版没有下一页。
         * 这时不能只是弹个提示就完事——得告诉服务端「这一步我点到了」，
         * 否则它会一直指同一个地方，用户以为坏了。
         */
        setToast(message ?? '这个入口本次演示未开放');
        await guideWith(session.sessionId, screenId, 0, false, controlId);
        return;
      }
      setErrors({});
      setScreenId(next);
      setAttempts(0);
      attemptsRef.current = 0;
      setActiveField(null);
      await guideWith(session.sessionId, next, 0);
    },
    [session, screenId, guideWith],
  );

  const onControl = useCallback(
    async (controlId: string) => {
      if (!session) {
        setToast('请先说出您要办的事');
        return;
      }
      if (!action) {
        setToast('稍等，我正在看屏幕');
        return;
      }
      if (action.targetControlId === controlId) {
        /* 人脸核验是护栏场景：AI 不代按，用户本人按了之后还要走真实核验流程 */
        if (action.guardrail === 'biometric') {
          setFaceVerify(controlId);
          speak('请把脸对准圆圈，保持不动。', speakOn);
          return;
        }
        await advance(controlId);
        return;
      }

      /* 点错了：真实应用照常跳转，Agent 再把人拉回来（这才是要验证的能力） */
      const { next: wrongNext, message } = resolveTarget(controlId);
      if (!wrongNext) {
        setToast(message ?? '这个入口本次演示未开放');
        return;
      }
      const nextAttempt = attemptsRef.current + 1;
      attemptsRef.current = nextAttempt;
      setAttempts(nextAttempt);
      setToast('走错了不要紧，我帮您绕回来');
      setScreenId(wrongNext);
      await guideWith(session.sessionId, wrongNext, nextAttempt, nextAttempt >= 3);
    },
    [session, action, screenId, advance, guideWith, speakOn],
  );

  const onField = useCallback((fieldId: string) => {
    setActiveField(fieldId);
    setFieldDraft(valuesRef.current[fieldId] ?? '');
    setErrors((prev) => ({ ...prev, [fieldId]: false }));
  }, []);

  const commitField = useCallback(
    async (fieldId: string, value: string) => {
      const nextValues = { ...valuesRef.current, [fieldId]: value };
      valuesRef.current = nextValues;
      setValues(nextValues);
      setActiveField(null);
      if (session) await guideWith(session.sessionId, screenId, 0);
    },
    [session, screenId, guideWith],
  );

  const applyPrefill = useCallback(async () => {
    if (!action?.prefill || !action.fieldId) return;
    await commitField(action.fieldId, action.prefill.value);
    setToast('已经按您的档案填好了，您核对一下');
  }, [action, commitField]);

  const onRescue = useCallback(async () => {
    if (!session) return;
    try {
      const result = await api.rescue(session.sessionId);
      setRescue(result);
    } catch {
      setToast('获取人工话术失败');
    }
  }, [session]);

  const onBack = useCallback(async () => {
    const parent = PARENT[screenId];
    if (!parent || !session) return;
    setScreenId(parent);
    setAttempts(0);
    attemptsRef.current = 0;
    await guideWith(session.sessionId, parent, 0);
  }, [screenId, session, guideWith]);

  const startListening = useCallback(
    (onText: (text: string) => void) => {
      const recognition = getRecognition();
      if (!recognition) {
        setToast('这台设备不支持语音识别，请直接输入文字');
        return;
      }
      if (listening) {
        recognition.stop();
        setListening(false);
        return;
      }
      setListening(true);
      recognition.onresult = (event) => {
        let text = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const item = event.results[i];
          if (item) text += item[0].transcript;
        }
        setTranscript(text);
        if (event.results[event.results.length - 1]?.isFinal) onText(text);
      };
      recognition.onerror = () => {
        setListening(false);
        setToast('没听清楚，请再说一次或改用文字');
      };
      recognition.onend = () => setListening(false);
      recognition.start();
    },
    [listening],
  );

  const screen = useMemo(() => SCREENS[screenId], [screenId]);
  const started = Boolean(session && intent);

  /* 模型通道徽标：必须反映真实健康状态，不能只报「配了密钥」 */
  const llmBadge = useMemo(() => {
    if (!meta) return { tone: 'badge', text: '检测中' };
    if (!meta.llm.available) return { tone: 'badge badge-off', text: '规则引擎模式' };
    if (meta.llm.healthy === false) return { tone: 'badge badge-warn', text: '模型降级 · 规则兜底' };
    return { tone: 'badge badge-live', text: `模型在线 · ${meta.llm.model}` };
  }, [meta]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">随行帮办</span>
          <span className="brand-sub">AssistGuide · AI 办事导航 Agent</span>
        </div>
        <div className="badges">
          <span className={llmBadge.tone}>{llmBadge.text}</span>
          <span className="badge badge-safe">护栏 {meta?.guardrailMode ?? 'strict'}</span>
          <span className="badge">演示环境</span>
        </div>
      </header>

      <main className="stage">
        <section className="phone-col">
          <PhoneFrame caption={started ? `${screen.app} · ${screen.title}` : '政务服务平台 · 首页'}>
            <ScreenView
              screen={screen}
              highlightId={action?.targetControlId}
              values={values}
              errors={errors}
              onControl={(id) => void onControl(id)}
              onField={onField}
              {...(started && PARENT[screenId] ? { onBack: () => void onBack() } : {})}
            />
          </PhoneFrame>
        </section>

        <section className="console-col">
          <div className="say-box">
            <div className="say-input">
              <input
                value={transcript}
                placeholder="说出您要办的事，例如：我要办低保复核"
                onChange={(event) => setTranscript(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void say(transcript);
                }}
              />
              <button
                className={`mic ${listening ? 'mic-on' : ''}`}
                onClick={() => startListening((text) => void say(text))}
                type="button"
              >
                {listening ? '识别中' : '按住说话'}
              </button>
              <button className="send" onClick={() => void say(transcript)} type="button" disabled={busy}>
                开始
              </button>
            </div>
            {intent && (
              <p className="intent-line">
                已确认：<strong>{intent.restated}</strong>
                <span className="intent-meta">
                  {intent.source === 'llm' ? '模型理解' : '规则匹配'} · 置信度 {intent.confidence.toFixed(2)}
                </span>
              </p>
            )}
            {planNote && (
              <p className="plan-line">
                <span className="plan-badge">AI 现场规划</span>
                <span>
                  {planNote.title} · 共 {planNote.steps} 步
                  {planNote.coverage === 'partial' ? ' · 只排到能确认的那一步' : ''}
                </span>
                {planNote.issues.length > 0 && (
                  <span className="plan-note">挡下 {planNote.issues.length} 处越界指路</span>
                )}
                {planNote.injectedGuardrails.length > 0 && (
                  <span className="plan-note">自动补 {planNote.injectedGuardrails.length} 处护栏</span>
                )}
              </p>
            )}
          </div>

          <GuideCard
            action={action}
            loading={busy}
            started={started}
            examples={EXAMPLES}
            onExample={(text) => void say(text)}
            onSpeak={() => action && speak(action.instruction, true)}
            onPrefill={() => void applyPrefill()}
            onRescue={() => void onRescue()}
          />

          {activeField && (
            <div className="field-editor">
              <div className="field-editor-head">
                <span>填写这一格</span>
                <button className="link-btn" onClick={() => setActiveField(null)} type="button">
                  收起
                </button>
              </div>
              <input
                value={fieldDraft}
                onChange={(event) => setFieldDraft(event.target.value)}
                placeholder="输入内容，或按右侧话筒说出来"
              />
              <div className="field-editor-actions">
                <button
                  className="btn-soft"
                  onClick={() => startListening((text) => void commitField(activeField, text))}
                  type="button"
                >
                  说出来
                </button>
                <button className="btn-soft btn-soft-accent" onClick={() => void commitField(activeField, fieldDraft)} type="button">
                  确认填写
                </button>
              </div>
            </div>
          )}

          <div className="trace">
            <div className="trace-head">
              <span>
                Agent 决策轨迹
                {attempts > 0 && <em className="trace-attempts"> · 乱点 {attempts} 次</em>}
              </span>
              <label className="switch">
                <input type="checkbox" checked={speakOn} onChange={(event) => setSpeakOn(event.target.checked)} />
                <span>语音播报</span>
              </label>
            </div>
            {trace.length === 0 ? (
              <p className="muted small">开始办理后，这里会实时显示每一步的判断来源与耗时。</p>
            ) : (
              <ul className="trace-list">
                {trace.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>

      <MetricsBar metrics={metrics} active={started} />

      {faceVerify && (
        <FaceVerify
          open
          onCancel={() => setFaceVerify(null)}
          onDone={() => {
            const controlId = faceVerify;
            setFaceVerify(null);
            if (controlId) void advance(controlId);
          }}
        />
      )}

      {rescue && (
        <div className="modal-mask" onClick={() => setRescue(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>这是给窗口/热线说的话</h3>
            <p className="modal-note">带着上下文求助，老人在电话里不用重新解释一遍。</p>
            <blockquote>{rescue.script}</blockquote>
            <p className="modal-hotline">可拨打：{rescue.hotline}</p>
            <div className="modal-actions">
              <button
                className="btn-soft btn-soft-accent"
                onClick={() => {
                  void navigator.clipboard?.writeText(rescue.script);
                  setToast('已复制，可以粘贴到短信或微信里');
                }}
                type="button"
              >
                复制话术
              </button>
              <button className="btn-soft" onClick={() => setRescue(null)} type="button">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
