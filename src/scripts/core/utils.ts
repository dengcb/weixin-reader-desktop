
export function injectCSS(id: string, cssContent: string) {
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    
    // 最佳实践：Document 级监听
    // 不盲目尝试，而是等待 DOM 节点真正出现
    if (document.head) {
      document.head.appendChild(style);
    } else if (document.documentElement) {
      document.documentElement.appendChild(style);
    } else {
      // 如果 documentElement 都不存在，说明还在解析第一行
      // 监听 document 的子节点添加事件
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.addedNodes.length > 0) {
            if (document.head) {
              document.head.appendChild(style!);
              observer.disconnect();
              return;
            } else if (document.documentElement) {
              // 降级：插到 html 根节点下
              document.documentElement.appendChild(style!);
              observer.disconnect();
              return;
            }
          }
        }
      });
      observer.observe(document, { childList: true });
    }
  }
  style.innerHTML = cssContent;
}

export function removeCSS(id: string) {
  const style = document.getElementById(id);
  if (style) {
    style.remove();
  }
}

export function triggerKey(keyName: string) {
  const keyMap: Record<string, string> = { 'Right': 'ArrowRight', 'Left': 'ArrowLeft' };
  const code = keyMap[keyName] || keyName;
  const keyCode = code === 'ArrowRight' ? 39 : 37;
  
  const e1 = new KeyboardEvent('keydown', { key: code, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true });
  document.dispatchEvent(e1);
  
  const e2 = new KeyboardEvent('keyup', { key: code, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true });
  document.dispatchEvent(e2);
}
