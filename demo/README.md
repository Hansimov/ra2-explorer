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
node render-showcase.cjs showcase-YYYY-MM-DDTHH-MM-SS v0.15.0
node qa-showcase.cjs showcase-YYYY-MM-DDTHH-MM-SS showcase-YYYY-MM-DDTHH-MM-SS\final\RA2-Explorer-Complete-Showcase-v0.15.0.mp4
```

合成器按配置统一收紧演示节奏，输出 H.264 2560×1440、30 fps 和 AAC 48 kHz 双声道，并写入七个章节标记。QA 会检查七章齐全、页面与网络错误、源分辨率、CABLE 路由与延迟、旁白重叠、游戏声音数量、演示节奏、最终编码、章节和总时长，并生成被忽略的 `qa-report.json`。

`assemble-showcase.cjs` 只用于从多次局部录制中选择每章最新的无错误片段；完整录制成功时直接使用原运行目录即可。

## 阵营步兵单位语音全览

专用流水线通过 `soviet` 和 `allied` 配置分别遍历苏军、盟军步兵，纳入选中、出场、移动、攻击、开火、受击、阵亡及阵营专属事件关联的全部单位声音。警犬吼叫及无台词的阵亡声音也会保留；未使用的规则实体会被排除，多个单位使用完全相同的声音集合时只播放一次。每条声音展示单位图标、与事件相符且通过帧边界检查的主体动作、游戏文件中的英文原文，以及游戏中文或 RA2 Explorer 译文。普通武器声音排在精英变体之前，译文句末标点跟随原文；无文本音效统一保留 `<…>` 标记，录制器不会使用 ASR 改写单位语音原文。

录制器先按声音事件和逐条语义划分动作段，再根据每段语音数量预计算需要的主体动作。规则事件决定动作大类，稳定的声音素材 ID 和原文语义进一步约束细分动作，例如急行台词使用行走、明确的欢呼使用欢呼、掩体部署使用部署过程、部署武器声使用部署开火、涉水台词使用游泳动作。地面步兵受击优先使用匍匐；素材没有匍匐时才回退到游戏动作表中的受击序列，飞行单位保持飞行状态。工程师分析图纸、研究蓝图、持有设计图和拆弹时固定使用第二待机动作。相邻语音优先连续播放同一个兼容循环，动作段中途不会回到首帧；只在语义允许时更换动作，以兼顾连续性和覆盖度。两帧的卧倒、起身序列只在姿态发生变化时播放一次，绝不作为独立循环；阵亡、空中坠落和翻滚序列只用于阵亡声音，播放一次后停在尾帧，相邻阵亡声音尽可能交替不同序列。越过主体帧边界的规则序列会在规划阶段排除，浏览器还会对实际渲染帧做变化检测，避免录入静止循环。

画面为 1080×1920 竖屏：顶部横向呈现上一个、当前和下一个单位，中间播放单位动作，下方居中显示英文与中文，底部为总进度。画面使用无卡片边框的沉浸式布局；仅片头显示项目来源、主标题和精简版地址，并从视频第一帧直接出现。事件文字固定在当前单位名称下方 45 px，不会随动作帧移动。人物比例从不含大范围环境特效的稳定主体动作估计，并允许阵营配置对少数视觉体量特殊的单位做校准。所有动作使用固定的站立或低姿态基线；主体画布位于头像、标题与字幕图层上方并向上下延伸，角色的不透明像素可以自然跨区显示，透明部分仍显示其下方内容。

先生成并检查声音清单。审计会阻止缺少原文、译文、对应标点或尖括号标记的内容进入录制：

```bat
npm run voices:plan -- http://127.0.0.1:46120/
npm run voices:audit
npm run allied-voices:plan -- http://127.0.0.1:46120/
npm run allied-voices:audit
```

修改动作规划时，可先运行纯规划和单元测试，不启动浏览器、录屏或音频设备：

```bat
npm run voices:animations:test
node record-soviet-voices.cjs http://127.0.0.1:46120/ infantry --plan-only
node record-soviet-voices.cjs --profile=allied http://127.0.0.1:46120/ infantry --plan-only
npm run voices:animations:inspect -- LUNR SENGINEER
```

`--units=LUNR,SENGINEER` 可把纯规划或样片限定到指定单位，适合在完整录制前检查登月火箭员、工程师等特殊动作。

录制前应确认本地服务已经完成实际游戏资源索引，并验证 CABLE 路由。完整录制会先生成所需预览帧，再将本段音频载入浏览器内存，以避免首次播放停顿：

```bat
npm run audio:verify
npm run voices:record -- http://127.0.0.1:46120/ infantry
npm run allied-voices:record -- http://127.0.0.1:46120/ infantry
```

`all` 作为兼容参数同样只录本期的步兵内容。开发时可追加 `--smoke`：它保留当前配置中的全部单位，并按动作段抽取常规语音以及有代表性的移动、开火、受击和阵亡事件，以较短素材覆盖单位切换、姿态过渡、无文本音效和特殊动作：

```bat
npm run voices:record -- http://127.0.0.1:46120/ infantry --smoke
npm run allied-voices:record -- http://127.0.0.1:46120/ infantry --smoke
```

录制完成后，命令会输出运行目录。使用该目录名完成合成与验收：

```bat
npm run voices:render -- soviet-voices-YYYY-MM-DDTHH-MM-SS v0.15.0
npm run voices:qa -- soviet-voices-YYYY-MM-DDTHH-MM-SS
npm run allied-voices:render -- allied-voices-YYYY-MM-DDTHH-MM-SS v0.15.0
npm run allied-voices:qa -- allied-voices-YYYY-MM-DDTHH-MM-SS
```

合成器输出带逐单位章节的步兵版视频，编码为 H.264 1080×1920、30 fps 和 AAC 48 kHz 双声道。最终 MP4、清单和 QA 报告统一放入 `.runtime\RA2MD-Ext\demo-video\exports`；运行目录只保留录制与合成中间文件，避免成品散落在脚本目录。可以用 `RA2EXP_DEMO_EXPORT_DIR` 覆盖导出位置。

录制逐条等待原始声音自然结束，相邻声音约保留 0.50 秒间隔，单位切换使用完整的淡出、横向滑动和淡入过场；不设置目标总时长，也不通过倍速或裁剪压缩内容。验收覆盖声音清单完整性、动作语义、动作段连续性、阵亡交替、姿态过渡、渲染帧变化、事件文字固定位置、主体与字幕图层、首帧片头、声音间隔、最后一条声音边界、页面与网络错误、CABLE 路由和时延、源分辨率、帧时钟、中英文文本、最终编码及章节数量。
