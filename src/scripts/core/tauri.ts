
declare global {
  interface Window {
    __TAURI__: {
      core: {
        invoke: <T = any>(cmd: string, args?: Record<string, any>) => Promise<T>;
      };
      event: {
        listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
      };
      webviewWindow: {
        WebviewWindow: any;
      };
    };
  }
}

// 核心逻辑：动态获取 Tauri API
// 不要静态捕获 window.__TAURI__，因为脚本执行时机可能早于 Tauri 注入
export const invoke = <T = any>(cmd: string, args?: Record<string, any>): Promise<T> => {
    if (window.__TAURI__) {
        return window.__TAURI__.core.invoke(cmd, args);
    }
    console.warn(`[Tauri] Invoke '${cmd}' failed: API not found`);
    return Promise.resolve({} as T);
};

export const listen = <T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> => {
    if (window.__TAURI__) {
        return window.__TAURI__.event.listen(event, handler);
    }
    console.warn(`[Tauri] Listen '${event}' failed: API not found`);
    return Promise.resolve(() => {});
};

export const createWebviewWindow = (label: string, options: any) => {
    if (window.__TAURI__) {
        return new window.__TAURI__.webviewWindow.WebviewWindow(label, options);
    }
    console.warn(`[Tauri] createWebviewWindow failed: API not found`);
    return null;
};

export const waitForTauri = (): Promise<void> => {
    return new Promise((resolve) => {
        if (window.__TAURI__) {
            resolve();
            return;
        }
        
        const check = setInterval(() => {
            if (window.__TAURI__) {
                clearInterval(check);
                resolve();
            }
        }, 10);
        
        // 超时保底 (例如 2秒)，避免死等
        setTimeout(() => {
            clearInterval(check);
            resolve();
        }, 2000);
    });
};
