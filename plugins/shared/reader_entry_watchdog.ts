/**
 * 阅读页进入失速看门狗。
 *
 * 实证（2026-10-25，掌阅/七猫/多看）：书城切换的深链重进会让站点自身
 * 应用偶发初始化失败——正文不渲染、主题类缺失、阅读模式不应用——且站点
 * 自己不会再恢复（分页器自愈轮询等不到节点重现）。唯一可靠的客户端
 * 手段是整页重载一次，让站点重新冷启动。
 *
 * 退避（相对初版的修正）：立即重载只做一次；若重载后的页面仍然失速，
 * 说明大概率处于站点内容接口的节流窗口——窗口内的连环重载不仅无效还会
 * 加剧节流（2026-10-25 实证：失败窗口内 4/4 重载全失败）。此时改为挂出
 * 用户可见的「刷新重试」提示，是否再试交给用户决定；60 秒后自动重载
 * 权限恢复（下次进页可再武装一次）。
 *
 * 防循环：sessionStorage 记录上次看门狗重载时间，60 秒内不二次自动重载。
 * 就绪即拆弹：站点在超时前完成初始化则自动解除，不做任何事。
 */

export interface ReaderWatchdogOptions {
  /** 插件 ID：用于防循环守卫键 */
  pluginId: string;
  /** 站点就绪判定（阅读内容/模式已实际渲染） */
  isReady: () => boolean;
  /** 失速判定阈值，默认 10 秒 */
  timeoutMs?: number;
  log?: (message: string) => void;
}

const GUARD_TTL_MS = 60_000;
const POLL_MS = 500;
const RETRY_PROMPT_ID = 'atreader-watchdog-retry';

/** 所有 <link rel=stylesheet> 均已加载应用（.sheet 就位）——FOUC 检测的权威信号 */
export const stylesheetsReady = (doc: Document): boolean =>
  [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every(
    link => !!link.sheet,
  );

/**
 * 失速后的用户可见「刷新重试」提示（自动重载额度用尽后的兜底交互）。
 * 站点就绪即自动消失；点击刷新不受守卫限制（用户主动行为）。
 */
const showRetryPrompt = (
  pluginId: string,
  isReady: () => boolean,
  log?: (message: string) => void,
): void => {
  if (document.getElementById(RETRY_PROMPT_ID)) return;
  const host = document.body ?? document.documentElement;
  if (!host) return;
  const pill = document.createElement('div');
  pill.id = RETRY_PROMPT_ID;
  pill.setAttribute('role', 'alert');
  const label = document.createElement('span');
  label.textContent = '页面加载失速';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '刷新重试';
  button.addEventListener('click', () => window.location.reload());
  pill.append(label, button);
  pill.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:28px',
    'transform:translateX(-50%)',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'padding:10px 16px',
    'border-radius:999px',
    'background:rgba(23,28,27,.92)',
    'color:#edf5f1',
    'font:13px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,.25)',
    'user-select:none',
    '-webkit-user-select:none',
  ].join(';');
  button.style.cssText = [
    'border:0',
    'padding:5px 14px',
    'border-radius:999px',
    'background:#349f66',
    'color:#fff',
    'font:inherit',
    'cursor:pointer',
  ].join(';');
  host.appendChild(pill);
  log?.(`[${pluginId}] stall persists after watchdog reload, showing retry prompt`);

  const removePrompt = (): void => {
    pill.remove();
    window.clearInterval(poll);
    window.clearTimeout(cap);
  };
  const poll = window.setInterval(() => {
    if (isReady()) removePrompt();
  }, 1000);
  // 长期失速也不长期打扰：5 分钟后静默收起
  const cap = window.setTimeout(removePrompt, 300_000);
};

export const armReaderEntryWatchdog = (options: ReaderWatchdogOptions): (() => void) => {
  const { pluginId, isReady, timeoutMs = 10_000, log } = options;
  const guardKey = `atreader-watchdog-${pluginId}`;
  const start = Date.now();
  try {
    const last = Number(sessionStorage.getItem(guardKey));
    if (Number.isFinite(last) && start - last < GUARD_TTL_MS) {
      // 60 秒内已自动重载过：不再自动重载（节流窗口内重载无效且加剧），
      // 挂出用户可见的重试提示；守卫键按 TTL 自然过期恢复武装资格。
      showRetryPrompt(pluginId, isReady, log);
      return () => undefined;
    }
  } catch {
    return () => undefined; // sessionStorage 不可用：放弃看门狗（无从防循环）
  }
  const timer = window.setInterval(() => {
    if (isReady()) {
      window.clearInterval(timer);
      return;
    }
    if (Date.now() - start < timeoutMs) return;
    window.clearInterval(timer);
    try {
      sessionStorage.setItem(guardKey, String(Date.now()));
    } catch {
      return;
    }
    log?.(`[${pluginId}] watchdog reload: reader entry stalled > ${timeoutMs}ms`);
    // 日志 IPC 是异步的，立即 reload 会把未发出的日志连同上下文一起销毁
    window.setTimeout(() => window.location.reload(), 300);
  }, POLL_MS);
  // 离开阅读页/插件卸载时拆除：轮询与「超时整页 reload」都不该在站点
  // 上下文已经更换后触发（2026-11 审计 L-P2-5）。
  return () => window.clearInterval(timer);
};
