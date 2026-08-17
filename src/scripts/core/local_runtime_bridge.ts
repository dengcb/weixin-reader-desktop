import type { Chapter, PluginAPI } from './plugin_types';

export interface LocalReaderController {
  attachPluginAPI(api: PluginAPI): void;
  detachPluginAPI(): void;
  isReady(): boolean;
  isDoubleColumn(): boolean;
  nextPage(): void | Promise<void>;
  prevPage(): void | Promise<void>;
  nextChapter(): boolean | Promise<boolean>;
  prevChapter(): boolean | Promise<boolean>;
  back(): void | Promise<void>;
  forward(): void | Promise<void>;
  getChapters(): Promise<Chapter[]>;
  getChapterProgress(): number;
  isAtBottom(): boolean;
}

let controller: LocalReaderController | null = null;

export const setLocalReaderController = (next: LocalReaderController | null): void => {
  controller = next;
};

export const getLocalReaderController = (): LocalReaderController | null => controller;
