# RA2 Explorer 演示视频流水线

这个目录只保存可复用的录制、旁白、合成和验收代码。生成的 WAV、MKV、MP4、截图、运行目录、IndexTTS 权重和音色参考均由 `.gitignore` 排除，不进入 Git 历史，也不参与 RA2 Explorer 的普通构建与 Release。

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
npm install
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
node render-showcase.cjs showcase-YYYY-MM-DDTHH-MM-SS v0.12.3
node qa-showcase.cjs showcase-YYYY-MM-DDTHH-MM-SS showcase-YYYY-MM-DDTHH-MM-SS\final\RA2-Explorer-Complete-Showcase-v0.12.3.mp4
```

合成器按配置统一收紧演示节奏，输出 H.264 2560×1440、30 fps 和 AAC 48 kHz 双声道，并写入七个章节标记。QA 会检查七章齐全、页面与网络错误、源分辨率、CABLE 路由与延迟、旁白重叠、游戏声音数量、演示节奏、最终编码、章节和总时长，并生成被忽略的 `qa-report.json`。

`assemble-showcase.cjs` 只用于从多次局部录制中选择每章最新的无错误片段；完整录制成功时直接使用原运行目录即可。
