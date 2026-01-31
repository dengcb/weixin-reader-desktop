/**
 * 插件系统入口
 * Plugin System Entry Point
 * 
 * 导出所有插件相关模块
 */

// 内置插件
export { builtinPluginFactories, createBuiltinPlugins, createWeReadPlugin } from './builtin';

// 类型（从核心模块重新导出）
export type {
  ReaderPlugin,
  PluginManifest,
  PluginCapabilities,
  PluginStyles,
  PluginAPI,
  SourceType,
  RenderMode,
} from '../scripts/core/plugin_types';
