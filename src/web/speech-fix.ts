import type { ScreenId } from '@shared/types';
import { SCREENS } from '@shared/screens';

/**
 * 语音听错、方言、老人自己的叫法——三件事都得在「理解意图」之前修一遍。
 *
 * ## 为什么放在前端而不是只放在服务端
 *
 * 屏幕上的字是**此刻这一页**的证据：老人说「高领津贴」，这一页写着「高龄津贴」，
 * 这就是一次可以自证的纠错。前端是唯一同时握着「听到的」和「看到的」的地方。
 * 服务端只拿到一句话，做不了这种联合判断。
 *
 * ## 为什么不能只靠大模型
 *
 * 模型能听懂方言，但没配密钥时整条链路走规则引擎，而规则是字面匹配。
 * 如果容错只写在提示词里，降级的那一刻恰好是最需要容错的时刻，能力却蒸发了。
 * 所以这里是纯函数词典：离线可用、可测、每次行为一致。
 *
 * ## 取舍
 *
 * 只做「已知会被听错的词」，不做通用拼音纠错。通用纠错在没有声学置信度时
 * 很容易把对的改成错的；老人对着一个反复改自己话的机器，会直接放弃。
 * 宁可少改，不可乱改：每条规则都必须是确定的同义/同音，且有据可查。
 */

export type Dialect = '普通话' | '闽南语' | '粤语' | '四川话';

export interface SpeechFix {
  from: string;
  to: string;
  /** screen：这一页上确实写着这个词；dialect：方言词；lexicon：同音/同义词表 */
  via: 'screen' | 'dialect' | 'lexicon';
}

export interface SpeechNormalization {
  /** 归一后的说法，交给意图识别 */
  text: string;
  fixes: SpeechFix[];
  /** 从这句话里认出的方言；没认出就是 null */
  dialect: Dialect | null;
}

interface Rule {
  from: string;
  to: string;
}

/**
 * 同音字：语音识别在老年口音上最常犯的错。
 *
 * 每一条都对应真实听错形态，不做「像就行」的模糊匹配——
 * 模糊匹配会顺手把「高领毛衣」也改成「高龄毛衣」。
 */
const HOMOPHONES: readonly Rule[] = [
  { from: '高领津贴', to: '高龄津贴' },
  { from: '高领老人', to: '高龄老人' },
  { from: '高令津贴', to: '高龄津贴' },
  { from: '低宝', to: '低保' },
  { from: '地保', to: '低保' },
  { from: '水非', to: '水费' },
  { from: '电非', to: '电费' },
  { from: '养老今', to: '养老金' },
  { from: '养老年金', to: '养老金' },
  { from: '人证', to: '认证' },
  { from: '任证', to: '认证' },
  { from: '医宝', to: '医保' },
  { from: '刷脸认证', to: '刷脸认证' },
];

/** 老人的叫法：不是错，是另一套词 */
const COLLOQUIAL: readonly Rule[] = [
  { from: '老人钱', to: '高龄津贴' },
  { from: '老人补贴', to: '高龄津贴' },
  { from: '高龄老人钱', to: '高龄津贴' },
  { from: '养老钱', to: '养老金' },
  { from: '退休工资', to: '养老金' },
  { from: '救助钱', to: '低保' },
  { from: '困难补助', to: '低保' },
  { from: '水费单子', to: '水费' },
  { from: '交水钱', to: '水费' },
  { from: '年审', to: '复核' },
];

/**
 * 方言词表：只收「说出来跟普通话不是一个词」的，不收口音差异。
 *
 * 这三地是演示人群里最常见的（福建、广东、四川），且词表小、可核对。
 * 认不出的方言就老实按普通话处理——假装听懂了比没听懂更危险。
 */
const DIALECT_PACKS: Record<Exclude<Dialect, '普通话'>, readonly Rule[]> = {
  粤语: [
    /*
     * 长句先处理：「唔识点样办」是「不会办、想请人带」的意思，不是提问。
     * 如果只把「点样」翻成「怎么」，就会得到「我不会怎么办低保复核」——
     * 「怎么办」会被问答通道当成知识提问，老人明明是要办事，却被答了一段话。
     * 方言翻译不能逐词替换，得先认出「这是在请求办事」。
     */
    { from: '唔识点样办', to: '想办' },
    { from: '唔识点样', to: '不知道怎样' },
    { from: '唔识', to: '不会' },
    { from: '点样', to: '怎样' },
    { from: '边度', to: '哪里' },
    { from: '搞唔掂', to: '弄不明白' },
    { from: '唔该', to: '麻烦' },
    { from: '系唔系', to: '是不是' },
    { from: '睇唔明', to: '看不懂' },
    { from: '点算', to: '怎么办好' },
  ],
  四川话: [
    { from: '咋个办', to: '想办' },
    { from: '咋个', to: '怎样' },
    { from: '啥子', to: '什么' },
    { from: '晓得', to: '知道' },
    { from: '莫得', to: '没有' },
    { from: '搞不归一', to: '弄不明白' },
    { from: '要得', to: '可以' },
  ],
  闽南语: [
    { from: '按怎办', to: '想办' },
    { from: '按怎', to: '怎样' },
    { from: '毋知影', to: '不知道' },
    { from: '佗位', to: '哪里' },
    { from: '看无', to: '看不懂' },
    { from: '拍谢', to: '不好意思' },
    { from: '敢会当', to: '可不可以' },
  ],
};

