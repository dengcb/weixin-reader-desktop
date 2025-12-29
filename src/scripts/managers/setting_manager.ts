import { listen, createWebviewWindow } from '../core/tauri';

export class SettingManager {
    constructor() {
        this.init();
    }

    private init() {
        // Backend now handles window creation directly.
        // This manager can be used for window content logic in the future.
    }
}
