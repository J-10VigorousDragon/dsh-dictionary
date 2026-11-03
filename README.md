# dsh-dictionary · DSH 英汉词典

DeepSeek Harness 桌面端插件：**离线 StarDict 英汉查词 + 单词收藏记录本**。

在左侧边栏点开「英汉词典」面板即可查词；查到的单词点一下「收藏」就进单词本，单词本里可以筛选、删除、导出。

- 零网络、零 API Key：词库全部来自本机 StarDict 文件
- 查词热态 0.3~0.8ms，启动建索引 < 0.4s（朗道 43.5 万词条 / ECDICT 340 万词条）
- 单词本落盘为 JSON，原子写入，重启不丢
- 导出 CSV（Excel 直接打开）/ Markdown 表格

## 功能

| 能力 | 说明 |
| --- | --- |
| 查词 | 输入英文单词回车查询；支持大小写不敏感、词形回退（glasses → glass、went → go 等） |
| 候选补全 | 输入时给出前缀候选，↑↓ 选择、Enter 确认、Esc 关闭 |
| 音标与发音 | 展示音标；喇叭按钮用系统 TTS 朗读（无需联网） |
| 收藏 | 词条右上角「收藏 / 已收藏」一键切换 |
| 单词本 | 查看收藏列表、按关键词筛选、单击回查、悬停删除、二次确认清空 |
| 导出 | 导出 CSV 或 Markdown 到 `~/Documents/dsh-dictionary-export/`，可一键复制路径 |

## 安装

1. 准备词库（见下一节）。
2. 在 DSH 里安装本包（本地目录安装即可）：

```bash
dsh plugin --profile desktop add "D:\path\to\dsh-dictionary"
```

或用插件管理器的「从本地目录安装」。

3. 重启 DSH 桌面端，左侧边栏出现「英汉词典」图标。

## 词库准备

插件不自带词库（词典数据版权归各自权利人），需要你本机已有 StarDict 格式词典。默认会在这些位置**自动探测**（子目录里同时有 `.ifo` + `.idx` 即视为词典）：

- `~/Documents/Readest词典/`
- `~/Documents/ReadestDictionaries/`
- `~/Documents/Dictionaries/`
- `~/Dictionaries/`

推荐两本：

| 词库 | 词条数 | 说明 |
| --- | --- | --- |
| ECDICT 简明英汉字典增强版 | 3,402,564 | MIT 协议，覆盖最全，含词形变化与专名 |
| 朗道英汉字典 5.0 | 435,468 | 排版干净、常用词查询快 |

也可以手动指定路径，在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: dsh-dictionary
  config:
    dictionaryPaths:
      - 'D:\Dicts\ECDICT'
      - 'D:\Dicts\朗道英汉5.0'
```

配置项：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `dictionaryPaths` | `string[]` | 追加的 StarDict 词典目录，排在自动探测结果之前 |
| `wordbookPath` | `string` | 单词本 JSON 路径，默认 `<profile 同级>/dsh-dictionary/wordbook.json` |

支持的格式：StarDict 2.4.2，`.dict` 与 `.dict.dz`（dictzip）均可，`sametypesequence=m` 纯文本释义。不支持 `.idx.gz`、`.syn`。

## 架构

```
src/index.js          Host：自动探测词库、/dict-rpc 路由、单词本对外接口
src/host/stardict.js   StarDict 读取器：ifo/idx/dict 解析、Uint32Array 索引、字节级二分、.cache 缓存
src/host/dict.js       DictionaryHub：多词典优先级、释义解析、屈折回退、前缀补全
src/host/wordbook.js   单词本：原子写、去重、5000 条上限、坏文件自愈
src/client/index.js    Client：侧边栏图标 + 主面板「查词 / 单词本」两个 Tab
```

数据流：页面里的 Client 通过同源 `POST /dict-rpc` 调 Host，Host 统一分发 `status / lookup / suggest / wordbook.* / wordbook.export`。词库索引缓存在仓库根的 `.cache/`（已 gitignore）。

## 开发

```bash
node test/engine.mjs   # 引擎回归（需要本机两本词库）
node test/rpc.mjs      # Host RPC 端到端（用假 ctx 起真实 HTTP，不需要 DSH）
node --check src/index.js && node --check src/client/index.js
```

## 许可

代码 MIT。词库文件不在本仓库内，请自行准备并遵守对应词库的许可。

## 已知限制

- 一次只加载词典目录里的第一个 `.ifo`
- 大小写折叠仅 ASCII
- 屈折回退是启发式，不推导不规则变化（但主流词库基本直接收录 went / mice / children）
- 冷启动首次建索引约 0.3s（同步 CPU），已用 `.cache` 缓存规避重复建索引
