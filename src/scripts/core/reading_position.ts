import { invoke } from './tauri';

export const getReadingPosition = (
  siteId: string,
  url: string,
): Promise<number | null> =>
  invoke<number | null>('get_reading_position', { siteId, url });

export const saveReadingPosition = (
  siteId: string,
  url: string,
  position: number,
): Promise<void> =>
  invoke<void>('save_reading_position', { siteId, url, position });
