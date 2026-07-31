/**
 * 插件编译脚本
 * 将内置插件编译为可分发的 .atrd 格式
 * 
 * 用法: bun src/scripts/build_plugin.ts [pluginId]
 * 示例: bun src/scripts/build_plugin.ts weread
 */

import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { $ } from 'bun';

const BUILTIN_PLUGINS_DIR = 'src/plugins/builtin';
const EXTERNAL_PLUGINS_DIR = 'plugins';
// 输出到 release/（同样被 git 忽略，但不会被 `rm -rf dist` 清掉）
const OUTPUT_DIR = 'release/plugins';

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  builtin?: boolean;
  [key: string]: any;
}

/**
 * 解析插件源码目录
 * 优先从外部插件目录 plugins/ 查找，回退到内置插件目录
 */
function resolvePluginDir(pluginId: string): string | null {
  const externalDir = join(EXTERNAL_PLUGINS_DIR, pluginId);
  if (existsSync(join(externalDir, 'manifest.json'))) {
    return externalDir;
  }
  const builtinDir = join(BUILTIN_PLUGINS_DIR, pluginId);
  if (existsSync(join(builtinDir, 'manifest.json'))) {
    return builtinDir;
  }
  return null;
}

async function buildPlugin(pluginId: string): Promise<void> {
  console.log(`\n📦 Building plugin: ${pluginId}\n`);
  
  const pluginDir = resolvePluginDir(pluginId);
  
  // 1. 检查插件目录是否存在
  if (!pluginDir) {
    console.error(`❌ Plugin not found in '${EXTERNAL_PLUGINS_DIR}/${pluginId}' or '${BUILTIN_PLUGINS_DIR}/${pluginId}'`);
    process.exit(1);
  }
  
  const manifestPath = join(pluginDir, 'manifest.json');
  const indexPath = join(pluginDir, 'index.ts');
  const stylesDir = join(pluginDir, 'styles');
  
  if (!existsSync(indexPath)) {
    console.error(`❌ Plugin entry not found: ${indexPath}`);
    process.exit(1);
  }
  
  // 2. 读取并修改 manifest
  const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const externalManifest = {
    ...manifest,
    builtin: false  // 标记为外部插件
  };
  
  console.log(`  Plugin: ${manifest.name} v${manifest.version}`);
  
  // 3. 创建临时构建目录
  const tempDir = join(OUTPUT_DIR, `_temp_${pluginId}`);
  const outputFile = join(OUTPUT_DIR, `${pluginId}.atrd`);
  
  // 清理旧文件
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true });
  }
  if (existsSync(outputFile)) {
    rmSync(outputFile);
  }
  
  // 确保输出目录存在
  mkdirSync(tempDir, { recursive: true });
  
  // 4. 编译 TypeScript 到 JavaScript
  console.log(`  Compiling ${indexPath}...`);
  
  const pluginJsPath = join(tempDir, 'plugin.js');
  
  try {
    // 使用 Bun 编译 TypeScript
    await $`bun build ${indexPath} --outfile=${pluginJsPath} --target=browser --minify-whitespace`;
    console.log(`  ✓ Compiled to plugin.js`);
  } catch (e) {
    console.error(`❌ Failed to compile plugin:`, e);
    process.exit(1);
  }
  
  // 5. 写入修改后的 manifest
  writeFileSync(
    join(tempDir, 'manifest.json'),
    JSON.stringify(externalManifest, null, 2)
  );
  console.log(`  ✓ Created manifest.json (builtin: false)`);
  
  // 6. 复制样式文件
  if (existsSync(stylesDir)) {
    cpSync(stylesDir, join(tempDir, 'styles'), { recursive: true });
    console.log(`  ✓ Copied styles directory`);
  }
  
  // 7. 打包为 ZIP（.atrd 格式）
  console.log(`  Packaging...`);
  
  try {
    // 使用 zip 命令打包
    const cwd = process.cwd();
    process.chdir(tempDir);
    await $`zip -r ../${pluginId}.atrd .`;
    process.chdir(cwd);
    console.log(`  ✓ Created ${pluginId}.atrd`);
  } catch (e) {
    console.error(`❌ Failed to create ZIP package:`, e);
    process.exit(1);
  }
  
  // 8. 清理临时目录
  rmSync(tempDir, { recursive: true });
  
  console.log(`\n✅ Successfully built: ${outputFile}`);
  console.log(`   Size: ${(Bun.file(outputFile).size / 1024).toFixed(1)} KB\n`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // 默认编译 weread 插件
    await buildPlugin('weread');
  } else if (args[0] === '--all') {
    // 编译所有插件（外部 plugins/ + 内置 builtin/）
    const { readdirSync } = await import('fs');
    const collectPlugins = (dir: string): string[] => {
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(name => existsSync(join(dir, name, 'manifest.json')));
    };
    // 去重（外部优先）
    const plugins = Array.from(new Set([
      ...collectPlugins(EXTERNAL_PLUGINS_DIR),
      ...collectPlugins(BUILTIN_PLUGINS_DIR),
    ]));
    
    for (const pluginId of plugins) {
      await buildPlugin(pluginId);
    }
  } else {
    // 编译指定插件
    await buildPlugin(args[0]);
  }
}

main().catch(console.error);
