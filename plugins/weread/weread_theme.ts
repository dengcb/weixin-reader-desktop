/**
 * 微信读书主题单一真相源（v1.8.4 合并语义收口的完成态）。
 *
 * 优先级（两处调用方此前互为镜像导致双写竞速，review+bug 双 Agent 预审
 * 定案统一）：cookie wr_theme 优先，wr_whiteTheme DOM 类兜底，均缺席
 * 时按暗色处理。
 * 模块化原因同 hover_reveal/fullscreen_exit_button：inject.js 是经典
 * 脚本上下文，顶层 export 禁止（dev.6 事故根因），可复用单元拆独立模块。
 */

/** 与 style_manager.currentWindowTheme / detectWereadTheme 共用的读取器。 */
export const readWereadThemeSource = (): {
  cookie: 'light' | 'dark' | null;
  domClass: boolean | null;
} => {
  const match = document.cookie.matchAll(/(?:^|;\s*)wr_theme=(light|dark)/g);
  let cookie: 'light' | 'dark' | null = null;
  for (const m of match) cookie = m[1] as 'light' | 'dark';
  const domClass = document.body?.classList.contains('wr_whiteTheme') ?? null;
  return { cookie, domClass };
};

/** 最终判级：cookie > DOM 类 > dark。 */
export const detectWereadTheme = (): 'light' | 'dark' => {
  const { cookie, domClass } = readWereadThemeSource();
  if (cookie) return cookie;
  if (domClass !== null) return domClass ? 'light' : 'dark';
  return 'dark';
};
