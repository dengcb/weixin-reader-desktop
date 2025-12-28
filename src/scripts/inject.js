// 核心注入脚本 - 移植自 preload.ts

(function () {
  // 等待 Tauri API 准备好
  // 注意：使用 withGlobalTauri: true 时，window.__TAURI__ 应该立即可用
  // 但为了安全，可以检查一下
  const TAURI = window.__TAURI__;
  if (!TAURI) {
    console.error('Tauri API not found');
    return;
  }

  const { invoke } = TAURI.core;
  const { listen } = TAURI.event;

  // 辅助函数：注入 CSS
  function injectCSS(id, cssContent) {
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    style.innerHTML = cssContent;
  }

  function removeCSS(id) {
    const style = document.getElementById(id);
    if (style) {
      style.remove();
    }
  }

  // 1. 深色模式适配
  function handleDarkMode() {
    const isIframe = window.self !== window.top;
    const cssRoot = `
      html {
        filter: invert(1) hue-rotate(180deg) !important;
        background-color: #e0e0e0 !important;
      }
    `;
    const cssContent = `
      img, video, canvas, svg {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      [style*="background-image"] {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      ::-webkit-scrollbar {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-track {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-thumb {
        background-color: #555;
        border-radius: 4px;
      }
    `;
    const finalCss = isIframe ? cssContent : (cssRoot + cssContent);

    // 简单判断系统深色模式，Tauri 端可以传递主题状态，或者直接利用媒体查询
    // 这里使用媒体查询
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      injectCSS('wxrd-dark-mode', finalCss);
    }

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      if (e.matches) {
        injectCSS('wxrd-dark-mode', finalCss);
      } else {
        removeCSS('wxrd-dark-mode');
      }
    });
  }

  // 2. 阅读页样式 (宽屏/隐藏工具栏)
  function handleReaderStyle() {
    const CSS_READER_WIDE = `
      .readerTopBar,
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
        width: 96% !important;
        max-width: calc(100vw - 224px) !important;
      }
      .app_content {
        max-width: calc(100vw - 224px) !important;
      }
      body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
        margin-left: calc(50vw - 80px) !important;
      }
    `;

    const CSS_READER_THIN = `
      .readerTopBar,
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
        width: 80% !important;
        max-width: calc(100vw - 424px) !important;
      }
      .app_content {
        max-width: calc(100vw - 424px) !important;
      }
      body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
        margin-left: calc(50vw - 180px) !important;
      }
    `;

    const CSS_HIDE_TOOLBAR = `
      .readerControls { display: none !important; }
      .readerTopBar,
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
        max-width: calc(100vw - 124px) !important;
      }
      .app_content {
        max-width: calc(100vw - 124px) !important;
      }
    `;

    const CSS_SHOW_TOOLBAR = `
      .readerControls { display: block !important; }
      .readerTopBar,
      body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
        max-width: calc(100vw - 224px) !important;
      }
      .app_content {
        max-width: calc(100vw - 224px) !important;
      }
      body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
        margin-left: calc(50vw - 80px) !important;
      }
    `;

    // State
    let isWide = false;
    let isHideToolbar = false;

    function applyStyles() {
        if (isWide) {
          injectCSS('wxrd-wide-mode', CSS_READER_WIDE);
        } else {
          injectCSS('wxrd-wide-mode', CSS_READER_THIN);
        }
        
        if (isHideToolbar) {
          injectCSS('wxrd-hide-toolbar', CSS_HIDE_TOOLBAR);
        } else {
          injectCSS('wxrd-hide-toolbar', CSS_SHOW_TOOLBAR);
        }
        window.dispatchEvent(new Event('resize'));
    }

    // Init
    invoke('get_settings').then(settings => {
        if (settings) {
            isWide = !!settings.readerWide;
            isHideToolbar = !!settings.hideToolbar;
            applyStyles();
            // Sync menu
            invoke('update_menu_state', { id: 'reader_wide', state: isWide });
            invoke('update_menu_state', { id: 'hide_toolbar', state: isHideToolbar });
        }
    });

    // Listen for Menu Actions
    listen('menu-action', (event) => {
      const action = event.payload;
      if (action === 'reader_wide') {
        isWide = !isWide;
        // Logic: if disabling wide, and hideToolbar is on, maybe disable hideToolbar?
        // Matching logic from Electron:
        if (!isWide && isHideToolbar) {
            isHideToolbar = false;
            invoke('update_menu_state', { id: 'hide_toolbar', state: false });
        }
      } else if (action === 'hide_toolbar') {
        isHideToolbar = !isHideToolbar;
      } else if (action === 'auto_flip') {
         // handled in autoFlip module, but we can emit global event or handle here
         // For now let's dispatch a custom event for other modules
         window.dispatchEvent(new CustomEvent('toggle-auto-flip'));
         return; 
      }
      
      applyStyles();
      invoke('update_menu_state', { id: action, state: action === 'reader_wide' ? isWide : isHideToolbar });
      invoke('save_settings', { settings: { readerWide: isWide, hideToolbar: isHideToolbar } });
    });
  }

  // 辅助函数：模拟按键 (本地模拟，无需 IPC)
  function triggerKey(keyName) {
    const keyMap = { 'Right': 'ArrowRight', 'Left': 'ArrowLeft' };
    const code = keyMap[keyName] || keyName;
    const keyCode = code === 'ArrowRight' ? 39 : 37;
    
    const e1 = new KeyboardEvent('keydown', { key: code, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true });
    document.dispatchEvent(e1);
    
    const e2 = new KeyboardEvent('keyup', { key: code, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true });
    document.dispatchEvent(e2);
  }

  // 3. 滑动翻页
  function handleSwipeTurn() {
    let lastTriggerTime = 0;
    let hasTriggeredInThisAction = false;

    window.addEventListener('wheel', (e) => {
      if (!window.location.href.includes('/web/reader/')) return;

      const now = Date.now();
      const absX = Math.abs(e.deltaX);

      if (absX < 10) {
        hasTriggeredInThisAction = false;
      }

      if (!hasTriggeredInThisAction && absX > 15 && absX > Math.abs(e.deltaY)) {
        if (now - lastTriggerTime < 500) return;

        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();

        lastTriggerTime = now;
        hasTriggeredInThisAction = true;

        const key = e.deltaX > 0 ? 'Right' : 'Left';
        triggerKey(key);
      } else if (absX > 0 && absX <= 15 && absX > Math.abs(e.deltaY)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, { passive: false, capture: true });
  }

  // 4. 自动翻页
  function handleAutoFlip() {
    let isActive = false;
    let intervalSeconds = 30;
    let keepAwake = false;
    let doubleTimer = null;
    let singleRafId = null;
    let lastFrameTime = 0;
    let accumulatedMove = 0;
    let lastBottomTriggerTime = 0;
    let countdown = 30;
    let originalTitle = null;

    const isDoubleColumn = () => !!document.querySelector('.readerControls[is-horizontal="true"]');

    const stopAll = () => {
      if (doubleTimer) { clearInterval(doubleTimer); doubleTimer = null; }
      if (singleRafId) { cancelAnimationFrame(singleRafId); singleRafId = null; }
      if (originalTitle) { document.title = originalTitle; originalTitle = null; }
    };

    const startDoubleColumnLogic = () => {
      if (doubleTimer) return;
      if (singleRafId) { cancelAnimationFrame(singleRafId); singleRafId = null; }
      
      countdown = intervalSeconds;
      if (!originalTitle) originalTitle = document.title;

      doubleTimer = setInterval(() => {
        if (!isDoubleColumn()) {
          stopAll();
          startSingleColumnLogic();
          return;
        }
        if (document.hidden && !keepAwake) return;

        countdown--;
        document.title = `微信阅读 - 自动翻页 - ${countdown} 秒`;

        if (countdown <= 0) {
          triggerKey('Right');
          countdown = intervalSeconds;
        }
      }, 1000);
    };

    const startSingleColumnLogic = () => {
      if (singleRafId) return;
      if (doubleTimer) { clearInterval(doubleTimer); doubleTimer = null; }
      if (originalTitle) { document.title = originalTitle; originalTitle = null; }

      lastFrameTime = performance.now();

      const loop = (time) => {
        if (isDoubleColumn()) {
          stopAll();
          startDoubleColumnLogic();
          return;
        }
        if (!isActive) return;

        let deltaTime = time - lastFrameTime;
        lastFrameTime = time;
        if (deltaTime > 100) deltaTime = 16;

        if (document.hidden && !keepAwake) {
          singleRafId = requestAnimationFrame(loop);
          return;
        }

        const screenHeight = window.innerHeight;
        const validInterval = intervalSeconds > 0 ? intervalSeconds : 30;
        const speed = (screenHeight * 2) / (validInterval * 1000);
        const move = speed * deltaTime;

        accumulatedMove += move;
        if (accumulatedMove >= 1) {
          const pixelsToScroll = Math.floor(accumulatedMove);
          window.scrollBy(0, pixelsToScroll);
          accumulatedMove -= pixelsToScroll;

          const totalHeight = document.documentElement.scrollHeight;
          const currentPos = window.innerHeight + window.scrollY;
          if (currentPos >= totalHeight - 5) {
            const now = Date.now();
            if (now - lastBottomTriggerTime > 2000) {
              lastBottomTriggerTime = now;
              triggerKey('Right');
            }
          }
        }
        singleRafId = requestAnimationFrame(loop);
      };
      singleRafId = requestAnimationFrame(loop);
    };

    listen('auto-flip-status', (event) => {
      const args = event.payload;
      isActive = args.active;
      intervalSeconds = args.interval;
      keepAwake = args.keepAwake;

      stopAll();
      if (isActive) {
        if (isDoubleColumn()) {
          startDoubleColumnLogic();
        } else {
          startSingleColumnLogic();
        }
      }
    });

    // Reset countdown on interaction
    window.addEventListener('keydown', (e) => {
      if (!isActive) return;
      if (isDoubleColumn()) {
        if (['ArrowRight', 'ArrowLeft', ' ', 'Enter'].includes(e.key)) {
          countdown = intervalSeconds;
          document.title = `微信阅读 - 自动翻页 - ${countdown} 秒`;
        }
      }
    }, true);
  }

  // 初始化
  const isReader = window.location.href.includes('/web/reader/');
  if (!isReader) {
    handleDarkMode();
  }
  
  handleReaderStyle();
  handleSwipeTurn();
  handleAutoFlip();

  console.log('Weixin Reader Inject Script Loaded');
})();