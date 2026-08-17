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
): LocalKeyboardAction | null => {
  switch (key) {
    case 'ArrowLeft':
    case 'PageUp': return 'previous-page';
    case 'ArrowRight':
    case 'PageDown': return 'next-page';
    case 'ArrowUp': return 'previous-chapter';
    case 'ArrowDown': return 'next-chapter';
    case 'Enter': return 'toggle-wide';
    case 'Home': return 'toggle-navbar';
    case 'F11': return isWindows ? 'toggle-fullscreen' : null;
    default: return null;
  }
};
