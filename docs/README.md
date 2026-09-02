# 文档索引

根目录 [README](../README.md) 面向使用 RA2 Explorer 的普通用户。`docs/` 只保存仍需长期维护的说明，不记录开发对话、阶段计划、临时排障过程、本机绝对路径或一次性验收日志。

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [游戏文件](GAME_FILES.md) | 用户 | 合法安装来源、自动发现与只读导入 |
| [派生资源包](RESOURCE_PACKS.md) | 用户 | `.ra2pack` 的备份、迁移和安全边界 |
| [应用更新](UPDATES.md) | 用户、维护者 | 可选更新检查与稳定版发布 |
| [GitHub Pages](GITHUB_PAGES.md) | 用户、维护者 | 在线精简版、体积和静态发布 |
| [发行说明](DISTRIBUTION.md) | 用户、维护者 | Windows 构建模式、包内容与体积 |
| [隐私与发布安全](PRIVACY.md) | 贡献者、维护者 | 本机数据边界、提交和历史扫描 |
| [开发指南](DEVELOPMENT.md) | 开发者 | 环境、测试、后台服务和发布命令 |
| [架构](ARCHITECTURE.md) | 开发者 | 当前运行模型、语义层、缓存与 API 边界 |
| [游戏源输入](GAME_SOURCE_INPUTS.md) | 开发者 | 真正参与解析的零售文件与覆盖顺序 |

实现事实优先以代码、测试和锁定清单为准：应用版本在 `pyproject.toml`，Pages 完整数据在 `packaging/pages-data.json`，高频 CDN 数据在 `packaging/pages-cdn.json`，自动发布流程在 `.github/workflows/`。已经退出主线的部署实验、临时脚本和排障结论由 Git 历史保存，不作为当前文档继续维护；容易变化的 commit、快照哈希和构建结果也不复制到多份文档。
