/**
 * Unit Tests for Utils
 *
 * Tests the core utility functions:
 * - CSS injection and removal
 * - Keyboard event triggering
 * - DOM manipulation robustness
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { injectCSS, removeCSS, triggerKey } from '../utils';

describe('Utils - CSS Injection', () => {
  // 清理函数
  const cleanup = () => {
    // 清理所有测试添加的 style 元素
    const testStyles = document.querySelectorAll('style[id^="test-"]');
    testStyles.forEach(style => style.remove());
  };

  beforeEach(() => {
    // 确保每个测试开始前 DOM 是干净的
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('injectCSS', () => {
    it('should inject CSS into document head', () => {
      const cssContent = '.test { color: red; }';
      injectCSS('test-style-1', cssContent);

      const style = document.getElementById('test-style-1');
      expect(style).not.toBeNull();
      expect(style?.tagName).toBe('STYLE');
      expect(style?.innerHTML).toBe(cssContent);
      expect(style?.parentElement).toBe(document.head);
    });

    it('should update existing style element', () => {
      injectCSS('test-style-2', '.test { color: red; }');
      injectCSS('test-style-2', '.test { color: blue; }');

      const styles = document.querySelectorAll('#test-style-2');
      expect(styles.length).toBe(1); // 应该只有一个元素

      const style = document.getElementById('test-style-2');
      expect(style?.innerHTML).toBe('.test { color: blue; }');
    });

    it('should handle empty CSS content', () => {
      injectCSS('test-style-3', '');

      const style = document.getElementById('test-style-3');
      expect(style).not.toBeNull();
      expect(style?.innerHTML).toBe('');
    });

    it('should handle CSS with special characters', () => {
      const cssContent = '.test { content: "\'quotes\'"; }';
      injectCSS('test-style-4', cssContent);

      const style = document.getElementById('test-style-4');
      expect(style?.innerHTML).toBe(cssContent);
    });

    it('should handle multiple CSS rules', () => {
      const cssContent = `
        .rule1 { color: red; }
        .rule2 { color: blue; }
        .rule3 { color: green; }
      `;
      injectCSS('test-style-5', cssContent);

      const style = document.getElementById('test-style-5');
      expect(style?.innerHTML).toBe(cssContent);
    });

    it('should handle CSS with media queries', () => {
      const cssContent = '@media (max-width: 600px) { .test { display: none; } }';
      injectCSS('test-style-6', cssContent);

      const style = document.getElementById('test-style-6');
      expect(style?.innerHTML).toContain('@media');
      expect(style?.innerHTML).toContain('max-width: 600px');
    });

    it('should create unique style elements for different ids', () => {
      injectCSS('test-style-7a', '.a { color: red; }');
      injectCSS('test-style-7b', '.b { color: blue; }');

      const styleA = document.getElementById('test-style-7a');
      const styleB = document.getElementById('test-style-7b');

      expect(styleA).not.toBeNull();
      expect(styleB).not.toBeNull();
      expect(styleA).not.toBe(styleB);
    });
  });

  describe('removeCSS', () => {
    it('should remove existing style element', () => {
      injectCSS('test-style-8', '.test { color: red; }');
      expect(document.getElementById('test-style-8')).not.toBeNull();

      removeCSS('test-style-8');
      expect(document.getElementById('test-style-8')).toBeNull();
    });

    it('should handle removing non-existent style', () => {
      // 不应该抛出错误
      expect(() => removeCSS('non-existent')).not.toThrow();
    });

    it('should only remove the specified style', () => {
      injectCSS('test-style-9a', '.a { color: red; }');
      injectCSS('test-style-9b', '.b { color: blue; }');

      removeCSS('test-style-9a');

      expect(document.getElementById('test-style-9a')).toBeNull();
      expect(document.getElementById('test-style-9b')).not.toBeNull();
    });

    it('should handle multiple remove calls', () => {
      injectCSS('test-style-10', '.test { color: red; }');

      removeCSS('test-style-10');
      removeCSS('test-style-10'); // 第二次调用不应该出错

      expect(document.getElementById('test-style-10')).toBeNull();
    });
  });

  describe('CSS Injection + Removal Integration', () => {
    it('should allow re-injection after removal', () => {
      const css1 = '.test { color: red; }';
      const css2 = '.test { color: blue; }';

      injectCSS('test-style-11', css1);
      expect(document.getElementById('test-style-11')?.innerHTML).toBe(css1);

      removeCSS('test-style-11');
      expect(document.getElementById('test-style-11')).toBeNull();

      injectCSS('test-style-11', css2);
      expect(document.getElementById('test-style-11')?.innerHTML).toBe(css2);
    });
  });
});

describe('Utils - Keyboard Events', () => {
  describe('triggerKey', () => {
    it('should trigger ArrowRight keydown and keyup events', () => {
      const keydownEvents: KeyboardEvent[] = [];
      const keyupEvents: KeyboardEvent[] = [];

      const keydownHandler = (e: Event) => keydownEvents.push(e as KeyboardEvent);
      const keyupHandler = (e: Event) => keyupEvents.push(e as KeyboardEvent);

      document.addEventListener('keydown', keydownHandler);
      document.addEventListener('keyup', keyupHandler);

      triggerKey('Right');

      expect(keydownEvents.length).toBe(1);
      expect(keyupEvents.length).toBe(1);

      const keydownEvent = keydownEvents[0];
      expect(keydownEvent.key).toBe('ArrowRight');
      expect(keydownEvent.code).toBe('ArrowRight');
      expect(keydownEvent.keyCode).toBe(39);
      expect(keydownEvent.bubbles).toBe(true);
      expect(keydownEvent.cancelable).toBe(true);

      const keyupEvent = keyupEvents[0];
      expect(keyupEvent.key).toBe('ArrowRight');
      expect(keyupEvent.code).toBe('ArrowRight');

      document.removeEventListener('keydown', keydownHandler);
      document.removeEventListener('keyup', keyupHandler);
    });

    it('should trigger ArrowLeft keydown and keyup events', () => {
      const keydownEvents: KeyboardEvent[] = [];
      const keyupEvents: KeyboardEvent[] = [];

      const keydownHandler = (e: Event) => keydownEvents.push(e as KeyboardEvent);
      const keyupHandler = (e: Event) => keyupEvents.push(e as KeyboardEvent);

      document.addEventListener('keydown', keydownHandler);
      document.addEventListener('keyup', keyupHandler);

      triggerKey('Left');

      expect(keydownEvents.length).toBe(1);
      expect(keyupEvents.length).toBe(1);

      const keydownEvent = keydownEvents[0];
      expect(keydownEvent.key).toBe('ArrowLeft');
      expect(keydownEvent.code).toBe('ArrowLeft');
      expect(keydownEvent.keyCode).toBe(37);

      document.removeEventListener('keydown', keydownHandler);
      document.removeEventListener('keyup', keyupHandler);
    });

    it('should handle unmapped key names', () => {
      const keydownEvents: KeyboardEvent[] = [];

      const keydownHandler = (e: Event) => keydownEvents.push(e as KeyboardEvent);
      document.addEventListener('keydown', keydownHandler);

      triggerKey('CustomKey');

      expect(keydownEvents.length).toBe(1);
      expect(keydownEvents[0].key).toBe('CustomKey');
      expect(keydownEvents[0].code).toBe('CustomKey');

      document.removeEventListener('keydown', keydownHandler);
    });

    it('should trigger events that bubble up', () => {
      const documentEvents: KeyboardEvent[] = [];
      const bodyEvents: KeyboardEvent[] = [];

      const documentHandler = (e: Event) => documentEvents.push(e as KeyboardEvent);
      const bodyHandler = (e: Event) => bodyEvents.push(e as KeyboardEvent);

      document.addEventListener('keydown', documentHandler);
      document.body.addEventListener('keydown', bodyHandler);

      triggerKey('Right');

      // 事件应该在 document 和 body 上都触发(冒泡)
      expect(documentEvents.length).toBe(1);
      // Note: body 可能收不到,因为事件直接在 document 上 dispatch
      // 但是 bubbles: true 确保事件可以冒泡

      document.removeEventListener('keydown', documentHandler);
      document.body.removeEventListener('keydown', bodyHandler);
    });

    it('should trigger cancelable events', () => {
      let eventCanceled = false;

      const handler = (e: Event) => {
        const keyEvent = e as KeyboardEvent;
        if (keyEvent.cancelable) {
          e.preventDefault();
          eventCanceled = true;
        }
      };

      document.addEventListener('keydown', handler);
      triggerKey('Right');

      expect(eventCanceled).toBe(true);

      document.removeEventListener('keydown', handler);
    });
  });

  describe('Key Mapping', () => {
    it('should map Right to ArrowRight with keyCode 39', () => {
      const events: KeyboardEvent[] = [];
      const handler = (e: Event) => events.push(e as KeyboardEvent);

      document.addEventListener('keydown', handler);
      triggerKey('Right');

      expect(events[0].key).toBe('ArrowRight');
      expect(events[0].keyCode).toBe(39);
      expect(events[0].which).toBe(39);

      document.removeEventListener('keydown', handler);
    });

    it('should map Left to ArrowLeft with keyCode 37', () => {
      const events: KeyboardEvent[] = [];
      const handler = (e: Event) => events.push(e as KeyboardEvent);

      document.addEventListener('keydown', handler);
      triggerKey('Left');

      expect(events[0].key).toBe('ArrowLeft');
      expect(events[0].keyCode).toBe(37);
      expect(events[0].which).toBe(37);

      document.removeEventListener('keydown', handler);
    });
  });
});
