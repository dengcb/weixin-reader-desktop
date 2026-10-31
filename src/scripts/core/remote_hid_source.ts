import { listen } from './tauri';
import { log } from './logger';

/**
 * 自有蓝牙识别层（Rust `remote_hid.rs`，macOS）的按键事件封装。
 *
 * 分工：系统键盘事件路径继续承担方向/OK/Home/菜单等既有映射（兜底），
 * 本事件只用于系统映射不到的按键（音量±/语音/返回/电源），消费方按
 * `button` 取舍即可天然去重。
 */
export const REMOTE_HID_BUTTON_EVENT = 'remote-hid-button';

export type RemoteHidPhase = 'press' | 'release';

export interface RemoteHidButtonEvent {
  button: string;
  phase: RemoteHidPhase;
  usage: number;
}

export type RemoteHidAction =
  | 'page-backward'
  | 'page-forward'
  | 'toggle-stealth'
  | 'switch-bookstore'
  | 'toggle-wide';

/**
 * 按键 → 动作：音量+ 上一页、音量− 下一页（仅阅读页）；
 * 返回切换阅读区域宽窄；TV 循环切换到下一个书城；电源复用摸鱼键语义。
 * voice 由 Rust 侧 ATVV 语音链路消费，这里不绑定。
 */
export const resolveRemoteHidAction = (
  button: string,
  phase: RemoteHidPhase,
  isReaderPage: boolean,
): RemoteHidAction | null => {
  if (phase !== 'press') return null;
  switch (button) {
    case 'volume_up':
      return isReaderPage ? 'page-backward' : null;
    case 'volume_down':
      return isReaderPage ? 'page-forward' : null;
    case 'back':
      return 'toggle-wide';
    case 'tv':
      return 'switch-bookstore';
    case 'power':
      return 'toggle-stealth';
    default:
      return null;
  }
};

/**
 * 订阅按键事件，返回取消函数。注册是异步的：取消发生在注册完成前时，
 * 迟到的 unlisten 会被立即执行，不产生泄漏。
 */
export const subscribeRemoteHidButtons = (
  handler: (event: RemoteHidButtonEvent) => void,
): (() => void) => {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<RemoteHidButtonEvent>(REMOTE_HID_BUTTON_EVENT, (event) => {
    handler(event.payload);
  })
    .then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    })
    .catch((error) => log.warn('[RemoteHid] 订阅失败', error));
  return () => {
    disposed = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
};
