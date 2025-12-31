import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

const rootDir = process.cwd();
const releaseDir = join(rootDir, 'release');
const srcTauriDir = join(rootDir, 'src-tauri');

// 将绝对路径转换为相对路径（用于日志显示）
function relPath(absPath: string): string {
    return absPath.replace(rootDir + '/', '').replace(rootDir, '.');
}

// 运行命令并处理输出（将绝对路径替换为相对路径）
function runCommandWithFilteredOutput(cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
    const child = spawn(cmd, args, {
        env,
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: true
    });

    // 处理 stdout
    child.stdout?.on('data', (data) => {
        const output = data.toString();
        const filtered = output.replace(new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.');
        process.stdout.write(filtered);
    });

    // 处理 stderr
    child.stderr?.on('data', (data) => {
        const output = data.toString();
        const filtered = output.replace(new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.');
        process.stderr.write(filtered);
    });

    // 等待命令完成
    return new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command exited with code ${code}`));
            }
        });
    });
}

// 格式化时间显示
function formatDuration(ms: number): string {
    const seconds = (ms / 1000).toFixed(2);
    return `${seconds}s`;
}

// 执行步骤并计时
async function runStep(name: string, fn: () => void | Promise<void>) {
    console.log(`\n⏳ [${name}] Starting...`);
    const start = performance.now();
    try {
        await fn();
        const end = performance.now();
        console.log(`✅ [${name}] Finished in ${formatDuration(end - start)}`);
    } catch (error) {
        console.error(`❌ [${name}] Failed!`);
        throw error;
    }
}

// 专门用于执行命令的步骤
function runCommandStep(name: string, command: string, env: NodeJS.ProcessEnv = process.env) {
    runStep(name, () => {
        execSync(command, { stdio: 'inherit', env });
    });
}

console.log('🚀 Starting Release Process...');
const totalStart = performance.now();

const args = process.argv.slice(2);
const command = args[0]; // 'upload' | 'publish' | 'arm' | 'intel' | undefined (default: build all)

(async () => {
    try {
        if (command === 'upload') {
            await runUpload();
        } else if (command === 'publish') {
            await runPublish();
        } else {
            // Build & Notarize
            // Determine targets based on command
            let targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
            if (command === 'arm') {
                targets = ['aarch64-apple-darwin'];
            } else if (command === 'intel') {
                targets = ['x86_64-apple-darwin'];
            }
            
            await runBuildAndNotarize(targets);
        }

    } catch (error) {
        console.error('\n💥 Release process failed!');
        process.exit(1);
    }

    const totalEnd = performance.now();
    console.log(`\n✨ All done! Total time: ${formatDuration(totalEnd - totalStart)}`);
})();

// -------------------------------------------------------------------------
// Phase 1: Build & Notarize
// -------------------------------------------------------------------------
async function runBuildAndNotarize(targets: string[]) {
    // Check Env Vars
    const { APPLE_ID, APPLE_PASSWORD, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, TAURI_SIGNING_PRIVATE_KEY } = process.env;
    const applePassword = APPLE_APP_SPECIFIC_PASSWORD || APPLE_PASSWORD;

    if (!APPLE_ID || !applePassword || !APPLE_TEAM_ID) {
        console.warn('\n⚠️  WARNING: Apple Credentials not found in environment variables!');
        console.warn('   - APPLE_ID');
        console.warn('   - APPLE_APP_SPECIFIC_PASSWORD (preferred) or APPLE_PASSWORD');
        console.warn('   - APPLE_TEAM_ID');
        console.warn('   Notarization will be SKIPPED by Tauri and this script.\n');
    } else {
        console.log('✅ Apple Credentials found.');
        // Ensure Tauri can see them too
        if (!process.env.APPLE_PASSWORD && APPLE_APP_SPECIFIC_PASSWORD) {
             process.env.APPLE_PASSWORD = APPLE_APP_SPECIFIC_PASSWORD;
        }
    }

    if (!TAURI_SIGNING_PRIVATE_KEY) {
        console.warn('\n⚠️  WARNING: TAURI_SIGNING_PRIVATE_KEY not found!');
        console.warn('   Updater artifacts (.tar.gz) will NOT be generated.');
    } else {
        console.log('✅ TAURI_SIGNING_PRIVATE_KEY found.');
        // Ensure password is set (even if empty) to avoid Tauri confusion
        if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
            process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
        }
    }

    // 阶段 1: Build & Sign App (同步版本 -> 构建 -> 签名)
    // 1.1 同步版本
    await runStep('Sync Version', () => {
        execSync('bun src/scripts/sync_version.ts', { stdio: 'inherit' });
    });

    // 1.2 执行 Tauri 构建 (双架构独立构建)
    // 获取版本号
    const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
    const version = packageJson.version;

    for (const target of targets) {
        await runStep(`Build for ${target}`, async () => {
            // 使用当前环境变量，让 Tauri 自动处理 App 的公证 (Notarization)
            await runCommandWithFilteredOutput('tauri', ['build', '--target', target], { ...process.env });

            // Copy Artifacts immediately after build to avoid overwrites or confusion
            const targetBundleDir = join(srcTauriDir, 'target', target, 'release', 'bundle');
            const archSuffix = target.includes('aarch64') ? 'aarch64' : 'x86_64';
            
            if (!existsSync(releaseDir)) {
                mkdirSync(releaseDir, { recursive: true });
            }

            // Copy DMG with rename
            const dmgDir = join(targetBundleDir, 'dmg');
            if (existsSync(dmgDir)) {
                const files = readdirSync(dmgDir).filter(f => f.endsWith('.dmg'));
                for (const file of files) {
                    const src = join(dmgDir, file);
                    // Rename to English standard: weixin-reader-0.2.0-aarch64.dmg
                    const destName = `weixin-reader-${version}-${archSuffix}.dmg`;
                    const dest = join(releaseDir, destName);
                    copyFileSync(src, dest);
                    console.log(`   Copied DMG: ${destName}`);
                }
            }
            
            const appDir = join(targetBundleDir, 'macos');
            if (existsSync(appDir)) {
                const allFiles = readdirSync(appDir);

                // Copy and Rename Updater Artifacts (tar.gz or zip)
                let files = allFiles.filter(f => f.endsWith('.tar.gz') || f.endsWith('.tar.gz.sig') || f.endsWith('.zip') || f.endsWith('.zip.sig') || f.endsWith('.tar.zst') || f.endsWith('.tar.zst.sig'));
                
                if (files.length === 0) {
                        console.warn(`   ⚠️ No .tar.gz, .zip, or .tar.zst files found in ${relPath(appDir)}.`);
                        console.warn(`   ⚠️ Tauri should have generated updater artifacts automatically.`);
                        console.warn(`   ⚠️ Please check:`);
                        console.warn(`      1. bundle.createUpdaterArtifacts is set to true in tauri.conf.json`);
                        console.warn(`      2. TAURI_SIGNING_PRIVATE_KEY environment variable is set`);
                        console.warn(`      3. Private key password is correct`);

                        /*
                        // Fallback: Manual Generation if Private Key is present
                        // NOTE: This is a fallback method. With createUpdaterArtifacts: true,
                        // Tauri should generate these files automatically.
                        if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
                             console.log(`   🛠️  Attempting manual generation of updater artifacts...`);

                             // Find the .app file
                             const appFiles = allFiles.filter(f => f.endsWith('.app'));
                             if (appFiles.length > 0) {
                                 const appName = appFiles[0];
                                 const tarName = `${appName}.tar.gz`;
                                 const tarPath = join(appDir, tarName);

                                 try {
                                     // 1. Create tar.gz (preserve structure: weixin-reader.app/)
                                     console.log(`      Creating ${tarName}...`);
                                     execSync(`tar -czf "${tarPath}" -C "${appDir}" "${appName}"`, { stdio: 'inherit' });

                                     // 2. Sign the tar.gz
                                     console.log(`      Signing ${tarName}...`);

                                     // Map TAURI_SIGNING_PRIVATE_KEY to TAURI_PRIVATE_KEY for 'tauri signer'
                                     const env = {
                                         ...process.env,
                                         TAURI_PRIVATE_KEY: process.env.TAURI_SIGNING_PRIVATE_KEY,
                                         TAURI_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || ''
                                     };

                                     execSync(`bun tauri signer sign "${tarPath}"`, { stdio: 'inherit', env });

                                     console.log(`      ✅ Manual generation successful!`);

                                     // Re-scan files to include the new ones
                                     const newAllFiles = readdirSync(appDir);
                                     files = newAllFiles.filter(f => f.endsWith('.tar.gz') || f.endsWith('.tar.gz.sig'));

                                 } catch (e) {
                                     console.error(`      ❌ Manual generation failed:`, e);
                                 }
                             } else {
                                 console.warn(`      ❌ No .app file found to package.`);
                             }
                        } else {
                            console.warn(`      ❌ Cannot manually generate: TAURI_SIGNING_PRIVATE_KEY not found.`);
                        }
                        */
                }

                for (const file of files) {
                        const srcPath = join(appDir, file);
                        // Rename tar.gz and sig to include arch to avoid conflicts
                        
                        let destName = file;
                        // Standardize extension if needed, but keep original if possible to match signature
                        // But we must include arch.
                        
                        if (file.endsWith('.tar.gz')) {
                                destName = `weixin-reader-${version}-${archSuffix}.app.tar.gz`;
                        } else if (file.endsWith('.tar.gz.sig')) {
                                destName = `weixin-reader-${version}-${archSuffix}.app.tar.gz.sig`;
                        } else if (file.endsWith('.zip')) {
                             destName = `weixin-reader-${version}-${archSuffix}.app.zip`;
                        } else if (file.endsWith('.zip.sig')) {
                             destName = `weixin-reader-${version}-${archSuffix}.app.zip.sig`;
                        } else if (file.endsWith('.tar.zst')) {
                             destName = `weixin-reader-${version}-${archSuffix}.app.tar.zst`;
                        } else if (file.endsWith('.tar.zst.sig')) {
                             destName = `weixin-reader-${version}-${archSuffix}.app.tar.zst.sig`;
                        }

                    const destPath = join(releaseDir, destName);
                    // Use renameSync (mv) instead of copyFileSync (cp) to ensure we don't leave old artifacts
                    // preventing stale files in next runs if build fails to generate new ones.
                    renameSync(srcPath, destPath);
                    console.log(`   Moved Updater Asset: ${destName}`);
                }
            } else {
                console.warn(`   ⚠️ Directory not found: ${relPath(appDir)}`);
            }
        });
    }

    // 阶段 2: Notarize DMGs (对所有生成的 DMG 进行公证)
    await runStep('Notarize DMGs', async () => {
        const dmgs = readdirSync(releaseDir).filter(f => f.endsWith('.dmg'));

        if (dmgs.length === 0) {
            console.warn('⚠️ No DMGs found to notarize.');
            return;
        }

        const { APPLE_ID, APPLE_PASSWORD, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
        const password = APPLE_APP_SPECIFIC_PASSWORD || APPLE_PASSWORD;

        if (!APPLE_ID || !password || !APPLE_TEAM_ID) {
             console.warn('⚠️ Missing Apple credentials. Skipping DMG notarization.');
             return;
        }

        for (const dmg of dmgs) {
            console.log(`   Notarizing ${dmg}...`);
            const dmgPath = join(releaseDir, dmg);

            try {
                // Submit
                await runCommandWithFilteredOutput('xcrun', ['notarytool', 'submit', dmgPath, '--apple-id', APPLE_ID, '--password', password, '--team-id', APPLE_TEAM_ID, '--wait'], process.env);
                // Staple
                await runCommandWithFilteredOutput('xcrun', ['stapler', 'staple', dmgPath], process.env);
                console.log(`   🍏 Notarized & Stapled: ${dmg}`);
            } catch (e) {
                console.error(`   ❌ Failed to notarize ${dmg}`);
                throw e;
            }
        }
    });

    // Generate latest.json
    try {
        generateLatestJson();
    } catch (e) {
        console.error('⚠️ Failed to generate latest.json:', e);
    }
    
    console.log(`📂 Files are ready in: ${relPath(releaseDir)}`);
    console.log(`👉 Next step: Run 'bun run release:upload' to upload artifacts.`);
}

// -------------------------------------------------------------------------
// Phase 2: Upload (Draft)
// -------------------------------------------------------------------------
async function runUpload() {
    await runStep('Upload to GitHub (Draft)', async () => {
        const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        if (!token) {
                throw new Error('⚠️  GITHUB_TOKEN not found. Cannot upload.');
        }

        if (!existsSync(releaseDir)) {
            throw new Error(`Release directory not found: ${relPath(releaseDir)}. Please run 'bun run release' first.`);
        }

        // Regenerate latest.json to be sure (or just use existing)
        generateLatestJson();
        
        console.log('   Uploading to GitHub Release (via API)...');

        // 获取版本号
        const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
        const version = packageJson.version;
        const tagName = `v${version}`;
        const owner = 'dengcb';
        const repo = 'weixin-reader-desktop';

        // GitHub API Helpers
        const headers = {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'weixin-reader-release-script'
        };

        async function request(url: string, options: RequestInit = {}) {
            const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
            if (!res.ok) {
                const body = await res.text();
                throw new Error(`GitHub API Error: ${res.status} ${res.statusText}\n${body}`);
            }
            return res.json();
        }

        // 1. 获取或创建 Release (Draft)
        let release: any;
        try {
            console.log(`   Checking for existing release ${tagName}...`);
            release = await request(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tagName}`);
            console.log(`   Found existing release: ${release.id}`);
        } catch (e) {
            console.log(`   Release ${tagName} not found, creating new DRAFT release...`);
            release = await request(`https://api.github.com/repos/${owner}/${repo}/releases`, {
                method: 'POST',
                body: JSON.stringify({
                    tag_name: tagName,
                    name: `v${version}`,
                    body: `Auto-released v${version}`,
                    draft: true, // Create as draft
                    prerelease: false
                })
            });
            console.log(`   Created new draft release: ${release.id}`);
        }

        // 2. 上传 Assets
        const uploadUrlTemplate = release.upload_url;
        const uploadBaseUrl = uploadUrlTemplate.split('{')[0];

        const filesToUpload = readdirSync(releaseDir).filter(f => !f.endsWith('.DS_Store'));
        
        for (const fileName of filesToUpload) {
            const filePath = join(releaseDir, fileName);
            console.log(`   Uploading ${fileName}...`);
            
            // 检查是否已存在同名 asset，如果存在则先删除
            if (release.assets && release.assets.length > 0) {
                const existingAsset = release.assets.find((a: any) => a.name === fileName);
                if (existingAsset) {
                        console.log(`     Deleting existing asset ${existingAsset.id}...`);
                        await fetch(existingAsset.url, { method: 'DELETE', headers });
                }
            }

            const fileBuffer = readFileSync(filePath);
            
            const uploadRes = await fetch(`${uploadBaseUrl}?name=${fileName}`, {
                method: 'POST',
                headers: {
                    ...headers,
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': fileBuffer.length.toString()
                },
                body: fileBuffer
            });

            if (!uploadRes.ok) {
                    const body = await uploadRes.text();
                    throw new Error(`Failed to upload ${fileName}: ${uploadRes.status} ${uploadRes.statusText}\n${body}`);
            }
            console.log(`     ✅ Uploaded ${fileName}`);
        }
        
        console.log('   All assets uploaded successfully!');
        console.log(`👉 Next step: Run 'bun run release:publish' to publish the release.`);
    });
}

