/**
 * 同源 iframe 键盘转发（issue #5 通用修复）。
 *
 * 站点正文（微信读书 canvas 章节等）渲染在同源 iframe 内；鼠标点击或划选
 * iframe 内文字后，键盘焦点进入该 iframe 文档，按键不再冒泡到顶层 window，
 * 顶层监听的翻页/遥控器处理从此收不到事件。此工具把同一处理器挂到页面中
 * 全部同源 iframe 的文档上（capture 阶段），并对动态新增的 iframe 持续生效。
 *
 * 事件驱动的 iframe 发现：MutationObserver 监听 DOM 新增节点，无轮询。
 * 跨域 iframe 的 contentDocument 访问会抛异常，静默跳过。
 */

export const attachKeyboardToSameOriginIframes = (
  handler: (event: KeyboardEvent) => void,
): (() => void) => {
  const instrumented = new WeakSet<HTMLIFrameElement>();
  const attachedDocs = new Set<Document>();

  const attachDoc = (doc: Document | null): void => {
    if (!doc || attachedDocs.has(doc)) return;
    attachedDocs.add(doc);
    doc.addEventListener('keydown', handler, true);
  };

  const instrument = (iframe: Element): void => {
    if (instrumented.has(iframe as HTMLIFrameElement)) return;
    instrumented.add(iframe as HTMLIFrameElement);
    const tryAttach = (): void => {
      try {
        attachDoc((iframe as HTMLIFrameElement).contentDocument);
      } catch {
        // 跨域 iframe：contentDocument 不可访问，无法转发（也无法被用户划选干预焦点路径之外的键）
      }
    };
    // 已加载完成的 iframe 立即挂载；未完成的等 load 事件（不同源时 load 后访问仍会抛错，已兜底）
    tryAttach();
    iframe.addEventListener('load', tryAttach, { once: true });
  };

  const isIframe = (node: Node): node is Element => node.nodeName === 'IFRAME';

  document.querySelectorAll('iframe').forEach(node => instrument(node));

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (isIframe(node)) {
          instrument(node);
        } else if (node instanceof Element) {
          node.querySelectorAll('iframe').forEach(child => instrument(child));
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    for (const doc of attachedDocs) {
      doc.removeEventListener('keydown', handler, true);
    }
    attachedDocs.clear();
  };
};
