# RA2 Explorer 演示视频流水线

这个目录只保存可复用的录制、旁白、合成和验收代码。生成的 WAV、MKV、MP4、截图、运行目录、IndexTTS 权重和音色参考均由 `.gitignore` 排除，不进入 Git 历史，也不参与 RA2 Explorer 的普通构建与 Release。

演示工具只在 `demo-video` 分支维护。该分支定期合并 `master` 的产品更新，但演示代码不会反向进入 `master`，也不会增加普通用户和其他开发者的项目负担。

## 环境

- Windows 10/11、Node.js 18+、Python 3.11；
- Chrome/Chromium 与 Playwright 1.48.2；
- `ffmpeg.exe`、`ffprobe.exe` 可从 `PATH` 调用；
- 需要录制游戏声音时安装 VB-Audio Virtual Cable；
- 需要旁白时另行准备本地 IndexTTS 2.5 项目、模型权重和音色参考 WAV。

所有命令均在 `cmd.exe` 中运行。录制器不会启动游戏 EXE，只操作已运行的 RA2 Explorer 页面。

## 安装与录制

```bat
cd demo
npm ci
npm run audio:verify
npm run record -- http://127.0.0.1:46120/
```

第三个参数可以限定章节，例如只录第 4 章：

```bat
node record-showcase.cjs http://127.0.0.1:46120/ 4
```

录制采用 1920×1080 CSS 视口和 4/3 设备像素比，实际源画面为 2560×1440、16:9、30 fps。章节切换带淡入淡出，说明卡片位于画面中心，进度位于左下角。第 5、6 章把 Chromium 输出定向到 CABLE Input，并从 CABLE Output 单独采集。

## 生成旁白

将音色参考 WAV 放在本地任意被忽略的位置，再使用 IndexTTS 2.5 的 Python 环境执行：

```bat
X:\IndexTTS2\.venv\Scripts\python.exe generate_showcase_narration.py ^
  --manifest showcase-YYYY-MM-DDTHH-MM-SS\recording-manifest.json ^
  --project-dir X:\IndexTTS2 ^
  --model-dir X:\IndexTTS2\checkpoints ^
  --prompt X:\private\BV1Rw411a7AC.wav ^
  --max-new 3
```

脚本以 BF16、低显存模式离线推理，将每段旁白标准化到约 -18 LUFS，并把相对文件名和时长回写到录制清单。8 GiB 显存设备建议使用 `--max-new 3` 分批执行同一命令；已完成的片段会自动复用，并在全部完成后写入重叠审计。模型、提示音频和生成语音都不属于仓库内容。

## 合成与验收

```bat
node render-showcase.cjs showcase-YYYY-MM-DDTHH-MM-SS v0.13.1
node qa-showcase.cjs showcase-YYYY-MM-DDTHH-MM-SS showcase-YYYY-MM-DDTHH-MM-SS\final\RA2-Explorer-Complete-Showcase-v0.13.1.mp4
```

合成器按配置统一收紧演示节奏，输出 H.264 2560×1440、30 fps 和 AAC 48 kHz 双声道，并写入七个章节标记。QA 会检查七章齐全、页面与网络错误、源分辨率、CABLE 路由与延迟、旁白重叠、游戏声音数量、演示节奏、最终编码、章节和总时长，并生成被忽略的 `qa-report.json`。

`assemble-showcase.cjs` 只用于从多次局部录制中选择每章最新的无错误片段；完整录制成功时直接使用原运行目录即可。

## 苏军步兵单位语音全览

专用流水线遍历规则中属于苏军的步兵，纳入选择、出场、移动、攻击、受击、阵亡等事件关联的全部单位声音。警犬吼叫及无台词的阵亡声音也会保留；未使用的规则实体会被排除，多个单位使用完全相同的声音集合时只播放一次。每条声音展示单位图标、与事件相符且通过帧边界检查的主体动作、英文原文，以及标明来源的游戏中文或 RA2 Explorer 译文。

画面为 1080×1920 竖屏：顶部横向呈现上一个、当前和下一个单位，中间播放单位动作，下方居中显示英文与中文，底部为总进度。画面使用无卡片边框的沉浸式布局；仅片头显示项目来源、主标题和精简版地址，主体画面不显示阵营、版本、时长或统计说明。

先生成并检查清单：

```bat
npm run voices:plan -- http://127.0.0.1:46120/
```

录制前应确认本地服务已经完成实际游戏资源索引，并验证 CABLE 路由。完整录制会先生成所需预览帧，再将本段音频载入浏览器内存，以避免首次播放停顿：

```bat
npm run audio:verify
npm run voices:record -- http://127.0.0.1:46120/ infantry
```

`all` 作为兼容参数同样只录本期的步兵内容。开发时可追加 `--smoke`，仅取前两个单位的第一条声音，以同时检查轮播的相邻项：

```bat
npm run voices:record -- http://127.0.0.1:46120/ infantry --smoke
```

录制完成后，命令会输出运行目录。使用该目录名完成合成与验收：

```bat
npm run voices:render -- soviet-voices-YYYY-MM-DDTHH-MM-SS v0.13.1
npm run voices:qa -- soviet-voices-YYYY-MM-DDTHH-MM-SS
```

合成器输出带逐单位章节的步兵版视频，编码为 H.264 1080×1920、30 fps 和 AAC 48 kHz 双声道。验收覆盖声音清单完整性、页面与网络错误、CABLE 路由和时延、源分辨率、帧时钟、中英文文本、最终编码及章节数量。
