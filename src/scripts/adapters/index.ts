/**
 * 适配器注册中心
 *
 * 添加新网站支持的步骤：
 * 1. 创建新的适配器类（实现 ReadingSiteAdapter 接口）
 * 2. 在下面的 adapters 数组中添加该适配器类
 * 3. 无需修改其他文件，适配器会自动注册
 */

import { WeReadAdapter } from './weread_adapter';
import type { ReadingSiteAdapter } from './reading_site_adapter';

/**
 * 所有支持的网站适配器列表
 * 添加新网站时，只需在此数组中添加对应的适配器类
 */
export const adapters: Array<new () => ReadingSiteAdapter> = [
  WeReadAdapter,
  // 未来新增站点示例：
  // BookWalkerAdapter,
  // KindleCloudAdapter,
  // ZLibAdapter,
];

/**
 * 获取所有适配器实例
 * @returns 适配器实例数组
 */
export const createAdapterInstances = (): ReadingSiteAdapter[] => {
  return adapters.map(AdapterClass => new AdapterClass());
};
