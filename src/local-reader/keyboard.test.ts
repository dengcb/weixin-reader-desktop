import { describe, expect, it } from 'bun:test';
import { resolveLocalKeyboardAction } from './keyboard';

describe('本地阅读键盘回退控制', () => {
  it('不依赖蓝牙遥控器开关即可映射阅读键', () => {
    expect(resolveLocalKeyboardAction('PageUp', false)).toBe('previous-page');
    expect(resolveLocalKeyboardAction('PageDown', false)).toBe('next-page');
    expect(resolveLocalKeyboardAction('ArrowUp', false)).toBe('previous-chapter');
    expect(resolveLocalKeyboardAction('ArrowDown', false)).toBe('next-chapter');
    expect(resolveLocalKeyboardAction('Enter', false)).toBe('toggle-wide');
    expect(resolveLocalKeyboardAction('Home', false)).toBe('toggle-navbar');
  });

  it('key 非标准时按 code 兜底（蓝牙遥控器在旧 WebKit 上 key 为 Unidentified）', () => {
    expect(resolveLocalKeyboardAction('Unidentified', false, 'ArrowUp')).toBe('previous-chapter');
    expect(resolveLocalKeyboardAction('', false, 'PageDown')).toBe('next-page');
    expect(resolveLocalKeyboardAction('Unidentified', false, 'Enter')).toBe('toggle-wide');
  });

  it('key 命中优先于 code，双标准键时不重复匹配', () => {
    expect(resolveLocalKeyboardAction('ArrowLeft', false, 'ArrowLeft')).toBe('previous-page');
    expect(resolveLocalKeyboardAction('Escape', false, 'Escape')).toBeNull();
  });

  it('只在 Windows 接管 F11', () => {
    expect(resolveLocalKeyboardAction('F11', true)).toBe('toggle-fullscreen');
    expect(resolveLocalKeyboardAction('F11', false)).toBeNull();
  });
});
