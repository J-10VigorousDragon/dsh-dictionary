# dsh-dictionary · DSH 英汉词典

DeepSeek Harness 桌面端插件：**离线 StarDict 英汉查词 + 划词查询 + 单词收藏记录本**。

在左侧边栏点开「英汉词典」面板即可查词；在页面里划选英文单词会浮出释义卡片，点一下「收藏」就进单词本。

- 零网络、零 API Key：词库与音标表全部离线
- **美音 / 英音双音标**（来自 ipa-dict，MIT）
- 查词热态 0.3~0.8ms，启动建索引 < 0.4s（朗道 43.5 万词条 / ECDICT 340 万词条）
- 划词浮层可查词、朗读、直接收藏，并跳到词典面板
- 单词本落盘为 JSON，原子写入，重启不丢；支持 CSV / Markdown 导出

## 界面

| 查词（美/英双音标） | 划词浮层（可直接收藏） | 单词本（表格） |
| --- | --- | --- |
| ![查词](<./docs/shots/search.png>) | ![划词](<./docs/shots/selection.png>) | ![单词本](<./docs/shots/wordbook.png>) |

## 功能

| 能力 | 说明 |
| --- | --- |
| 查词 | 输入英文单词回车查询；大小写不敏感，支持词形回退（glasses → glass） |
| 划词查询 | 在 DSH 页面任意位置选中英文单词（双击或拖选），浮层显示音标、前三条释义、朗读与收藏；可在面板右上角开关 |
| 候选补全 | 输入时给出前缀候选，↑↓ 选择、Enter 确认、Esc 关闭 |
| 双音标 | 每个词条同时显示 **美** / **英** 音标；缺数据时回退到词典自带音标 |
| 发音 | 词条与划词浮层的喇叭按钮调用系统 TTS 朗读美音（无需联网） |
| 收藏 | 查词页与划词浮层都能一键「收藏 / 已收藏」 |
| 单词本 | 表格式列表：单词 / 音标 / 基本意思 / 添加时间，支持筛选、单击回查、悬停删除、二次确认清空 |
| 导出 | 导出 CSV（Excel 可直接打开）或 Markdown 表格到 `~/Documents/dsh-dictionary-export/`，可一键复制路径 |

## 安装

1. 准备词库（见下一节）。
2. 在 DSH 里安装本包（本地目录安装即可）：

```bash
dsh plugin --profile desktop add "D:\path\to\dsh-dictionary"
```

或用插件管理器的「从本地目录安装」。

3. 重启 DSH 桌面端，左侧边栏出现「英汉词典」图标。

## 词库准备

插件不自带词典正文（词典数据版权归各自权利人），需要你本机已有 StarDict 格式词典。默认会在这些位置**自动探测**（子目录里同时有 `.ifo` + `.idx` 即视为词典）：

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

## 双音标数据

美音 / 英音来自 [open-dict-data/ipa-dict](https://github.com/open-dict-data/ipa-dict)（**MIT 许可**），构建产物 `data/phonetics.json.gz`（约 1.2 MB，147,488 个词条）已随仓库提供，开箱即用。

- 数据格式：`{ "word": ["<美音>", "<英音>"] }`，音标已去掉外层 `/`
- 同一词有多种读音时用 `, ` 连接（如 `schedule`：美 `ˈskɛdʒuɫ, ˈskɛdʒʊɫ` / 英 `ʃˈɛdjuːl`）
- 重新生成：`node scripts/build-phonetics.mjs`（从 GitHub 拉取 en_US / en_UK 后重新打包）

## 架构

```
src/index.js            Host：自动探测词库、/dict-rpc 路由、单词本与双音标对外接口
src/host/stardict.js    StarDict 读取器：ifo/idx/dict 解析、Uint32Array 索引、字节级二分、.cache 缓存
src/host/dict.js        DictionaryHub：多词典优先级、释义解析、屈折回退、前缀补全
src/host/phonetics.js   双音标表：gzip JSON + 并行数组 + Map 索引
src/host/wordbook.js    单词本：原子写、去重、5000 条上限、坏文件自愈
src/client/index.js     Client：侧边栏图标 + 主面板双 Tab + shell.overlay 划词浮层
```

数据流：页面里的 Client 通过同源 `POST /dict-rpc` 调 Host，Host 统一分发 `status / lookup / suggest / wordbook.* / wordbook.export`。词库索引缓存在仓库根的 `.cache/`（已 gitignore）。

划词浮层注册在 `shell.overlay` 槽位（框架级浮动层，本身点击穿透），监听页面内的文本选中事件，浮层卡片自行开启指针事件；关闭划词不会卸载槽位，只是不再响应选中。

## 开发

```bash
node test/engine.mjs      # 引擎回归（需要本机两本词库）
node test/phonetics.mjs   # 双音标表回归
node test/rpc.mjs         # Host RPC 端到端（用假 ctx 起真实 HTTP，不需要 DSH）
node --check src/index.js && node --check src/client/index.js
```

## 许可

代码 MIT；双音标数据来自 MIT 许可的 ipa-dict。词库文件不在本仓库内，请自行准备并遵守对应词库的许可。

## 已知限制

- 一次只加载词典目录里的第一个 `.ifo`
- 大小写折叠仅 ASCII
- 屈折回退是启发式，不推导不规则变化（但主流词库基本直接收录 went / mice / children）
- 冷启动首次建索引约 0.3s（同步 CPU），已用 `.cache` 缓存规避重复建索引
- 划词只对英文字符串生效（≤40 字符、1~3 个单词），选中中文不触发
- 双音标表只覆盖 ipa-dict 收录的 14.7 万常用词，生僻词回退为词典自带单音标