const DIALECT_NAMES = Object.keys(DIALECT_PACKS) as Array<Exclude<Dialect, '普通话'>>;

/** 从一句话里判断是哪路方言；判不出返回 null，绝不硬猜 */
export function detectDialect(text: string): Exclude<Dialect, '普通话'> | null {
  let best: Exclude<Dialect, '普通话'> | null = null;
  let hits = 0;
  for (const name of DIALECT_NAMES) {
    const count = DIALECT_PACKS[name].filter((rule) => text.includes(rule.from)).length;
    if (count > hits) {
      hits = count;
      best = name;
    }
  }
  return best;
}

/** 这一页上能被读到的字：标题 + 所有控件标签 + 正文标题 */
export function screenVocabulary(screenId: ScreenId): string {
  const screen = SCREENS[screenId];
  if (!screen) return '';
  const parts: string[] = [screen.title];
  for (const block of screen.blocks) {
    if (block.type === 'grid' || block.type === 'list' || block.type === 'actions' || block.type === 'dialog') {
      for (const item of block.items) parts.push(item.label, item.hint ?? '');
      if (block.type === 'dialog') parts.push(block.title);
    } else if (block.type === 'form') {
      for (const field of block.fields) parts.push(field.label);
    } else if (block.type === 'text') {
      parts.push(block.title ?? '', ...block.paragraphs);
    } else if (block.type === 'result') {
      parts.push(block.title, ...block.lines);
    } else if (block.type === 'notice') {
      parts.push(block.text);
    } else if (block.type === 'profile') {
      parts.push(block.name, ...block.meta);
    }
  }
  for (const tab of screen.tabs ?? []) parts.push(tab.label);
  return parts.join(' ');
}

function applyRules(text: string, rules: readonly Rule[]) {
  let out = text;
  for (const rule of rules) {
    if (out.includes(rule.from) && rule.from !== rule.to) out = out.split(rule.from).join(rule.to);
  }
  return out;
}

/**
 * 屏幕上是不是真的写着这个词。
 *
 * 屏幕上的写法常比标准词多一层修饰：「高龄老人津贴」，标准说法是「高龄津贴」。
 * 直接 includes 会判成「不在这一页上」，把一次有屏幕佐证的纠错降格成猜的。
 * 这里只放开一个确定的差异：中间的「老人 / 老年人」可省。别的都不放开——
 * 放宽到「字差不多」就等于没有证据。
 */
function screenMentions(screenText: string, term: string): boolean {
  if (screenText.includes(term)) return true;
  return screenText.replace(/老年人|老人/g, '').includes(term);
}

/**
 * 归一一段话。
 *
 * 顺序：先方言（把「唔识」变成「不会」），再同义词（「老人钱」→「高龄津贴」），
 * 最后同音字。反过来的话，「高领」先被改成「高龄」也没问题，
 * 但方言词里若含同音字，先方言能少改一次、少报一条假校正。
 */
export function normalizeUtterance(
  utterance: string,
  options: { screenText?: string; dialect?: Dialect } = {},
): SpeechNormalization {
  const fixes: SpeechFix[] = [];
  const screenText = options.screenText ?? '';

  let text = utterance.trim();
  if (!text) return { text: '', fixes, dialect: null };

  const provided = options.dialect && options.dialect !== '普通话' ? options.dialect : null;
  const detected = provided ?? detectDialect(text);
  const dialect: Dialect | null = detected;

  const record = (from: string, to: string, via: SpeechFix['via']) => {
    if (fixes.some((fix) => fix.from === from && fix.to === to)) return;
    fixes.push({ from, to, via });
  };

  if (detected) {
    const pack = DIALECT_PACKS[detected];
    for (const rule of pack) {
      if (text.includes(rule.from)) {
        text = applyRules(text, [rule]);
        record(rule.from, rule.to, 'dialect');
      }
    }
  }

  for (const rule of COLLOQUIAL) {
    if (text.includes(rule.from)) {
      text = applyRules(text, [rule]);
      /* 这一页上确实写着标准说法，才算「看得见的校正」 */
      record(rule.from, rule.to, screenMentions(screenText, rule.to) ? 'screen' : 'lexicon');
    }
  }

  for (const rule of HOMOPHONES) {
    if (text.includes(rule.from)) {
      text = applyRules(text, [rule]);
      record(rule.from, rule.to, screenMentions(screenText, rule.to) ? 'screen' : 'lexicon');
    }
  }

  return { text, fixes: fixes.slice(0, 4), dialect };
}

/** 语音识别该用哪种语言听：只有粤语有可靠的语言包，其余不假装支持 */
export function speechLangOf(dialect?: Dialect): string {
  return dialect === '粤语' ? 'zh-HK' : 'zh-CN';
}
