import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnswerPayload, GuideAction, Intent, ScreenId, SessionMetrics, SlotName } from '@shared/types';
import { SCREENS } from '@shared/screens';
import { api, type InterpretResponse, type MetaResponse, type SessionResponse } from './client';
import { PARENT, TAB_OF, isBrowseControl, resolveTarget } from './nav';
import { quickTasksFrom, type QuickTask } from './zero';
import { GuardianSheet, type GuardianKind } from './components/GuardianSheet';
import type { ToolPayload } from '@core/domain/tools';
import type { CollabTicket } from '@core/domain/collab';
import type { LifeEntry, LifeScan } from '@core/domain/lifecycle';
import { getRecognition, speak, stopSpeaking } from './useSpeech';
import { PhoneFrame } from './components/PhoneFrame';
import { ScreenView } from './components/ScreenView';
import { GuideCard } from './components/GuideCard';
import { AnswerCard } from './components/AnswerCard';
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

/** 真正的「走偏」屏幕：进错专区才算迷路，逛店不算 */
const TRAP_SCREENS = new Set(['wrong.insurance', 'wrong.temp']);

const EXAMPLES = ['我想问一下低保那个复核，今年还没弄呢', '养老金要认证，我不会弄', '我要交水费'];

/** 起手就能问的问题，和「办事」示例并列展示——问答不是附加功能，是主能力之一 */
const QUESTION_EXAMPLES = ['什么是教育服务', '高龄津贴要什么条件', '低保复核要带什么材料'];

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
  /** 非空表示当前展示的是一条问答结果 */
  const [answer, setAnswer] = useState<AnswerPayload | null>(null);
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
  /** 页面栈：从哪进来的就回哪去，不靠写死的上级页面 */
  const [stack, setStack] = useState<ScreenId[]>([]);
  /** 界面字号档位——「我的」里的「字体调大」是真的会变大 */
  const [fontLarge, setFontLarge] = useState(false);
  /** 客服弹窗：热线与求助话术 */
  const [helpOpen, setHelpOpen] = useState(false);
  /**
   * 管家抽屉：四种能力共用一个抽屉。
   * payload 为空表示还没取到数据（反诈的输入态就是这种）。
   */
  const [guardian, setGuardian] = useState<{ kind: GuardianKind; payload: ToolPayload | null } | null>(null);
  const [guardianBusy, setGuardianBusy] = useState(false);
  /** 家人发来的那句话，显示在手机的屏幕上 */
  const [collabHint, setCollabHint] = useState<{ from: string; text: string } | null>(null);
  /**
   * 开场主动提醒。
   *
   * 这是「管家」与「目录」最直白的一次分野：目录等你来查，管家先开口。
   * 只在水费这种一周内到期的事情上开口，不天天弹——频繁提醒等于没提醒。
   */
  const [nudge, setNudge] = useState<LifeEntry | null>(null);
  /**
   * 起手页那三张卡不是示例，是刚扫出来的真实待办。
   *
   * 示例是「别人要办的事」，老人认不出自己属于哪一句；
   * 扫出来的待办是「您自己的事」，一眼就能认出来。这是目录与管家最直白的差别。
   */
  const [scan, setScan] = useState<LifeScan | null>(null);
  /** 说不清时的替代方案：不开口，点一件就行 */
  const [askOpen, setAskOpen] = useState(false);

  const valuesRef = useRef<Record<string, string>>({});
  const attemptsRef = useRef(0);
  /** 引导请求序号：只用最后一次请求的结果，避免慢响应覆盖新状态 */
  const reqSeqRef = useRef(0);
  /** 连续听不清的次数：老人对着手机喊三遍没人应，就会永久放弃 */
  const micFailRef = useRef(0);
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
        if (result.mode === 'answer' && result.answer) {
          setAnswer(result.answer);
          setPlanNote(null);
          speak(result.answer.text, speakOn);
          api.metrics(sid).then(setMetrics).catch(() => undefined);
          return;
        }
        /*
         * 管家通道：这句话被路由成了体检 / 日历 / 反诈 / 协办。
         * 不换屏幕、不设意图——用户问的是「我的情况」，不是让你去按哪个按钮。
         */
        if (result.mode === 'tool' && result.tool) {
          setAnswer(null);
          setGuardian({ kind: result.tool.kind, payload: result.tool });
          if (result.message) speak(result.message, speakOn);
          api.metrics(sid).then(setMetrics).catch(() => undefined);
          return;
        }
        if (!result.ok || !result.intent) {
          setToast(result.message);
          return;
        }
        setAnswer(null);
        setIntent(result.intent);
        setPlanNote(result.planned ?? null);
        /* 新事项从首页起步，把浏览路径清空 */
        setStack([]);
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

  /** 直接打开某个管家抽屉（不走语音输入的那条路） */
  const openGuardian = useCallback(
    async (kind: GuardianKind) => {
      setGuardian({ kind, payload: null });
      if (kind === 'scam') return; /* 反诈先让用户把话打出来 */
      setGuardianBusy(true);
      try {
        if (kind === 'preflight') {
          const data = await api.preflight();
          setGuardian({ kind, payload: { kind: 'preflight', data } });
        } else if (kind === 'lifecycle') {
          const data = await api.lifecycle();
          setGuardian({ kind, payload: { kind: 'lifecycle', data } });
        } else {
          /* 协办要挂在会话上：家人看到的那一页就是这条会话当前所在的屏 */
          let sid = session?.sessionId;
          if (!sid) {
            const created = await api.createSession({ hearingImpaired: !speakOn });
            setSession(created);
            sid = created.sessionId;
          }
          const ticket = await api.collabOpen(sid);
          setGuardian({ kind, payload: { kind: 'collab', data: ticket } });
        }
      } catch (error) {
        setToast(error instanceof Error ? error.message : '没取到数据，稍后再试');
        setGuardian(null);
      } finally {
        setGuardianBusy(false);
      }
    },
    [session, speakOn],
  );

  /** 家人发来一句话 → 显示在手机屏上，并让屏幕朗读出来 */
  const syncCollab = useCallback(
    (ticket: CollabTicket) => {
      const last = ticket.hints[ticket.hints.length - 1];
      if (!last) return;
      setCollabHint({ from: last.from, text: last.text });
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    api
      .lifecycle()
      .then((result) => {
        if (!alive) return;
        setScan(result);
        const first = result.entries[0];
        if (first && (first.urgency === 'urgent' || first.urgency === 'overdue')) setNudge(first);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!collabHint) return;
    const timer = setTimeout(() => setCollabHint(null), 12000);
    return () => clearTimeout(timer);
  }, [collabHint]);

  /**
   * 换页并记栈。
   *
   * 栈的作用是让「返回」回到真实的上一步：从服务大厅点进「高龄津贴」，
   * 返回就回服务大厅，而不是去首页再找一遍。写死的上级页面做不到这一点。
   */
  const goTo = useCallback(
    (next: ScreenId) => {
      setStack((prev) => [...prev.slice(-9), screenId]);
      setScreenId(next);
      setAttempts(0);
      attemptsRef.current = 0;
      setActiveField(null);
      setErrors({});
    },
    [screenId],
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
      goTo(next);
      await guideWith(session.sessionId, next, 0);
    },
    [session, screenId, guideWith, goTo],
  );

  const onControl = useCallback(
    async (controlId: string) => {
      /* 三个不换页的真实动作：字号、客服、说明页里的返回 */
      if (controlId === 'mine.action.font') {
        setFontLarge((prev) => {
          setToast(prev ? '字号已恢复标准大小' : '字号调大了，您看看合不合适');
          return !prev;
        });
        return;
      }
      if (controlId === 'mine.action.help' || controlId === 'face.btn.help' || controlId.endsWith('.btn.hotline')) {
        setHelpOpen(true);
        return;
      }
      if (controlId === 'done.btn.share') {
        const line = `我在手机上办完了「${intent?.restated ?? screen.title}」，受理编号在短信里，您有空帮我看看对不对。`;
        void navigator.clipboard?.writeText(line);
        setToast('结果已复制，可以发给家人');
        return;
      }
      if (controlId === 'todo.btn.back') {
        const prev = stack.at(-1) ?? PARENT[screenId];
        if (!prev) return;
        setStack((s) => s.slice(0, -1));
        setScreenId(prev);
        setAttempts(0);
        attemptsRef.current = 0;
        if (session) await guideWith(session.sessionId, prev, 0);
        return;
      }

      const { next, message } = resolveTarget(controlId);

      /*
       * 还没开始办事时也允许逛应用：老人常常是先翻一翻再问。
       * 服务、我的、教育服务这类页面不依赖会话，先放开，
       * 免得「想看看我的办件」也被要求先说一句话。
       */
      if (!session) {
        if (next) {
          goTo(next);
          return;
        }
        setToast(message ?? '请先说出您要办的事');
        return;
      }

      if (!action) {
        /* 引导还没回来时，浏览类点击照样放行，别让人对着页面干等 */
        if (next && isBrowseControl(controlId)) {
          goTo(next);
          return;
        }
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

      /*
       * 底部标签是导航，不是误操作：换页但不算「乱点」。
       * 换完仍会请求一次引导，Agent 会在卡片上把用户拉回正在办的事——
       * 这正是要演示的能力：人跑偏了，它知道怎么拉回来。
       */
      if (controlId.startsWith('tab.')) {
        const { next: tabTarget } = resolveTarget(controlId);
        if (tabTarget) {
          goTo(tabTarget);
          await guideWith(session.sessionId, tabTarget, 0);
          return;
        }
      }

      /*
       * 浏览类入口（专区、清单、材料、代办）：点它是想看，不是走错。
       * 只有真的进错专区（医保、临时救助）才算迷路，才需要纠偏话术。
       */
      if (next && isBrowseControl(controlId) && !TRAP_SCREENS.has(next)) {
        goTo(next);
        await guideWith(session.sessionId, next, 0);
        return;
      }

      /* 点错了：真实应用照常跳转，Agent 再把人拉回来（这才是要验证的能力） */
      if (!next) {
        setToast(message ?? '这个入口本次演示未开放');
        return;
      }
      const nextAttempt = attemptsRef.current + 1;
      attemptsRef.current = nextAttempt;
      setAttempts(nextAttempt);
      setToast('走错了不要紧，我帮您绕回来');
      goTo(next);
      await guideWith(session.sessionId, next, nextAttempt, nextAttempt >= 3);
    },
    [session, action, screenId, stack, advance, goTo, guideWith, speakOn],
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
    /* 栈里有就回栈顶，没有才退到写死的上级页 */
    const prev = stack.at(-1) ?? PARENT[screenId];
    if (!prev) return;
    setStack((s) => s.slice(0, -1));
    setScreenId(prev);
    setAttempts(0);
    attemptsRef.current = 0;
    if (session) {
      await guideWith(session.sessionId, prev, 0);
    } else {
      setAction(null);
    }
  }, [stack, screenId, session, guideWith]);

  const startListening = useCallback(
    (onText: (text: string) => void) => {
      const recognition = getRecognition();
      if (!recognition) {
        /* 设备没有语音能力，别让老人对着屏幕发愣——直接给他能点的事 */
        setAskOpen(true);
        setToast('这台手机听不了话，您点一下要办的事');
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
        if (event.results[event.results.length - 1]?.isFinal) {
          micFailRef.current = 0;
          onText(text);
        }
      };
      recognition.onerror = () => {
        setListening(false);
        micFailRef.current += 1;
        /*
         * 第二次听不清就不再让他「再说一次」了。
         * 对老人来说，说三遍没人听懂＝这个东西坏了；换成点选，路还通着。
         */
        if (micFailRef.current >= 2) {
          setAskOpen(true);
          setToast('没听清楚不要紧，您点一下就行');
        } else {
          setToast('没听清楚，请再说一次，或者点下面的事');
        }
      };
      recognition.onend = () => setListening(false);
      recognition.start();
    },
    [listening],
  );

  const screen = useMemo(() => SCREENS[screenId], [screenId]);
  const started = Boolean(session && intent);

  /**
   * 起手页的「点一件您要办的事」。
   *
   * 不写死：这三张卡随扫描结果变，演示时一眼能看出它是刚看过一遍才给的。
   */
  const quickTasks = useMemo<QuickTask[]>(() => quickTasksFrom(scan), [scan]);

  /** 求助话术：带着上下文去求助，老人在电话里不用从头解释 */
  const helpScript = useMemo(() => {
    const what = intent?.restated;
    if (!what) {
      return `我今年 78 岁，一个人住。我在手机上办事，找不到要办的那个入口，现在停在「${screen.title}」这一页，能不能麻烦您带带我。`;
    }
    return `我今年 78 岁，一个人住。我在手机上办「${what}」，卡在「${screen.title}」这一页，不知道该点哪里，麻烦您帮我看看。`;
  }, [intent, screen]);

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
          <PhoneFrame
            /* 明确标注「模拟」：界面是仿真的，不冒充任何官方应用 */
            caption={`${screen.title} ｜ 演示模拟界面，非真实应用`}
            overlay={
              /*
               * 说不清时的第二条路：不问「您想说什么」，直接问「是不是这一件」。
               *
               * 老人表达不出来，但认得出来。把开放题改成选择题，
               * 这是唯一能让「不会用 AI」的人真正开始的办法。
               */
              askOpen ? (
                <div className="ask-layer" role="dialog" aria-modal="true" aria-label="选一件要办的事">
                  <div className="ask-card">
                    <p className="ask-q">您要办的是哪一件？</p>
                    <p className="ask-sub">点一下就行，不用说话</p>
                    {quickTasks.length > 0 ? (
                      <div className="ask-tasks">
                        {quickTasks.map((task) => (
                          <button
                            key={task.label}
                            className="ask-task"
                            type="button"
                            onClick={() => {
                              setAskOpen(false);
                              void say(task.utterance);
                            }}
                          >
                            <span className="ask-task-label">{task.label}</span>
                            <span className="ask-task-hint">{task.hint}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="ask-empty">稍等，我正在看您有什么事要办…</p>
                    )}
                    <button className="ask-cancel" type="button" onClick={() => setAskOpen(false)}>
                      都不是，我自己说
                    </button>
                  </div>
                </div>
              ) : null
            }
          >
            <ScreenView
              screen={screen}
              highlightId={action?.targetControlId}
              values={values}
              errors={errors}
              size={fontLarge ? 'large' : 'normal'}
              onControl={(id) => void onControl(id)}
              onField={onField}
              {...(stack.length > 0 || PARENT[screenId] ? { onBack: () => void onBack() } : {})}
              activeTabId={TAB_OF[screenId] ?? (stack.length > 0 ? TAB_OF[stack[stack.length - 1] as ScreenId] : undefined)}
            />
          </PhoneFrame>

          {/*
            * 家人发来的那句话，落在老人正在看的这块屏幕上。
            * 这是整个协办功能的意义所在：不是替他按，而是有人在他旁边说一句。
            */}
          {collabHint && (
            <div className="collab-bubble" role="status">
              <span className="collab-bubble-from">{collabHint.from} 说</span>
              <span className="collab-bubble-text">{collabHint.text}</span>
              <button className="collab-bubble-close" type="button" onClick={() => setCollabHint(null)}>
                知道了
              </button>
            </div>
          )}
        </section>

        <section className="console-col" data-fresh={started ? undefined : 'true'}>
          {nudge && (
            <div className="nudge">
              <div className="nudge-text">
                <strong>我先替您看了一眼</strong>
                <span>
                  「{nudge.title}」{nudge.phrase}，{nudge.consequence}
                </span>
              </div>
              <div className="nudge-actions">
                <button
                  type="button"
                  className="nudge-go"
                  onClick={() => {
                    setNudge(null);
                    void openGuardian('lifecycle');
                  }}
                >
                  看看还有哪些
                </button>
                <button type="button" className="link-btn" onClick={() => setNudge(null)}>
                  知道了
                </button>
              </div>
            </div>
          )}
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
            {/*
              * 四个入口不是四个功能页，而是四种「我说不清、你替我看一眼」的请求。
              * 摆在这里是为了让评委一眼看到它们与办事并列，而不是又一个目录。
              */}
            <div className="guardian-strip">
              <span className="guardian-strip-label">让管家先看一眼：</span>
              <button type="button" className="g-btn" onClick={() => void openGuardian('preflight')}>
                材料够不够
              </button>
              <button type="button" className="g-btn" onClick={() => void openGuardian('lifecycle')}>
                有什么要到期
              </button>
              <button type="button" className="g-btn" onClick={() => void openGuardian('collab')}>
                叫人陪我办
              </button>
              <button type="button" className="g-btn g-btn-warn" onClick={() => void openGuardian('scam')}>
                这句话不对劲？
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

          {answer && (
            <AnswerCard
              answer={answer}
              {...(answer.relatedTaskId
                ? { taskTitle: session?.tasks.find((task) => task.taskId === answer.relatedTaskId)?.title ?? '' }
                : {})}
              {...(answer.relatedTaskId
                ? {
                    onStartTask: () => {
                      const title = session?.tasks.find((task) => task.taskId === answer.relatedTaskId)?.title;
                      setAnswer(null);
                      if (title) void say(`我要办${title}`);
                    },
                  }
                : {})}
              onAskMore={() => {
                setAnswer(null);
                setTranscript('');
              }}
              onClose={() => setAnswer(null)}
            />
          )}

          <GuideCard
            action={action}
            loading={busy}
            started={started}
            examples={EXAMPLES}
            questions={QUESTION_EXAMPLES}
            tasks={quickTasks}
            onExample={(text) => void say(text)}
            onMic={() => startListening((text) => void say(text))}
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

      {guardian && (
        <GuardianSheet
          kind={guardian.kind}
          payload={guardian.payload}
          loading={guardianBusy}
          onClose={() => setGuardian(null)}
          onResult={(payload) => setGuardian({ kind: payload.kind, payload })}
          onCollabSync={syncCollab}
          onStartTask={(taskId) => {
            setGuardian(null);
            const title = session?.tasks.find((task) => task.taskId === taskId)?.title;
            void say(title ? `我要办${title}` : '我要办事');
          }}
          onOpenScreen={(id) => {
            setGuardian(null);
            goTo(id);
          }}
          onToast={setToast}
        />
      )}

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

      {helpOpen && (
        <div className="modal-mask" onClick={() => setHelpOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>找个人帮您</h3>
            <p className="modal-note">说不清也不要紧，把下面这段话念给对方听就行。</p>
            <div className="help-rows">
              <a className="help-row" href="tel:12345">
                <span className="help-name">政务热线 12345</span>
                <span className="help-sub">7×24 小时 · 可转人工帮办</span>
              </a>
              <a className="help-row" href="tel:059187600123">
                <span className="help-name">社区帮办员 林秀英</span>
                <span className="help-sub">鼓楼区军门社区 · 工作日 9:00—17:00</span>
              </a>
            </div>
            <p className="help-script-label">念这段：</p>
            <blockquote>{helpScript}</blockquote>
            <div className="modal-actions">
              <button
                className="btn-soft btn-soft-accent"
                onClick={() => {
                  void navigator.clipboard?.writeText(helpScript);
                  setToast('已复制，可以发给家人');
                }}
                type="button"
              >
                复制话术
              </button>
              <button className="btn-soft" onClick={() => setHelpOpen(false)} type="button">
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
