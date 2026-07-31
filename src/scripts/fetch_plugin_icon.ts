/**
 * 插件图标抓取脚本（通用）
 * 从插件 manifest 的 site.homeUrl 自动抓取网站图标，转成 base64 data URI，
 * 写入该插件 manifest 的 `icon` 字段（离线自包含，不依赖 CDN/网络）。
 *
 * 用法:
 *   bun src/scripts/fetch_plugin_icon.ts <pluginId> [iconUrl]
 * 示例:
 *   bun run icon:fetch fanqie                    # 自动从 homeUrl 探测图标
 *   bun run icon:fetch fanqie https://x/icon.png # 指定图标 URL
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXTERNAL_PLUGINS_DIR = 'plugins';
const BUILTIN_PLUGINS_DIR = 'src/plugins/builtin';

/** 解析插件目录（优先外部 plugins/，回退内置 builtin/） */
function resolvePluginDir(pluginId: string): string | null {
  for (const base of [EXTERNAL_PLUGINS_DIR, BUILTIN_PLUGINS_DIR]) {
    const dir = join(base, pluginId);
    if (existsSync(join(dir, 'manifest.json'))) return dir;
  }
  return null;
}

/** 从站点 HTML 中探测最佳图标 URL */
async function detectIconUrl(homeUrl: string): Promise<string> {
  const origin = new URL(homeUrl).origin;
  try {
    const res = await fetch(homeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();

    // 收集所有 <link rel="...icon..."> 的 href
    const candidates: Array<{ href: string; rel: string }> = [];
    const linkRe = /<link\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
      const tag = m[0];
      const rel = (tag.match(/rel=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      if (href && rel.includes('icon')) candidates.push({ href, rel });
    }

    // 优先级: apple-touch-icon > shortcut icon > icon
    const pick =
      candidates.find(c => c.rel.includes('apple-touch-icon')) ||
      candidates.find(c => c.rel.includes('shortcut')) ||
      candidates[0];

    if (pick) return new URL(pick.href, homeUrl).href;
  } catch (e) {
    console.warn(`  ⚠ 解析首页图标失败，回退 /favicon.ico: ${e}`);
  }
  // 兜底
  return `${origin}/favicon.ico`;
}

/** 抓取图标并转为 data URI */
async function fetchAsDataUri(iconUrl: string): Promise<string> {
  const res = await fetch(iconUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${iconUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function main() {
  const [pluginId, explicitUrl] = process.argv.slice(2);
  if (!pluginId) {
    console.error('用法: bun src/scripts/fetch_plugin_icon.ts <pluginId> [iconUrl]');
    process.exit(1);
  }

  const pluginDir = resolvePluginDir(pluginId);
  if (!pluginDir) {
    console.error(`❌ 未找到插件 '${pluginId}'（plugins/ 或 ${BUILTIN_PLUGINS_DIR}/）`);
    process.exit(1);
  }

  const manifestPath = join(pluginDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  console.log(`\n🎨 抓取插件图标: ${pluginId}`);

  let iconUrl = explicitUrl;
  if (!iconUrl) {
    const homeUrl: string | undefined = manifest?.site?.homeUrl;
    if (!homeUrl) {
      console.error('❌ manifest 缺少 site.homeUrl，且未提供 iconUrl 参数');
      process.exit(1);
    }
    console.log(`  从首页探测图标: ${homeUrl}`);
    iconUrl = await detectIconUrl(homeUrl);
  }
  console.log(`  图标地址: ${iconUrl}`);

  const dataUri = await fetchAsDataUri(iconUrl);
  const sizeKb = (dataUri.length / 1024).toFixed(1);
  console.log(`  已转换为 data URI (${sizeKb} KB)`);

  manifest.icon = dataUri;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✅ 已写入 ${manifestPath} 的 icon 字段`);
  console.log(`   提示: 运行 'bun run build:plugin ${pluginId}' 重新打包 .atrd\n`);
}

main().catch((e) => {
  console.error('❌ 失败:', e);
  process.exit(1);
});
