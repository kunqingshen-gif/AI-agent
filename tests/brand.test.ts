import { describe, expect, it } from 'vitest';
import { SCREENS } from '../src/shared/screens';

/**
 * 界面里不许出现任何真实产品名。
 *
 * 为什么这条要写成测试，而不是写在文档里：
 * 把别人的商标写成自己界面的应用名，是**商标性使用**，不属于「为说明问题
 * 而合理使用」。风险有两个——法律上可能构成侵权或不正当竞争；观感上会让
 * 评委以为我们在复刻官方应用。这两件事都不该靠「记得别写」来避免。
 *
 * 产品定位是「在旁边指路的外挂向导」，不是那个 App 本身。
 * 文档里做比较说明可以用真名，**界面里不行**。
 */
const REAL_PRODUCTS = ['闽政通', '支付宝', '微信', '云闪付', '国家反诈中心', 'e福州'];

describe('界面不冒充任何真实应用', () => {
  it('屏幕标题里没有真实产品名', () => {
    for (const screen of Object.values(SCREENS)) {
      for (const name of REAL_PRODUCTS) {
        expect(screen.title, `${screen.id} 的标题写了「${name}」`).not.toContain(name);
      }
    }
  });

  it('应用名里没有真实产品名', () => {
    for (const screen of Object.values(SCREENS)) {
      for (const name of REAL_PRODUCTS) {
        expect(screen.app, `${screen.id} 的应用名写了「${name}」`).not.toContain(name);
      }
    }
  });

  it('屏幕里出现的文字块也不点名', () => {
    for (const screen of Object.values(SCREENS)) {
      for (const block of screen.blocks) {
        const text =
          block.type === 'text'
            ? block.paragraphs.join('')
            : block.type === 'notice'
              ? block.text
              : '';
        for (const name of REAL_PRODUCTS) {
          expect(text, `${screen.id} 的文案点了「${name}」`).not.toContain(name);
        }
      }
    }
  });
});
