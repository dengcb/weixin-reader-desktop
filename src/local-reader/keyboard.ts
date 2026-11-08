export type LocalKeyboardAction =
  | 'previous-page'
  | 'next-page'
  | 'previous-chapter'
  | 'next-chapter'
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
      // Enter（遥控 OK 键）＝全屏，与站点侧 RemoteManager 语义一致；
      // 宽窄切换走 9 键 / 菜单「阅读变宽」/ 遥控返回键短按。
      case 'Enter': return 'toggle-fullscreen';
      case 'Home': return 'toggle-navbar';
      case 'F11':
        if (isWindows) return 'toggle-fullscreen';
        break;
    }
  }
  return null;
};

/** 应用级 F11 始终可用；正文单键由“阅读快捷键与遥控器”统一控制。 */
export const shouldHandleLocalKeyboardAction = (
  action: LocalKeyboardAction,
  readingShortcutsEnabled: boolean,
): boolean => readingShortcutsEnabled || action === 'toggle-fullscreen';
