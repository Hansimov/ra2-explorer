# 游戏源输入

RA2 Explorer 把用户选择的《红色警戒 2 / 尤里的复仇》安装目录视为只读字节源。它不会调用该目录中的 EXE、DLL、安装器或脚本，也不会把解析结果写回游戏目录。

## 扫描入口

扫描器读取受支持的松散文件，以及 `.mix`、`.mmx`、`.yro` 和其中的嵌套 MIX。典型零售安装的主要根归档包括：

- `ra2.mix`、`language.mix`：原版规则、美术映射、本地化和主体资源；
- `ra2md.mix`、`langmd.mix`：尤里的复仇覆盖与本地化；
- `expand*.mix`、`expandmd*.mix`、`ecache*.mix`、`elocal*.mix`：补丁或 Mod 覆盖；
- `maps*.mix`、`multimd.mix`、`.mmx`、`.yro`：地图与附加内容；
- 音乐、影片和语言归档。

目录不需要具有完全相同的文件清单。扫描器依据实际存在的文件、归档头和条目内容判断，而不是依赖某个本机安装快照；五字节 CD class marker 会作为占位归档记录，不按损坏文件处理。

## 语义配置

以下虚拟文件名真正建立单位、动画、声音和文本关系：

| 用途 | 文件名 |
| --- | --- |
| 基础规则 | `rules.ini` |
| 尤里规则 | `rulesmd.ini` |
| 基础美术映射 | `art.ini` |
| 尤里美术映射 | `artmd.ini` |
| 基础声音事件 | `sound.ini` |
| 尤里声音事件 | `soundmd.ini` |
| 基础 EVA 事件 | `eva.ini` |
| 尤里 EVA 事件 | `evamd.ini` |
| 本地化 | `ra2.csf`、`ra2md.csf` |

覆盖顺序遵循游戏查找关系：松散文件高于归档，编号更高的扩展归档高于编号更低的归档。同一来源存在 `rulesmd.ini` 时，它作为《尤里的复仇》的完整规则集参与解析，不再与 `rules.ini` 做字段级合并；只有缺少 `rulesmd.ini` 时才回退到原版规则。ART、SOUND 和 EVA 配置继续按基础版到 MD 版的顺序合并。最终虚拟路径与优先级会记录在索引中，重新扫描后语义缓存失效。

## 按引用读取的素材

配置合并后，应用再沿 `Image`、`Cameo`、`Sequence`、`Voice*`、`Sound*`、武器、弹体和弹头字段读取：

- VXL、HVA、SHP、PCX、PAL、VPL；
- WAV、AUD、AUDIO.IDX/BAG 片段；
- MAP、MPR、TMP 及各剧场扩展；
- VQA、BIK、FNT、TXT 和其他受支持的辅助数据。

首次导入只建立归档、格式和语义索引，不会把所有条目一次性解压或解码。列表、详情、预览、播放或显式导出真正引用某项时，才读取对应文件或 MIX 区段。

`.runtime\RA2MD-Ext` 中的 SQLite、缩略图、模型场景、转码媒体、文件名库和声音转录都属于派生数据，不是游戏源输入；扫描器会显式排除该目录。

## 核对输入

开发环境可使用以下只读命令确认实际安装：

```bat
.venv\Scripts\ra2exp.exe discover
.venv\Scripts\ra2exp.exe import PATH_TO_GAME --name 本地游戏文件
.venv\Scripts\ra2exp.exe sources
.venv\Scripts\ra2exp.exe verify SOURCE_ID --samples-per-format 20
.venv\Scripts\ra2exp.exe semantic-check SOURCE_ID
```

命令输出中的来源 ID、资产数量和绝对路径属于当前电脑的运行状态，不应复制到公开文档或提交记录。
