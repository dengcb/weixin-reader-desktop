/**
 * 警示档案（dev.6 事故根因）：本文件曾 `export ... from '../../inject'`
 * 触发 inject.js 产物携带顶层 export——WebView2 初始化脚本是经典脚本
 * 上下文，export 语句直接语法错误，整个注入（快捷键/样式面板/AppRuntime）
 * 全部失效。修复后可测单元一律放独立模块（core/hover_reveal.ts），
 * inject.ts 保持零 export。严禁从 inject.ts re-export 任何东西。
 */
export {
  EXIT_BUTTON_ID,
  EXIT_BUTTON_EDGE_PX,
  EXIT_BUTTON_LINGER_MS,
  isEdgeHit,
} from '../fullscreen_exit_button';
export { attachEventToSameOriginIframes } from '../iframe_keyboard';
