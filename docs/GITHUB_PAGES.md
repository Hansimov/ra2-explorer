# GitHub Pages 精简版

## 当前结论

RA2 Explorer 已具备纯静态 GitHub Pages 发行模式。在线版地址是 <https://hansimov.github.io/ra2-explorer/>，只提供最适合快速体验的“单位”和“声音”两棵分类树；地图、地形、规则文件浏览、原始导出和本机目录解析继续由完整本地版提供。

精简版的导航和载入范围由快照清单限定，不继承本地版保存过的其他格式开关。只有快照中实际存在且数量大于零的声音格式会参与分类；缺少的数据接口不会用空的地图、图像、调色板或资源包占位。

Pages 不运行 Python、FastAPI 或 SQLite。发布前由本地解析器把真实安装转换成只读静态快照，前端的静态适配层在浏览器中完成目录读取、简繁/模糊/拼音搜索与补全、明确归属和无阵营筛选、事件筛选、排序、关联查询和详情请求。VXL 详情仍由 Three.js 交互渲染，SHP 与卡片使用预生成 WebP，声音按需播放 24 kbit/s Opus。

## 数据边界与体积

当前固定快照包含：

| 内容 | 数量或字节 | 约合 |
| --- | ---: | ---: |
| 单位 | 559 | — |
| 声音 | 3,322 | — |
| 发布文件 | 约 29,000 | — |
| 解包后的 Pages 数据 | 约 195,000,000 字节 | 约 186 MiB |
| 固定数据 ZIP | 约 129,000,000 字节 | 约 123 MiB |
| npm/jsDelivr 高频子集 | 约 15,800,000 字节 | 约 15 MiB |

精确的快照 ID、文件数、字节数、分片和 SHA-256 只记录在 [`packaging/pages-data.json`](../packaging/pages-data.json)；高频子集的固定 npm 版本、字节数和摘要只记录在 [`packaging/pages-cdn.json`](../packaging/pages-cdn.json)。这样发布数据变化时不会在多份文档中遗留旧标签或旧哈希。

站点不会在启动时下载整套数据，也不会把发布 ZIP 或 npm tarball 发送给访客。单位页先读取约 0.5 MiB 的当前语言单位目录、当前分类卡片图集和约 175 KiB 的当前角度搜索图集；每类卡片通常只产生一条约数百 KiB 的图集请求，全部搜索补全单位共用一张小图图集。HTML 会提前建立 CDN 连接，并预取启动清单、默认简体单位目录和默认角度搜索图集，使它们与应用 bundle 并行。快照清单直接携带声音类型、用途和事件计数，因此侧栏无需预读完整声音目录。交互模型、详情和声音仍按操作加载；搜索时单位结果先到先显示，不等待较大的声音索引。

启动清单、双语目录、单位卡片图集和搜索小图图集组成独立的固定版本 npm 包。浏览器通过 jsDelivr 请求其中的单个文件，不下载整包；CDN 不可用、超时或返回错误时，JSON 与图集自动回退到 Pages 内的同路径副本。模型、详情、动画和声音继续从 Pages 同源按需读取。双来源能利用不同地区的边缘缓存，但真实流量仍取决于访问路径和浏览器缓存；只有完整遍历所有资源时才可能接近整站体积。

GitHub 官方给出的 Pages 限制包括：发布站点最大 1 GB、每月 100 GB 软带宽限制、部署最长 10 分钟。当前站点约占容量上限的 14%；实际会话流量取决于用户打开的分类、模型与声音，以及浏览器和 CDN 缓存命中情况。[GitHub Pages 限制](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/github-pages-limits)

## 为什么大数据不进入主分支

