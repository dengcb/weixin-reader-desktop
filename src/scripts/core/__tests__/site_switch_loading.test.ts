/**
 * 书城切换过场层单测：跨站判定纯函数、过场层挂载/幂等、淡出时序、
 * 兜底上限、<html> 缺失时的观察器挂载路径。
 */

import { describe, it, expect, afterEach } from 'bun:test';
import {
  isRecentHomeNav,
  isSiteSwitchNavigation,
  isStartupWindow,
  setSiteReadinessProbe,
  showSiteSwitchLoading,
  SCROLLBAR_STYLE_ID,
} from '../site_switch_loading';

const OVERLAY_ID = 'atreader-site-switch-loading';
const STYLE_ID = `${OVERLAY_ID}-style`;

const root = (): HTMLElement | null => document.getElementById(OVERLAY_ID);

describe('isSiteSwitchNavigation', () => {
  it('程序化 navigate（referrer 为空）判定为跨站进入', () => {
    expect(isSiteSwitchNavigation({ protocol: 'https:', host: 'weread.qq.com' }, '')).toBe(true);
  });

  it('referrer 与当前 host 相同（站内跳转/刷新）不成立', () => {
    expect(
      isSiteSwitchNavigation(
        { protocol: 'https:', host: 'weread.qq.com' },
        'https://weread.qq.com/web/shelf',
      ),
    ).toBe(false);
  });

  it('referrer 指向其他站点判定成立', () => {
    expect(
      isSiteSwitchNavigation(
        { protocol: 'https:', host: 'fanqienovel.com' },
        'https://weread.qq.com/',
      ),
    ).toBe(true);
  });

  it('referrer 无法解析时保守判定成立', () => {
    expect(
      isSiteSwitchNavigation({ protocol: 'https:', host: 'weread.qq.com' }, 'not-a-url'),
    ).toBe(true);
  });

  it('本地协议不成立（过场层只服务于远程站点）', () => {
    expect(isSiteSwitchNavigation({ protocol: 'atreader:', host: 'localhost' }, '')).toBe(false);
  });
});

describe('isRecentHomeNav', () => {
  it('5 秒内的回书架标记放行，过期/缺失/非法值不放行', () => {
    const storage = (value: string | null) => ({ getItem: () => value });
    const now = 1_000_000;
    expect(isRecentHomeNav(storage(String(now)), now)).toBe(true);
    expect(isRecentHomeNav(storage(String(now - 4_999)), now)).toBe(true);
    expect(isRecentHomeNav(storage(String(now - 5_001)), now)).toBe(false);
    expect(isRecentHomeNav(storage(null), now)).toBe(false);
    expect(isRecentHomeNav(storage('garbage'), now)).toBe(false);
  });
});

describe('isStartupWindow', () => {
  const NOW = 1_000_000;

  it('启动时间戳缺失时不在启动窗口（过场层正常出现）', () => {
    expect(isStartupWindow(undefined, NOW)).toBe(false);
    expect(isStartupWindow({}, NOW)).toBe(false);
    expect(isStartupWindow({ launchedAt: 'oops' }, NOW)).toBe(false);
  });

  it('距启动不足阈值判定为启动窗口', () => {
    expect(isStartupWindow({ launchedAt: NOW - 4999 }, NOW)).toBe(true);
    expect(isStartupWindow({ launchedAt: NOW }, NOW)).toBe(true);
  });

  it('超过阈值后不再抑制（手动切换正常铺过场）', () => {
    expect(isStartupWindow({ launchedAt: NOW - 5000 }, NOW)).toBe(false);
    expect(isStartupWindow({ launchedAt: NOW - 60_000 }, NOW)).toBe(false);
  });
});

