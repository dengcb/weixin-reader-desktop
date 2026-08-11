# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## 项目与角色

- 项目：艾特阅读（`dengcb/weixin-reader-desktop`）
- 许可证：[MIT](../LICENSE)
- Committer、Reviewer：Deng Changbin（[@dengcb](https://github.com/dengcb)）
- Approver：Deng Changbin（[@dengcb](https://github.com/dengcb)）
- 所有可写入仓库、审核变更和批准签名的账号都必须在 GitHub 与 SignPath 启用多因素认证。
- Reviewer 审核外部贡献；Approver 逐次人工批准正式发布标签的签名请求。

## 隐私与网络访问

本程序不会把任何信息传输到其他联网系统，除非用户或安装、运行本程序的人明确请求。用户登录或阅读时，应用会按其操作访问微信读书服务 `weread.qq.com`；该服务适用腾讯的隐私条款。项目隐私政策随应用发布，源文件为 [`src/windows/privacy.html`](../src/windows/privacy.html)。

## 构建来源与签名

- 只签署本仓库正式版本标签对应、由受保护 GitHub Actions 工作流从该标签源码构建的 Windows NSIS 产物。
- 标签版本、`package.json`、Tauri 配置、Cargo 根包版本和发布元数据必须一致。
- 每次签名都要求人工批准；不签署本地构建、分支构建、PR 构建、第三方二进制或来源不可验证的产物。
- SignPath 对最终 NSIS `exe` 完成 Authenticode 签名后，才使用项目长期不变的 Tauri updater 私钥生成 `.sig`。任何会改变 `exe` 字节的操作都必须发生在 updater 签名之前。
- Tauri updater 签名用于更新完整性与连续性验证；它不代表 Windows Authenticode 发布者身份。
- 正式 Release 同时发布 SHA-256。任何来源、审核、签名或哈希校验不满足政策的产物都不得发布。

项目已获 SignPath Foundation 批准，通过 GitHub Actions 自动完成 Authenticode 签名。证书状态从 `CSR PENDING` 转为 `Active` 后，所有正式 Windows NSIS 产物将自动携带 Authenticode 签名。此前的版本（v1.4.0 及更早）因证书尚未签发，Windows 安装包未携带 Authenticode 签名。

## SignPath GitHub Actions 集成

### 仓库内文件

- `.signpath/artifact-configurations/default.xml` — 签名规则，告诉 SignPath 对 NSIS exe 做 Authenticode 签名。此文件必须在仓库的默认分支上，SignPath GitHub App 从仓库读取。
- `.github/workflows/release.yml` — 两个 Windows job（x64 + ARM64）各包含签名步骤。

### GitHub Secrets / Variables

| 类型 | Name | 用途 |
|------|------|------|
| Secret | `SIGNPATH_API_TOKEN` | SignPath 后台创建的 API Token（Submitter 角色），Secret 未配置时自动跳过签名 |
| Variable | `SIGNPATH_ORGANIZATION_ID` | SignPath 组织 ID（GUID） |

### 签名流程

每个 Windows job 在 stage 标准化之后、上传到 draft release 之前：

1. `actions/upload-artifact@v4` 上传未签名的 exe 作为 GitHub artifact。
2. `signpath/github-action-submit-signing-request@v2` 提交签名请求，SignPath 通过 GitHub artifact ID 拉取文件，完成 Authenticode 签名后返回。
3. 下载签名后的 exe 替换原始文件，重新计算 SHA256 和 Authenticode 状态。
4. `SIGNPATH_API_TOKEN` Secret 未配置时，签名步骤通过 `if: steps.check-signpath.outputs.available == 'true'` 自动跳过，回退到 NotSigned。

### SignPath 后台配置

- 项目：`weixin-reader-desktop`
- 签名策略：`release-signing`
- Trusted Build System：GitHub.com
- Artifact Configuration：指向仓库的 `.signpath/artifact-configurations/default.xml`
- 安装 SignPath GitHub App 到仓库

## 感谢

感谢 [SignPath Foundation](https://signpath.org/) 为本开源项目免费提供代码签名证书和签名服务。SignPath Foundation 让开源项目无需购买昂贵的代码签名证书，即可为用户提供受信任的 Windows 安装包，消除 SmartScreen "未知发布者" 警告。

**[SignPath Foundation — Free Code Signing for Open Source](https://signpath.org/)**
