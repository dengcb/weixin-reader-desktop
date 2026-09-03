/**
 * 同源 iframe 键盘转发（issue #5）单测。
 *
 * 用 document.implementation.createHTMLDocument() 模拟 iframe 的同源文档，
 * 覆盖：既有 iframe 挂载、动态 iframe 接入、防重复挂载、清理函数有效性。
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { attachKeyboardToSameOriginIframes } from '../iframe_keyboard';

const stubIframeDocument = (iframe: HTMLIFrameElement): Document => {
  const doc = document.implementation.createHTMLDocument('iframe');
  Object.defineProperty(iframe, 'contentDocument', {
    configurable: true,
    get: () => doc,
  });
  return doc;
};

describe('attachKeyboardToSameOriginIframes', () => {
  const created: HTMLIFrameElement[] = [];
  const detachers: Array<() => void> = [];

  const makeIframe = (): HTMLIFrameElement => {
    const iframe = document.createElement('iframe');
    created.push(iframe);
    document.body.append(iframe);
    return iframe;
  };

  afterEach(() => {
    detachers.splice(0).forEach(detach => detach());
    created.splice(0).forEach(iframe => iframe.remove());
  });

  it('既有的同源 iframe 文档被挂上处理器', () => {
    const iframe = makeIframe();
    const doc = stubIframeDocument(iframe);
    let fired = 0;
    const handler = (): void => { fired += 1; };
    detachers.push(attachKeyboardToSameOriginIframes(handler));

    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(fired).toBe(1);
  });

  it('动态新增的 iframe 同样被接入（MutationObserver）', async () => {
    let fired = 0;
    const handler = (): void => { fired += 1; };
    detachers.push(attachKeyboardToSameOriginIframes(handler));

    const iframe = makeIframe();
    const doc = stubIframeDocument(iframe);
    // MutationObserver 回调是异步的，等一拍
    await new Promise(resolve => setTimeout(resolve, 0));

    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(fired).toBe(1);
  });

  it('同一文档只挂一次，重复事件不重复触发', () => {
    const iframe = makeIframe();
    const doc = stubIframeDocument(iframe);
    let fired = 0;
    const handler = (): void => { fired += 1; };
    detachers.push(attachKeyboardToSameOriginIframes(handler));
    detachers.push(attachKeyboardToSameOriginIframes(handler));

    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(fired).toBe(1);
  });

  it('清理后 iframe 文档不再触发', () => {
    const iframe = makeIframe();
    const doc = stubIframeDocument(iframe);
    let fired = 0;
    const handler = (): void => { fired += 1; };
    const detach = attachKeyboardToSameOriginIframes(handler);
    detach();

    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(fired).toBe(0);
  });
});
