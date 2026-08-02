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

项目目前处于 SignPath Foundation 申请阶段。在服务获批并完成独立接入前，Windows Release 会明确标注未做 Authenticode 签名；这不改变 Tauri updater 签名的强制要求。
