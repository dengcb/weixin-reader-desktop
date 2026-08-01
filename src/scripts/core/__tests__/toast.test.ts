import { afterEach, describe, expect, it } from 'bun:test';
import { showToast } from '../toast';

afterEach(() => {
  document.getElementById('wxrd-toast-container')?.remove();
  document.getElementById('wxrd-toast-style')?.remove();
});

describe('showToast', () => {
  it('renders text via textContent and creates one shared style', () => {
    showToast('<b>上一章</b>');
    const toast = document.getElementById('wxrd-toast-container');
    expect(toast?.textContent).toBe('<b>上一章</b>');
    expect(toast?.querySelector('b')).toBeNull();
    expect(document.querySelectorAll('#wxrd-toast-style')).toHaveLength(1);

    showToast('下一章');
    expect(document.querySelectorAll('#wxrd-toast-container')).toHaveLength(1);
    expect(document.querySelectorAll('#wxrd-toast-style')).toHaveLength(1);
    expect(document.getElementById('wxrd-toast-container')?.textContent).toBe('下一章');
  });

  it('removes the toast after its animation ends', () => {
    showToast('完成');
    const toast = document.getElementById('wxrd-toast-container');
    toast?.dispatchEvent(new Event('animationend'));
    expect(document.getElementById('wxrd-toast-container')).toBeNull();
    expect(document.getElementById('wxrd-toast-style')).not.toBeNull();
  });
});
