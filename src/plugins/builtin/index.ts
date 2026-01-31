/**
 * 内置插件索引
 * Builtin Plugins Index
 * 
 * 注册所有内置插件的工厂函数
 */

import { createWeReadPlugin } from './weread';
import type { ReaderPlugin } from '../../scripts/core/plugin_types';

/**
 * 内置插件工厂函数列表
 * 每个工厂函数返回一个插件实例
 */
export const builtinPluginFactories: Array<() => ReaderPlugin> = [
  createWeReadPlugin,
  // 未来添加更多内置插件:
  // createQidianPlugin,
  // createFanqiePlugin,
];

/**
 * 获取所有内置插件实例
 */
export const createBuiltinPlugins = (): ReaderPlugin[] => {
  return builtinPluginFactories.map(factory => factory());
};

// 导出微信读书插件供直接引用
export { createWeReadPlugin } from './weread';
