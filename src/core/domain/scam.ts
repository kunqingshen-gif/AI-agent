/**
 * 可疑话术判别：把「刚才有人打电话说……」变成一次风险判断。
 *
 * 为什么这是 AI 该做的事而不是一个「反诈专栏」：
 * 老人遇到的不是「诈骗类型」，而是一段听不太懂、又不敢挂断的话。
 * 让他自己去反诈页面比对话术，等于要求他先具备识别能力——这恰恰是他没有的。
 * 所以入口必须是「您把那句话学给我听」，输出必须是一句人话：「这是诈骗，挂掉」。
 *
 * 实现取舍：规则打分而不是纯模型。
 *  - 反诈场景误判代价不对称：漏判可能倾家荡产，误判只是多提醒一句，
 *    所以宁可偏向报警，但不能把「我要交水费」判成诈骗（那是灾难性的体验失败）；
 *  - 规则可解释：每条命中都说得出来，老人和家属才肯信；
 *  - 模型不可用时仍能工作，符合本产品「三级兜底」的一贯约束。
 */

export type ScamLevel = 'high' | 'medium' | 'low' | 'none';

export interface ScamHit {
  id: string;
  /** 命中特征的人话说法 */
  label: string;
  weight: number;
}

export interface ScamHotline {
  name: string;
  phone: string;
}

export interface ScamAssessment {
  level: ScamLevel;
  score: number;
  hits: ScamHit[];
  /** 已经把钱/验证码/屏幕交出去了——这时要止损，不是预防 */
  alreadyExposed: boolean;
  /** 一句结论，直接念给用户听 */
  verdict: string;
  /** 接下来做什么，按顺序 */
  advice: string[];
  hotlines: ScamHotline[];
  /** 可复制发给家人的一句话 */
  familyNote: string;
  /** 提到的官方机构（社保局等），用于定向提醒，不单独构成风险 */
  context: string[];
}

interface Feature {
  id: string;
  label: string;
  weight: number;
  pattern: RegExp;
}

/** 行为特征：这些是「骗子会要求您做的事」，单独出现就值得警惕 */
const FEATURES: Feature[] = [
  { id: 'safe-account', label: '让您把钱转到「安全账户」', weight: 45, pattern: /安全账[户号]|安全账号|资金公证|监管账户/ },
  { id: 'transfer', label: '要求转账、汇款', weight: 30, pattern: /转账|汇款|打钱|转过去|转给|把钱转/ },
  { id: 'code', label: '索要验证码', weight: 30, pattern: /验证码|动态码|短信码|校验码|报一下码/ },
  { id: 'case', label: '说您涉嫌案件、违规', weight: 28, pattern: /涉案|洗钱|违法|犯罪|违规使用|涉嫌|被举报/ },
  { id: 'warrant', label: '提到通缉令、逮捕、传票', weight: 30, pattern: /通缉|逮捕|拘留|传票|立案|法院传/ },
  { id: 'freeze', label: '说账户要被冻结、停用', weight: 18, pattern: /冻结|封卡|停用|注销|账户异常|异常消费|异地消费/ },
  { id: 'remote', label: '让您共享屏幕或装软件', weight: 32, pattern: /屏幕共享|共享屏幕|远程控制|远程协助|下载.{0,6}(软件|APP|app)|装个软件/ },
  { id: 'secret', label: '让您别告诉家里人', weight: 32, pattern: /不要告诉|别告诉|不能告诉|保密|别跟家里|不要跟家里/ },
  { id: 'authority', label: '自称公检法办案', weight: 18, pattern: /公检法|公安局|派出所|检察院|法院|警官|办案|刑侦/ },
  { id: 'link', label: '让您点短信里的链接', weight: 20, pattern: /点.{0,4}链接|点击链接|链接.{0,4}打开|网址.{0,4}填/ },
  { id: 'prize', label: '说您中奖、可退款、发补贴', weight: 14, pattern: /中奖|退款|退税|补贴发放|补偿金|领钱|返现/ },
  { id: 'contact', label: '要求加微信、加 QQ', weight: 16, pattern: /加微信|加个微信|加 ?QQ|微信群|扫码加/ },
];

/** 场景词：只说明「对方冒充了谁」，不单独构成风险，用来给定向提醒 */
const CONTEXT_WORDS: Array<{ label: string; pattern: RegExp }> = [
  { label: '社保', pattern: /社保|社会保险/ },
  { label: '医保', pattern: /医保|医疗保险/ },
  { label: '民政', pattern: /民政|低保|救助/ },
  { label: '银行', pattern: /银行|银行卡|卡片/ },
  { label: '快递', pattern: /快递|包裹|邮包/ },
  { label: '运营商', pattern: /电信|移动|联通|话费/ },
];

