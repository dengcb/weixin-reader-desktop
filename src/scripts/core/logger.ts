/**
 * 日志工具模块
 *
 * 开发版输出详细日志，正式版仅输出关键信息，降低资源消耗
 */

export const log = {
  /**
   * 调试日志 - 仅在开发环境输出
   * 用于详细的调试信息，正式版会被移除
   *
   * 检测方式：检查 window.__TAURI__.__currentWindow.label 是否包含开发模式标识
   * 开发模式下窗口 label 通常是 "main"，生产模式是 "app.main" 之类
   */
  debug: (...args: any[]) => {
    // 在开发环境中，Tauri 窗口 label 通常不包含 "app." 前缀
    const isDev = typeof window !== 'undefined' &&
                  window.__TAURI__ &&
                  !window.__TAURI__.__currentWindow?.label?.includes('app.');
    if (isDev) {
      console.log(...args);
    }
  },

  /**
   * 信息日志 - 所有环境输出
   * 用于关键的信息性消息
   */
  info: (...args: any[]) => {
    console.log(...args);
  },

  /**
   * 警告日志 - 所有环境输出
   * 用于警告性消息
   */
  warn: (...args: any[]) => {
    console.warn(...args);
  },

  /**
   * 错误日志 - 所有环境输出
   * 用于错误消息
   */
  error: (...args: any[]) => {
    console.error(...args);
  },
};