describe('showSiteSwitchLoading', () => {
  afterEach(() => {
    root()?.remove();
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(SCROLLBAR_STYLE_ID)?.remove();
  });

  it('挂载过场层并注入样式，logo 用内嵌 SVG data URI', () => {
    showSiteSwitchLoading(document, { settleMs: 10, maxMs: 5000 });
    expect(root()).not.toBeNull();
    expect(root()?.getAttribute('role')).toBe('status');
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('-webkit-mask');
    expect(css).toContain('data:image/svg+xml;base64,');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    // 100vw/vh 含滚动条槽：滚动条出现不得挤压居中内容（防回归断言）
    expect(css).toContain('width: 100vw');
    expect(css).not.toMatch(/inset:\s/);
    // 呼吸与跑动动画保留（不能为了修相位问题把动画删掉）
    expect(css).toContain('atreaderSwitchBreathe');
    expect(css).toContain('atreaderSwitchTravel');
  });

  it('动画相位以墙上时钟为锚：挂载时写入负 animation-delay', () => {
    showSiteSwitchLoading(document, { settleMs: 10, maxMs: 5000 });
    const logo = document.querySelector<HTMLElement>(`#${OVERLAY_ID} .logo`);
    const block = document.querySelector<HTMLElement>(`#${OVERLAY_ID} .progress-block`);
    expect(logo?.style.animationDelay).toMatch(/^-\d+ms$/);
    expect(block?.style.animationDelay).toMatch(/^-\d+ms$/);
    const logoDelay = Math.abs(parseFloat(logo!.style.animationDelay));
    const blockDelay = Math.abs(parseFloat(block!.style.animationDelay));
    expect(logoDelay).toBeLessThan(2200);
    expect(blockDelay).toBeLessThan(1500);
  });

  it('重复调用幂等（不叠加节点与计时器）', () => {
    showSiteSwitchLoading(document, { settleMs: 10, maxMs: 5000 });
    const first = root();
    showSiteSwitchLoading(document, { settleMs: 10, maxMs: 5000 });
    expect(root()).toBe(first);
    expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);
  });

  it('readyState complete 时按 settleMs 稳定驻留后淡出移除', async () => {
    // probeGraceMs=0 跳过探针注册宽限（生产默认 1500ms，等插件注册探针）
    showSiteSwitchLoading(document, { settleMs: 10, maxMs: 5000, probeGraceMs: 0 });
    expect(root()).not.toBeNull();
    // settleMs + 280ms 淡出动画后移除
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(root()).toBeNull();
  });

  it('maxMs 兜底：未等到 load 也会收场', async () => {
    // settleMs 给足余量，验证兜底计时独立生效
    showSiteSwitchLoading(document, { settleMs: 30_000, maxMs: 30 });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(root()).toBeNull();
  });

  it('淡出走 done 类（透明过渡）而非直接消失', async () => {
    showSiteSwitchLoading(document, { settleMs: 20, maxMs: 5000, probeGraceMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 60));
    // 已进入淡出态但节点尚在（280ms 过渡未结束）
    expect(root()?.classList.contains('atreader-switch-loading-done')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 320));
    expect(root()).toBeNull();
  });

  it('sticky（提交预铺）不安排 load/settle 收场，超过 settleMs 仍在', async () => {
    showSiteSwitchLoading(document, { sticky: true, maxMs: 2000 });
    // 越过默认 settleMs(320)：证明 sticky 没有安排 settle 收场
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(root()).not.toBeNull();
    expect(root()?.classList.contains('atreader-switch-loading-done')).toBe(false);
  });

  it('sticky 的 maxMs 兜底仍然生效（防同站短路/守卫拒绝后卡死）', async () => {
    showSiteSwitchLoading(document, { sticky: true, maxMs: 30 });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(root()).toBeNull();
  });

  it('探针注册竞速：探针未注册时在宽限期内等待，注册后按探针判定撤场', async () => {
    // 生产时序复现：documentStart 铺过场，快站 load+320ms 时刻插件探针尚未注册
    showSiteSwitchLoading(document, { settleMs: 10, maxMs: 5000, probeGraceMs: 600 });
    await new Promise(resolve => setTimeout(resolve, 120));
    // 无探针 + 宽限期内：不得在 load+320ms 撤场（裸页状态）
    expect(root()).not.toBeNull();
    // 探针就位且判定未就绪：持续遮盖
    setSiteReadinessProbe(() => false);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(root()).not.toBeNull();
    // 探针判定就绪：立即撤场
    setSiteReadinessProbe(() => true);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(root()).toBeNull();
  });

  it('过场期间根滚动条被整体隐藏（带槽位补偿），淡出移除后恢复', async () => {
    showSiteSwitchLoading(document, { settleMs: 20, maxMs: 5000, probeGraceMs: 0 });
    const css = document.getElementById(SCROLLBAR_STYLE_ID)?.textContent ?? '';
    // 直接让滚动条不存在——z-index 盖不住、透明涂装打不赢站点样式
    expect(css).toContain('overflow: hidden');
    expect(css).toMatch(/padding-right:\s*\d+px/);
    // 完全透明后才恢复滚动条（随过场节点一起移除）
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(root()).toBeNull();
    expect(document.getElementById(SCROLLBAR_STYLE_ID)).toBeNull();
    // 主样式保留（缓存复用），只回收滚动条样式
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
  });
});
