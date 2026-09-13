/**
 * 全屏「退出全屏」叉号按钮（浏览器全屏式交互，dev.9 需求）。
 *
 * 与旧方案（碰顶 → reveal_menu_bar_transient 白色标题条 4s）的差异：
 * - 不再操作菜单栏可见性；碰顶只负责显示/隐藏本按钮；
 * - 点击 = simulate_menu_click('toggle_fullscreen')，走与 F11 完全相同的后端路径
 *   （退出全屏 + 菜单栏/标题回窗 + MENU_HIDDEN 同步）。
 *
 * 样式深浅双适配：优先跟随微信读书页面主题类（wr_whiteTheme=浅色），
 * 再以 prefers-color-scheme 兜底；深色主题下白描边，浅色下深色描边。
 *
 * 模块化原因同 hover_reveal：inject.js 是经典脚本上下文，顶层 export
 * 禁止（dev.6 事故根因），可复用单元拆独立模块。
 */

export const EXIT_BUTTON_ID = 'wxrd-exit-fullscreen';
/** 碰顶后按钮驻留时长：用户反馈「要再短一点」，从 2.5s 收至 1.2s */
export const EXIT_BUTTON_LINGER_MS = 1200;
/** 指针离开顶边命中带后多久算「真正离开」（命中带 y ≤ EDGE_HIT_PX 与 hover_reveal 共用阈值语义） */
export const EXIT_BUTTON_EDGE_PX = 2;

/**
 * 纯判定：指针事件是否落在顶边命中带内（独立可测单元）。
 */
export const isEdgeHit = (y: number): boolean => y <= EXIT_BUTTON_EDGE_PX && y >= 0;

/**
 * 创建（或复用）退出全屏按钮节点。挂在 body 上，fixed 顶部居中大圆形（命中区 88px 矩形、视觉圆 ~72、top:5%——接近顶边弹出，整个矩形区域都可点）。
 * 幂等：重复调用返回同一节点。
 */
export const ensureExitButton = (doc: Document): HTMLButtonElement | null => {
  if (doc.defaultView !== window) return null; // 转发过来的 iframe 事件一律由主文档承载按钮
  const existing = doc.getElementById(EXIT_BUTTON_ID) as HTMLButtonElement | null;
  if (existing) return existing;
  if (!doc.body) return null;
  const button = doc.createElement('button');
  button.id = EXIT_BUTTON_ID;
  button.type = 'button';
  button.title = '退出全屏';
  button.setAttribute('aria-label', '退出全屏');
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z"/>
    </svg>`;
  // 深浅双色：wr_whiteTheme（微信读书浅色页）优先；系统 prefers-color-scheme 兜底。
  // 半透明胶囊底保证两种主题下均不与正文内容混同；hover 提亮 + 轻缩放反馈。
  const style = doc.createElement('style');
  style.id = `${EXIT_BUTTON_ID}-style`;
  style.textContent = `
    #${EXIT_BUTTON_ID} {
      position: fixed;
      /* 顶部居中：从碰顶的顶边弹出、就近可点；屏幕正中会挡正文且离命中带太远 */
      top: 5%;
      left: 50%;
      transform: translateX(-50%) scale(.92);
      z-index: 2147483647;
      width: 88px;
      height: 88px;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: #f2f3f5;
      cursor: pointer;
      opacity: 0;
      transition: opacity .16s ease, transform .16s ease, background .16s ease;
    }
    #${EXIT_BUTTON_ID}.wxrd-edge-shown {
      display: flex;
      opacity: 1;
      transform: translateX(-50%) scale(1);
    }
    #${EXIT_BUTTON_ID}:hover::before {
      background: rgba(20, 21, 23, 0.68);
    }
    #${EXIT_BUTTON_ID}:hover {
      transform: translateX(-50%) scale(1.07);
    }
    body.wr_whiteTheme #${EXIT_BUTTON_ID} {
      color: #1f2329;
    }
    body.wr_whiteTheme #${EXIT_BUTTON_ID}::before {
      background: rgba(244, 245, 247, 0.55);
      box-shadow: 0 4px 22px rgba(0, 0, 0, 0.12);
    }
    body.wr_whiteTheme #${EXIT_BUTTON_ID}:hover::before {
      background: rgba(244, 245, 247, 0.85);
    }
    @media (prefers-color-scheme: light) {
      body:not(.wr_whiteTheme) #${EXIT_BUTTON_ID} {
        color: #1f2329;
      }
      body:not(.wr_whiteTheme) #${EXIT_BUTTON_ID}::before {
        background: rgba(244, 245, 247, 0.55);
        box-shadow: 0 4px 22px rgba(0, 0, 0, 0.12);
      }
      body:not(.wr_whiteTheme) #${EXIT_BUTTON_ID}:hover::before {
        background: rgba(244, 245, 247, 0.85);
      }
    }
    /* 命中区=整个 88px 矩形（视觉圆只占中央 ~72px）：命中优先、装饰其次。
       视觉圆用 ::before 画（background 上的圆+毛玻璃），点击落在矩形任意处都触发。 */
    #${EXIT_BUTTON_ID}::before {
      content: '';
      position: absolute;
      inset: 8px;
      border-radius: 50%;
      background: rgba(20, 21, 23, 0.42);
      box-shadow: 0 4px 22px rgba(0, 0, 0, 0.28);
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
      transition: background .16s ease;
    }
    #${EXIT_BUTTON_ID} svg {
      position: relative;
      z-index: 1;
      width: 34px;
      height: 34px;
      fill: currentColor;
      pointer-events: none;
    }
  `;
  doc.head?.appendChild(style);
  doc.body.appendChild(button);
  return button;
};

/**
 * 显示按钮并安排自动隐藏；返回应记录的调度时间戳（供测试断言），
 * 触发条件不满足时返回 null。
 */
export const showExitButton = (
  button: HTMLButtonElement,
  hideTimer: { current: ReturnType<typeof setTimeout> | null },
): number | null => {
  button.classList.add('wxrd-edge-shown');
  if (hideTimer.current) clearTimeout(hideTimer.current);
  hideTimer.current = setTimeout(() => {
    hideTimer.current = null;
    button.classList.remove('wxrd-edge-shown');
  }, EXIT_BUTTON_LINGER_MS);
  return Date.now();
};
