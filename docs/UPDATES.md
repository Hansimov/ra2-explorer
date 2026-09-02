# 应用更新

## 用户侧流程

RA2 Explorer 的稳定版本、说明和 Windows 安装包统一发布到 [GitHub Releases](https://github.com/Hansimov/ra2-explorer/releases)。应用只在用户点击“检查更新”，或用户明确开启“应用启动时检查更新”后联网；不会静默下载、安装或覆盖程序。设置页始终显示本机版本，自动检查发现新版本时只在左侧“设置”入口显示提示点。

发现新版本后，设置页显示版本号、发布时间、文件大小、SHA-256 摘要和 Release 说明。用户可以打开 Release 页面或下载 `RA2-Explorer-Web-x64.zip`。应用只接受 `Hansimov/ra2-explorer` 仓库、名称完全匹配的 ZIP 和 HTTPS 下载地址，不读取第三方更新通道。

更新前关闭 RA2 Explorer，解压新版并保留原目录中的 `.runtime`；已有索引、预览、设置和 `.ra2pack` 不需要重新生成。当前应用只负责检查版本并在用户确认后下载，不会在本地服务仍运行时自行覆盖 EXE。下载完成后由用户关闭旧版并替换程序目录，避免静默安装或更新失败时破坏现有版本。

## 维护者发布流程

1. 完成功能与验证后同步更新 `pyproject.toml`、`src/ra2_explorer/__init__.py`、`frontend/package.json` 和 lockfile 的版本号；
2. 创建并推送对应的 `vX.Y.Z` Git tag；
3. Release workflow 在 Windows 中重新测试、隐私扫描并构建 generic 本地 Web 应用；
4. workflow 执行包内容审计和 CLI smoke，生成 ZIP 与构建来源证明；
5. workflow 使用仓库内置的 GitHub token 创建同名 GitHub Release 并上传 ZIP；
6. 在仓库设置中为后续 Release 启用 immutability，锁定 tag 与资产。

GitHub 的 latest Release API 会提供资产的 `browser_download_url`、大小和 `digest`，应用只接受当前项目仓库下名称完全匹配的 Windows ZIP：[REST Releases API](https://docs.github.com/en/rest/releases/releases)。Immutable Releases 会锁定 tag 与 Release 资产，并自动产生 Release attestation：[Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)。工作流使用 GitHub artifact attestation 记录构建来源：[Artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)。

构建来源证明说明产物来自哪次工作流和 commit，并不替代代码审查、恶意软件检测与 Windows Authenticode 签名。公开发行前仍应使用可信代码签名证书签署两个 EXE。