/** 「已经给出去了」：这时话题从「别上当」变成「赶紧止损」 */
const EXPOSED_PATTERN = /已经.{0,4}(转|汇|给|打|点|发|说|输|共享|下载)|钱.{0,6}(转|汇).{0,4}(过去|出去)|转完|给完了/;

function levelOf(score: number, hits: ScamHit[]): ScamLevel {
  const hasKey = hits.some((h) => h.id === 'safe-account' || h.id === 'remote' || h.id === 'secret' || h.id === 'code');
  if (score >= 60 || (score >= 45 && hasKey)) return 'high';
  if (score >= 30) return 'medium';
  if (score >= 12) return 'low';
  return 'none';
}

const VERDICT: Record<ScamLevel, string> = {
  high: '这是诈骗。别按对方说的做，先把电话挂掉。',
  medium: '听起来很可疑。先别照做，用您自己的号码去核实。',
  low: '有几处不太对劲，多留个心眼。',
  none: '这段话里没听出诈骗的套路。',
};

export function assessScam(text: string): ScamAssessment {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const hits: ScamHit[] = [];
  for (const feature of FEATURES) {
    if (feature.pattern.test(normalized)) {
      hits.push({ id: feature.id, label: feature.label, weight: feature.weight });
    }
  }
  const context = CONTEXT_WORDS.filter((c) => c.pattern.test(normalized)).map((c) => c.label);
  const score = Math.min(100, hits.reduce((sum, hit) => sum + hit.weight, 0));
  const alreadyExposed = EXPOSED_PATTERN.test(normalized);
  /*
   * 钱已经出去了，风险等级就是高危——不再按分数算。
   * 这个时刻用户需要的不是「听起来可疑」，而是「马上打 110」，
   * 分数留在 score 里给报表看，不参与这次的取舍。
   */
  const level = alreadyExposed ? (score >= 12 ? 'high' : 'none') : levelOf(score, hits);

  return {
    level,
    score,
    hits,
    alreadyExposed: alreadyExposed && level !== 'none',
    verdict: alreadyExposed && level !== 'none' ? '钱可能已经出去了，现在要抢时间止损，不是防骗。' : VERDICT[level],
    advice: adviceOf(level, alreadyExposed, context),
    hotlines: hotlinesOf(level, alreadyExposed),
    familyNote: familyNoteOf(level, alreadyExposed, context),
    context,
  };
}

function adviceOf(level: ScamLevel, exposed: boolean, context: string[]): string[] {
  if (level === 'none') {
    return ['如果对方让您转账、报验证码、共享屏幕，立刻停下，回来问我。'];
  }
  if (exposed) {
    return [
      '马上打 110 或 96110，越快越可能拦住这笔钱。',
      '接着打银行客服冻结账户，把转账记录留好。',
      '任何人说能帮您把钱追回来，都是第二次诈骗，不要再转钱。',
      '给家人打电话，让他们陪您去派出所。',
    ];
  }
  const base = [
    '先把电话挂掉，不要回拨，也不要按对方说的转钱。',
  ];
  if (context.length > 0) {
    base.push(`对方说自己是${context.join('、')}的。真要有事，您自己打 12345 或到窗口问，不要用他给的号码。`);
  } else {
    base.push('真要核实，用您自己知道的官方号码，不要用对方给的号码。');
  }
  base.push('验证码、密码、屏幕共享，这三样任何时候都不给。');
  if (level === 'high') {
    base.push('把这件事告诉家里人，让他们帮您一起看。');
    base.push('把对方的号码记下来，可以报给 96110。');
  } else {
    base.push('拿不准就把这段话转给家人，让他们帮您听一遍。');
  }
  return base;
}

function hotlinesOf(level: ScamLevel, exposed: boolean): ScamHotline[] {
  if (level === 'none') return [{ name: '政务服务热线', phone: '12345' }];
  if (exposed) {
    return [
      { name: '报警', phone: '110' },
      { name: '国家反诈专线', phone: '96110' },
    ];
  }
  return [
    { name: '国家反诈专线', phone: '96110' },
    { name: '政务服务热线', phone: '12345' },
  ];
}

function familyNoteOf(level: ScamLevel, exposed: boolean, context: string[]): string {
  if (level === 'none') return '';
  const who = context.length > 0 ? `冒充${context.join('、')}的` : '';
  if (exposed) {
    return `我刚才可能被骗了，已经转了钱。我现在打 110，你能不能过来一趟陪我去派出所。`;
  }
  return `刚才有个${who}电话打给我，说了一些吓人的话，还让我转账。我没按他说的做，你帮我看看这事是不是骗子。`;
}
