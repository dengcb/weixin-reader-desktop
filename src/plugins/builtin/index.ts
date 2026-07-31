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
 *
 * 注：番茄小说作为「官方外部插件」发布（编译为 .atrd），不在此处作为内置插件注册。
 */
export const builtinPluginFactories: Array<() => ReaderPlugin> = [
  createWeReadPlugin,
];

/**
 * 获取所有内置插件实例
 */
export const createBuiltinPlugins = (): ReaderPlugin[] => {
  return builtinPluginFactories.map(factory => factory());
};

// 导出内置插件供直接引用
export { createWeReadPlugin } from './weread';
