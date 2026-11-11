interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  0: SpeechRecognitionAlternative;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResult };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

/**
 * 语音能力封装：优先使用浏览器原生 Web Speech API，
 * 不支持时由调用方回退到文字输入（不阻断主流程）。
 *
 * lang 由档案里的常用方言决定：粤语用 zh-HK，其余用 zh-CN。
 * 这是「方言容错」的第一层——先用对语言包听，再谈纠错。
 */
export function getRecognition(lang = 'zh-CN'): SpeechRecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.continuous = false;
  recognition.interimResults = true;
  return recognition;
}

export function speak(text: string, enabled: boolean): void {
  if (!enabled || !text) return;
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 0.85;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}
