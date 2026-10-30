import { describe, expect, it } from 'vitest';
import { SCREENS } from '@shared/screens';
import { type ScreenId, SCREEN_IDS } from '@shared/types';
import { NAV, PARENT, TAB_OF, UI_ACTIONS, isBrowseControl, resolveTarget } from '../src/web/nav';

/**
 * 导航契约：屏幕上看得见的东西，点下去必须有反应。
 *
 * 这条约束不是洁癖。适老产品里最伤人的不是「功能少」，而是「点了没动静」——
 * 老人会以为手机坏了、自己按错了，然后放弃。所以把「无死路」写成测试，
 * 谁再加一个点不动的入口，CI 就会拦下来。
 */
describe('屏幕库完整性', () => {
  it('SCREEN_IDS 与屏幕库一一对应，不多不少', () => {
    expect(Object.keys(SCREENS).sort()).toEqual([...SCREEN_IDS].sort());
  });

  it('每个屏幕都有可读的业务语义', () => {
    for (const id of SCREEN_IDS) {
      expect(SCREENS[id].semantics.length, `${id} 缺少语义`).toBeGreaterThan(10);
    }
  });
});

describe('服务与我的：点得动、回得来', () => {
  it('列表、宫格、按钮类控件点下去都有下一页或本地动作', () => {
    for (const screenId of SCREEN_IDS) {
      const screen = SCREENS[screenId];
      for (const block of screen.blocks) {
        if (block.type !== 'list' && block.type !== 'grid' && block.type !== 'actions' && block.type !== 'dialog') continue;
        for (const item of block.items) {
          if (item.role === 'tab') continue;
          if (UI_ACTIONS.has(item.id)) continue;
          const { next } = resolveTarget(item.id);
          expect(next, `${screenId}/${item.id}「${item.label}」点了没有下一页`).toBeDefined();
        }
      }
    }
  });

  it('服务大厅与我的页的每个入口都能落到真实屏幕', () => {
    for (const screenId of ['gov.service', 'gov.mine', 'gov.all'] as const) {
      const screen = SCREENS[screenId];
      for (const block of screen.blocks) {
        if (block.type !== 'list' && block.type !== 'grid') continue;
        for (const item of block.items) {
          const { next } = resolveTarget(item.id);
          expect(next, `${screenId}/${item.id} 是死入口`).toBeDefined();
          expect([...SCREEN_IDS]).toContain(next);
        }
      }
    }
  });

  it('服务大厅的宫格全部通向专区，而不是弹一句提示', () => {
    const grid = SCREENS['gov.service'].blocks.find((b) => b.type === 'grid');
    expect(grid?.type).toBe('grid');
    if (grid?.type !== 'grid') return;
    for (const item of grid.items) {
      const { next } = resolveTarget(item.id);
      expect(next, `${item.id} 没有专区`).toBeDefined();
      expect(next).not.toBe('gov.todo');
    }
  });

  it('主题专区的每个条目都有去处，未接入的也有说明页', () => {
    const topics = SCREEN_IDS.filter((id) => id.startsWith('topic.') || id === 'gov.all');
    expect(topics.length).toBeGreaterThanOrEqual(10);
    for (const id of topics) {
      const screen = SCREENS[id];
      const list = screen.blocks.find((b) => b.type === 'list');
      expect(list, `${id} 缺少条目列表`).toBeDefined();
      if (list?.type !== 'list') continue;
      expect(list.items.length).toBeGreaterThanOrEqual(4);
      for (const item of list.items) {
        expect(resolveTarget(item.id).next, `${id}/${item.id} 无去处`).toBeDefined();
      }
    }
  });

  it('每个带底部导航的屏幕，三个标签都指向三张主页', () => {
    for (const screenId of SCREEN_IDS) {
      const screen = SCREENS[screenId];
      if (!screen.tabs) continue;
      expect(screen.tabs.map((t) => t.id)).toEqual(['tab.index', 'tab.service', 'tab.mine']);
      expect(NAV['tab.index']).toBe('gov.home');
      expect(NAV['tab.service']).toBe('gov.service');
      expect(NAV['tab.mine']).toBe('gov.mine');
    }
  });

  it('标注了归属标签的屏幕确实带有底部导航', () => {
    for (const [screenId, tabId] of Object.entries(TAB_OF)) {
      const screen = SCREENS[screenId as ScreenId];
      expect(screen, `${screenId} 不存在`).toBeDefined();
      expect(screen.tabs?.some((t) => t.id === tabId), `${screenId} 缺少 ${tabId}`).toBe(true);
    }
  });

  it('返回路径不会指向自己，且目标屏存在', () => {
    for (const [from, to] of Object.entries(PARENT)) {
      expect(SCREEN_IDS).toContain(from);
      expect(SCREEN_IDS).toContain(to as ScreenId);
      expect(from).not.toBe(to);
    }
  });

  it('浏览类入口与流程按钮区分得开', () => {
    expect(isBrowseControl('service.topic.birth')).toBe(true);
    expect(isBrowseControl('mine.doc.bank')).toBe(true);
    expect(isBrowseControl('form.btn.submit')).toBe(false);
    expect(isBrowseControl('intro.btn.apply')).toBe(false);
  });
});
