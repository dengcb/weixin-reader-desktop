export type LocalKeyboardAction =
  | 'previous-page'
  | 'next-page'
  | 'previous-chapter'
  | 'next-chapter'
  | 'toggle-wide'
  | 'toggle-navbar'
  | 'toggle-fullscreen';

export const resolveLocalKeyboardAction = (
  key: string,
  isWindows: boolean,
  code?: string,
): LocalKeyboardAction | null => {
  // 蓝牙遥控器的部分按键在旧系统 WebKit 上 key 为非标准值（如 Unidentified），
  // 但 code 仍是标准键名；先按 key 匹配（物理键盘路径），未命中再按 code 兜底。
  const candidates = code && code !== key ? [key, code] : [key];
  for (const candidate of candidates) {
    switch (candidate) {
      case 'ArrowLeft':
      case 'PageUp': return 'previous-page';
      case ' ':
      case 'ArrowRight':
      case 'PageDown': return 'next-page';
      case 'ArrowUp': return 'previous-chapter';
      case 'ArrowDown': return 'next-chapter';
      case 'Enter': return 'toggle-wide';
      case 'Home': return 'toggle-navbar';
      case 'F11':
        if (isWindows) return 'toggle-fullscreen';
        break;
    }
  }
  return null;
};