主分支只追踪前端、导出器、审计脚本和两个小型锁定清单。完整 ZIP 拆为不超过 8 MiB 的资产，存放在独立的 [GitHub 数据 Release](https://github.com/Hansimov/ra2-explorer/releases)；具体 tag 由 `packaging/pages-data.json` 固定。该清单同时记录每片大小与 SHA-256，以及合并后整包大小与 SHA-256；高频启动文件存放在 npm，`packaging/pages-cdn.json` 记录精确版本、内容摘要和 jsDelivr 基址。Vite 直接读取 CDN 锁，不在多个环境文件中重复版本。

Pages workflow 从固定 GitHub 数据 Release 并行下载最多四个分片，逐片校验后按顺序合并，再依次验证整包字节数、SHA-256、ZIP 路径安全、文件类型白名单、原始游戏格式禁令、清单计数和隐私扫描；全部通过后才允许解包进站点 artifact。代码版本更新不会重新上传数据；只有解析结果、模型或声音实际变化时才创建新的数据 tag 并更新锁定清单。

## 构建与发布

本机重建快照：

```bat
.venv\Scripts\ra2exp.exe pages export SOURCE_ID --audio-bitrate 24k --workers 4 --overwrite
```

该命令会原子替换快照目录并自动生成 `.runtime\RA2MD-Ext\pages\RA2-Explorer-Pages-Data.zip`。渲染算法升级时必须递增 render revision，使图集和预览路径改变而不复用旧版 WebP；资产信息或关联结构变化时递增 asset bundle revision，只重建 JSON 而继续复用声音、模型和预览。压缩过程每 2,000 个文件输出一次进度，避免长时间没有反馈。中断构建保留在同目录的暂存结果，下一次运行会先复用完整文件。

审计最终 ZIP：

```bat
.venv\Scripts\python.exe scripts\verify_pages_snapshot.py ".runtime\RA2MD-Ext\pages\RA2-Explorer-Pages-Data.zip"
```

只有数据发生变化时才上传，并原子更新小型锁定清单：

```bat
.venv\Scripts\python.exe scripts\publish_pages_snapshot.py ".runtime\RA2MD-Ext\pages\RA2-Explorer-Pages-Data.zip" --tag pages-data-X.Y.Z
.venv\Scripts\python.exe scripts\publish_pages_cdn.py ".runtime\RA2MD-Ext\pages\RA2-Explorer-Pages-Data.zip" --version X.Y.Z --overwrite --publish
```

第一条发布命令从 `.secrets\local.env` 或进程环境读取 `GITHUB_TOKEN_RA2_EXPLORER`，先审计 ZIP，再把它拆为 8 MiB 分片上传；中断后重跑会校验并跳过已完成分片。第二条命令只提取清单、目录、卡片图集和搜索小图图集，`NPM_TOKEN` 同样只从本机凭据文件或进程环境读取。两个发布器都不会把令牌写入命令输出、包内容或锁定清单。npm 版本和数据 tag 不覆盖旧内容，每次数据变化必须使用新版本并同步提交两个锁。

前端静态构建和本机预览：

```bat
cd frontend
npm run build:pages
npm run preview:pages -- --host 127.0.0.1 --port 46131 --strictPort
```

Pages 构建写入独立的 `frontend\dist-pages`，普通本地应用继续使用 `frontend\dist`。构建器会先把已解包的 `dist-pages\data` 原子暂存到 `.runtime\RA2MD-Ext`，只清理前端产物，完成后再恢复数据；这样在 Windows 上不会因为同步删除约三万个小文件而长时间无输出。构建中断后，下次运行也会自动识别并恢复暂存目录。两种验证可以依次执行而不会用 `/ra2-explorer/` 的静态入口覆盖本机后台正在提供的根路径，也不会让自动化误等一个实际已经损坏的页面。

`.github\workflows\pages.yml` 在 `master` 的 Pages 前端、数据锁或部署脚本发生变化时运行，也会在推送 `v*` 稳定标签时重建，并支持手动触发。它使用官方 `configure-pages@v5`、`upload-pages-artifact@v4` 和 `deploy-pages@v4`；上传前会同时确认静态入口、前端 bundle 和数据清单存在，避免只发布数据目录。工作流会完整取回标签：当前提交正好对应 `v*` 标签时，设置正文顶部的信息栏显示稳定版标签并链接到对应 Release tag；其他提交显示八位 commit 并链接到该 commit。信息栏同时显示该构建相对最新稳定标签提前或落后的提交数及提交时间。部署 job 具有 `pages: write` 与 `id-token: write`，并使用 `github-pages` environment。[GitHub 自定义 Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

工作流在 `cmd` 中运行。每次前端稳定提交都会自动部署；数据快照保持固定，直到明确发布下一版数据并更新锁定清单。

## 已实施的流量优化

- 只发布单位和声音，不发布地图、地形、视频、规则全文或原始归档；
- SHP、单位卡片与效果使用 WebP，声音统一转为低码率 Opus；
- 只生成规则确实引用到的动画帧和方向组合；
- 只导出可与当前主体可靠对齐的主体、建造和运行图层；断点复用结束后清理已不再引用的效果资产；
- VXL 卡片只预生成一个标准角度，详情才加载可自由旋转的场景；
- 卡片只请求快照实际导出的朝向；无独立朝向的主体使用固定预览，步兵方向仍跟随默认角度；
- Pages 将每类单位卡片缩略图合并为单一 WebP 图集，并把全部单位的搜索小图合并为当前角度的一张共享图集；支持朝向的复合建筑保留八向卡片图集，主体与所选建筑状态在发布阶段预合成为可直接播放的 WebP；
- 启动目录、卡片图集与搜索图集优先走固定版本 jsDelivr，Pages 保留同源副本并仅在失败时回退，不用竞速请求制造双倍流量；
- 单位页不为声音计数读取完整声音目录；本地版首屏卡片和后台预取使用独立优先级与有界并发，切换分类时新前台请求可越过旧后台队列；
- 简体、繁体目录分离，模型、声音和详情完全按需；
- 完整数据存放在固定 GitHub 数据 Release，高频数据存放在固定 npm 版本；普通代码发布不产生重复的大文件历史。