// -------------------------------------------------------------------------
// Phase 3: Publish
// -------------------------------------------------------------------------
async function runPublish() {
    await runStep('Publish Release', async () => {
        const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        if (!token) {
            throw new Error('⚠️  GITHUB_TOKEN not found.');
        }

        const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
        const version = packageJson.version;
        const tagName = `v${version}`;
        const owner = 'dengcb';
        const repo = 'weixin-reader-desktop';

        const headers = {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'weixin-reader-release-script'
        };

        async function request(url: string, options: RequestInit = {}) {
            const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
            if (!res.ok) {
                const body = await res.text();
                throw new Error(`GitHub API Error: ${res.status} ${res.statusText}\n${body}`);
            }
            return res.json();
        }

        console.log(`   Checking release ${tagName}...`);
        let release: any;
        try {
            // Draft releases cannot always be retrieved by tag directly via API
            // Instead, list releases and find by tag_name
            const releases: any[] = await request(`https://api.github.com/repos/${owner}/${repo}/releases`);
            release = releases.find((r: any) => r.tag_name === tagName);
            
            if (!release) {
                 // Fallback to tag lookup just in case (e.g. if it's already published and paginated out, though unlikely for latest)
                 try {
                    release = await request(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tagName}`);
                 } catch (e) {
                    throw new Error(`Release ${tagName} not found in list or by tag! Please upload first.`);
                 }
            }
        } catch (e) {
             console.error(`   ❌ Error finding release ${tagName}:`, e);
             throw e;
        }

        // Check for latest.json
        const hasLatestJson = release.assets && release.assets.some((a: any) => a.name === 'latest.json');
        if (!hasLatestJson) {
            console.error('   ❌ Assets found:', release.assets ? release.assets.map((a: any) => a.name).join(', ') : 'None');
            throw new Error(`❌ latest.json not found in release assets. Please run 'bun run release:upload' first.`);
        }

        console.log(`   Found latest.json. Publishing release...`);

        // Update release to published (draft: false)
        await request(release.url, {
            method: 'PATCH',
            body: JSON.stringify({
                draft: false
            })
        });

        console.log(`✅ Release ${tagName} is now PUBLISHED!`);
    });
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
function generateLatestJson() {
    const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
    const version = packageJson.version;
    const tagName = `v${version}`;

    console.log(`   Generating latest.json for version ${version} (${tagName})...`);

    if (!existsSync(releaseDir)) {
         console.warn(`   ⚠️ Release directory does not exist (${relPath(releaseDir)}), skipping latest.json generation.`);
         return;
    }
    
    // We need to support both architectures if they exist in release dir
    const platforms: Record<string, { signature: string, url: string }> = {};
    
    const files = readdirSync(releaseDir);
    
    for (const file of files) {
        if (file.endsWith('.tar.gz')) {
            const sigFile = file + '.sig';
            if (existsSync(join(releaseDir, sigFile))) {
                let signature = readFileSync(join(releaseDir, sigFile), 'utf-8').trim();

                // The .sig file on disk might be the raw Minisign text OR Base64 encoded Minisign text.
                // Tauri Updater v2 expects the Base64 encoded string of the FULL Minisign file (including comments).

                if (signature.startsWith('dW50cnVzdGVk')) {
                     // It is already Base64 encoded Minisign file content. Keep it as is.
                } else if (signature.startsWith('untrusted comment:')) {
                     // It is raw text. We should Base64 encode it for latest.json
                     signature = Buffer.from(signature, 'utf-8').toString('base64');
                }
                
                // Remove the old extraction logic which stripped the comments
                /*
                // 1. Decode if it looks like Base64-encoded Minisign (starts with "dW50cnVzdGVk" -> "untrusted")
                if (signature.startsWith('dW50cnVzdGVk')) {
                    try {
                        console.log('      ⚠️  Detected Base64 encoded Minisign file, decoding...');
                        signature = Buffer.from(signature, 'base64').toString('utf-8').trim();
                    } catch (e) {
                        console.warn('      ❌ Failed to decode Base64 signature:', e);
                    }
                }
                
                // ... (rest of old logic)
                */

                const url = `https://github.com/dengcb/weixin-reader-desktop/releases/download/${tagName}/${file}`;
                
                // Determine arch from filename
                let arch = '';
                if (file.includes('aarch64')) {
                    arch = 'darwin-aarch64';
                } else if (file.includes('x86_64')) {
                    arch = 'darwin-x86_64';
                }
                
                if (arch) {
                    platforms[arch] = { signature, url };
                }
            }
        }
    }
    
    const latestJson = {
        version: tagName,
        notes: `Update to ${tagName}`,
        pub_date: new Date().toISOString(),
        platforms
    };

    writeFileSync(join(releaseDir, 'latest.json'), JSON.stringify(latestJson, null, 2));
    console.log('   ⬆️ Generated latest.json');
}
