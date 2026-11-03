# 词典引擎实现说明（engine-notes）

> 适用版本：dsh-dictionary 0.1.0 · 引擎文件：`src/host/stardict.js`、`src/host/dict.js`、`src/host/phonetics.js`、`src/host/wordbook.js`
> 测试入口：`node test/engine.mjs`（115 项断言）· `node test/phonetics.mjs`（41 项断言）—— 均全绿
> 环境：Windows 10/11 · Node v24.15.0 · 零依赖（仅 `node:` 内置模块）
> 数据源：本机 StarDict 词库（朗道 5.0 / ECDICT 增强版）+ ipa-dict 双音标表（MIT）

---

## 1. 已实现内容

### 1.1 文件划分

| 文件 | 职责 | 对外导出 |
| --- | --- | --- |
| `src/host/stardict.js` | StarDict 2.4.2 读取器：ifo 解析、idx 索引、正文读取、索引缓存 | `StardictBook`、`parseIfo`、`asciiLower`、`cacheDir` |
| `src/host/dict.js` | 多词典门面：优先级、词形回退、前缀补全、释义解析 | `DictionaryHub`、`parseEntryBody`、`inflectionCandidates` |
| `src/host/phonetics.js` | 美音/英音双音标表：gzip JSON 加载、快速扫描建索引 | `loadPhonetics`、`makePhoneticIndex`、`PhoneticIndex` |
| `src/host/wordbook.js` | 单词本持久化：JSON 原子写入、去重、上限淘汰、坏文件自愈、双音标字段 | `Wordbook` |
| `scripts/build-phonetics.mjs` | 构建 `data/phonetics.json.gz`（下载/缓存 ipa-dict、合并、gzip 9、自检） | CLI |

### 1.2 StarDict 读取实现要点

- **索引**：单次遍历 idx，产出 `Uint32Array` 记录起始位表（每条记录 = UTF-8 词条 + `\0` + 4B 大端 offset + 4B 大端 size）。朗道 435,468 条 ≈ 1.7MB、ECDICT 3,402,564 条 ≈ 13.6MB，常驻内存。
- **不常驻大文件**：idx 原文（ECDICT 82MB）与 dict 原文（112MB）**都不进内存**，只用文件描述符按需 `readSync`。二分查找时每条记录只读 `352B` 头部（足以拿到词条 + 尾部 offset/size）。
- **二分查找直接比较原始字节**：只对 ASCII 折叠大小写（`g_ascii_strcasecmp` 语义），不为每条记录创建字符串。实测两本 idx 均为 ASCII 大小写不敏感升序，**0 处逆序**（全量校验）。
- **`.dict.dz`**：GNU dictzip 就是带 FEXTRA 的 gzip，`node:zlib.gunzipSync` 整块解压（朗道 14.2MB）常驻 Buffer；无 `.dict.dz` 时走 fd 读取。
- **索引缓存**：写入仓库根 `.cache/idx-<hash>.starts`，hash 由「idx 绝对路径 + 大小 + mtime + 缓存格式版本」算出；头部校验不通过（文件被换、格式升级）自动重建。缓存只是加速，删除后自动重生成。
- **永不抛异常**：`StardictBook.open()` 失败也返回实例，用 `info.ok / info.error` 表达（坏路径、缺 .idx、缺正文、空索引）。
- **无 worker_threads**，模块顶层只做常量定义，不做任何 IO。

### 1.3 DictionaryHub 行为

1. `constructor({ paths, order })` → `init()` 顺序打开各目录（单个失败不影响其他）。
2. `order` 按词典 `bookname` 匹配（精确、包含、被包含，均忽略 ASCII 大小写）决定优先级，未列出的词典按 `paths` 顺序排在后面；`status` 与 `entries` 都按该优先级排列。
3. `lookup(rawQuery)` 回退链：
   精确（ASCII 大小写不敏感）→ 去屈折后缀（`s` / `es` / `ies` / `ed` / `ing` / `'s`，含 `ies→y`、`ied→y`、双写辅音还原 `stopped→stop`、`ing→e` 还原）→ 前缀补全（仅此时填 `suggestions`，`entries` 为空）。
4. 同一层次的命中会**跨词典全量收集**（不是只取第一个），然后按优先级排序；因此「首本未命中就顺延下一本」与「多本命中按优先级排列」两条契约同时成立。
5. 词形回退只在某一层完全无命中时才进入下一层，避免「精确有个生僻词条、却返回原形释义」的错误。

### 1.4 释义解析（`parseEntryBody`）

| 输入形态 | 处理 |
| --- | --- |
| 首行 `*['æpl]   -K3` | 方括号内进 `phonetic`（`'æpl`），`-K3` 之类标记丢弃 |
| 首行 `[网络] 游戏；一个游戏` | 含 CJK ⇒ 不当作音标，整行进 `text` |
| `n. 苹果, 家伙` | `pos = "n."`，`text = "苹果, 家伙"` |
| `vt.` `adj.` `interj.` `prep.` … | 同上，多个词性缩写连写也支持（白名单校验） |
| `[医] 苹果` `【计】 递归; 循环` `[网络]` `[地名]` | 原样保留在 `text`，`pos` 为空 |
| `[时态] ran, run, running, runs` | 收进 `exchange`（另有 `[原型]` `[级别]` `[词形变化]` 等） |
| `(中高 2695/2446)` `(35981/-)` | ECDICT 词频元数据，丢弃 |
| `相关词组:` 及其缩进短语 | 按「其余进 text」保留为普通释义行 |

`tags` 恒为 `[]`（两本词库正文没有可靠的标签字段）；`exchange` 缺结构时为 `[]`。

### 1.5 Wordbook

- `list()` 最新收藏在前；`add()` 大小写不敏感去重，重复时更新 `brief`（以及非空传入的 `phonetic` / `phoneticUs` / `phoneticGb` / `dictName`），**保持原位置与 `addedAt`**。
- 双音标字段：`phoneticUs`、`phoneticGb`（string，可空），与既有 `phonetic`（词典自带单音标）并存；旧文件缺这两字段时按空串读入，升级后首次重新收藏即可补齐。
- 上限 5000，超限从尾部淘汰最旧。
- 写入原子：先写 `<file>.tmp` 再 `rename`（Windows 上 `EPERM/EACCES/EBUSY` 重试一次）；`add/remove/clear` 通过 Promise 队列串行，避免并发覆盖。
- 文件缺失 ⇒ 空表（不创建文件）；JSON 损坏 ⇒ 备份为 `<file>.corrupt-<时间戳>.bak` 后回退空表，**不抛异常**；重复词条载入时保留更靠前（更新）的一条。

---

## 2. 双音标（`phonetics.js`）

### 2.1 数据源与许可

| 项 | 值 |
| --- | --- |
| 仓库 | [open-dict-data/ipa-dict](https://github.com/open-dict-data/ipa-dict)（**MIT**） |
| 美音 | `data/en_US.txt` — 125,927 行 |
| 英音 | `data/en_UK.txt` — 65,119 行（注意是 `en_UK`，`en_GB` 会 404） |
| 原始格式 | 每行 `word\t/ipa/`，同一词可带多个 `/ipa/`（英文美音源 8,419 行如此） |

### 2.2 产物与格式

`data/phonetics.json.gz`（**1.21 MB**，gzip level 9；原始 JSON 5.11 MB）：

```json
{ "schedule": ["ˈskɛdʒuɫ, ˈskɛdʒʊɫ", "ʃˈɛdjuːl"], "read": ["ˈɹɛd, ˈɹid", ""] }
```

- 键：ASCII 小写折叠后的词形（查表大小写不敏感）；键按字母序排序；
- 值：`[美音, 英音]`，缺数据的一侧为 `""`；
- 音标**去掉外层 `/`**（与引擎 `phonetic` 字段风格一致）；同词多读音用 `, ` 连接。
- 合并口径：147,488 个唯一词形 = 双音标 43,558 + 仅美音 82,369 + 仅英音 21,561。

### 2.3 构建脚本

`node scripts/build-phonetics.mjs`：

1. 源文件查找顺序：`<repo>/.cache/ipa/`（优先）→ `/tmp/ipa-*.txt`（若有效）→ `curl -k` 下载；用 `fetch` 兜底；
2. 有效性校验（字节数 ≥ 500KB + 前 2000 行中 ≥100 行符合 `word\t…/…`），防止把 404 页面当数据；
3. 合并两份为 `{ word: [us, gb] }` → `JSON.stringify` → `gzipSync(level 9)` → 原子写（`.tmp` + `rename`）；
4. 幂等：键排序 + 不写时间戳 ⇒ 重复执行产物 **SHA-256 一致**（实测 `5ea7f713…d38d89`）；
5. 自检：构建末尾用 `loadPhonetics()` 回读产物并核对条目数，不一致直接失败。

可调环境变量：`IPA_CACHE_DIR`（源缓存目录）、`IPA_SKIP_TMP=1`（禁用 /tmp 回退）。

### 2.4 加载实现（为什么不用 `JSON.parse`）

147,488 个唯一键的对象在 V8 里会落到 dictionary mode：`JSON.parse` 建对象 + 逐键取值实测 **320–500ms**，超出 300ms 预算。因此 `loadPhonetics()` 先用**字符串扫描器**直接解析 `{"word":["us","gb"]}` 结构，边扫边建 `Map` + 两条并行字符串数组，不产生中间 JSON 对象：

- 快路径条件：解压文本中不含反斜杠（本构建产物无转义字符）；
- 任何结构不符/带转义 ⇒ 自动回退到 `JSON.parse` + `makePhoneticIndex()`（正确性优先）；
- 内存形态：`Map<folded word, idx>` + `us[]` + `gb[]`，不复制字符串，不常驻原始 JSON；
- `makePhoneticIndex(records)` 是纯函数（无 IO），支持 `{word:[us,gb]}` / `Map` / `[word,[us,gb]]` 数组三种输入，供测试注入。

### 2.5 实测性能与内存（全新进程，多次采样）

| 指标 | 实测 | 契约 |
| --- | --- | --- |
| 解压 + 建索引 | **165–224 ms**（典型 190ms） | < 300ms |
| heap 增量 | **19–27 MB** | < 60MB |
| 条目数 | 147,488 | > 100,000 |
| `get()` 10 万次 | 28–61 ms（≈0.3–0.6 µs/次） | — |
| 构建脚本总耗时 | 2.1–2.3 s（gzip level 9 占 1.8s） | — |

实测样例：`schedule` 美 `/ˈskɛdʒuɫ, ˈskɛdʒʊɫ/` · 英 `/ʃˈɛdjuːl/`；`tomato` 美 `/təˈmɑˌtoʊ, təˈmeɪˌtoʊ/` · 英 `/təmˈɑːtəʊ/`；`apple` 美 `/ˈæpəɫ/` · 英 `/ˈæpəl/`（两侧差一个符号，属数据源事实）。

---

## 3. 实测性能（StarDict 引擎）

测试机：本机 Windows（Ryzen/Intel 桌面 CPU）、Node v24.15.0、词库在 `C:\Users\李晨曦\Documents\Readest词典`。

### 3.1 建索引（`StardictBook.open`）

| 词库 | 词条数 | 冷启（无缓存） | 热启（命中缓存） | 缓存文件 |
| --- | --- | --- | --- | --- |
| 朗道英汉 5.0 | 435,468 | **110 – 124 ms** | **约 60 – 145 ms** | `idx-80cdf7…starts` 1.7MB |
| ECDICT 简明增强版 | 3,402,564 | **311 – 342 ms** | **9.5 – 29 ms** | `idx-1911ac…starts` 13.0MB |

- 冷启包含 idx 全量扫描（朗道 39ms / ECDICT 262ms 纯扫描）+ 写缓存（13MB）。
- 朗道热启的时间几乎全花在 `.dict.dz` gunzip（压缩 5.0MB → 14.2MB），对 OS 文件缓存与机器负载敏感，多次实测落在 57–144ms；ECDICT 无解压，热启 9.5–29ms。
- `DictionaryHub.init()`（两本词库）热启 **约 67 – 175 ms**，冷启约 **370 ms**（几乎等于两本词典冷启之和）。
- 契约要求「朗道 < 3s、ECDICT 首次 < 10s」：分别富余 20× / 30×。

### 3.2 查词（`DictionaryHub.lookup`，两本词库同时开）

| 指标 | 实测 |
| --- | --- |
| 热态单次（5 词 × 5 次，中位数） | **0.29 – 0.79 ms**（契约要求 < 10ms） |
| 1000 次连续查词（25 个不同词循环） | **359 ms，均值 0.359 ms** |
| 首次查词（含首次读盘/解压后预热） | 0.4 – 2.1 ms |
| 前缀补全 `suggest()` | 约 **0.9 ms/次**（200 次 183ms，含两本词典与去重排序） |

### 3.3 内存

| 阶段 | RSS |
| --- | --- |
| Node 基线 | 62.2 MB |
| 两本词库 init 后（含瞬时 Buffer） | 98 – 125 MB |
| 稳态（GC 后） | **约 98 MB**，即引擎净增 ≈ **36 MB** |

净增构成：ECDICT starts 13.6MB + 朗道 starts 1.7MB + 朗道解压正文 14.2MB + 少量；ECDICT 的 82MB idx 与 112MB dict **不在内存**。

---

## 4. 与 API 契约的偏差 / 增量

契约方法全部按签名实现，**无破坏性偏差**。以下为需要知晓的细节与增量 API：

1. **`phonetic` 存不带外层方括号的音标**：`['æpl]` → `'æpl`；`[,serәn'dipiti]` → `,serәn'dipiti`。若 UI 想显示方括号请自行包裹。
2. **`StardictBook.lookup()` 只做精确匹配**（不做屈折回退）——回退在 `DictionaryHub.lookup()` 内完成，与契约分层一致。
3. `StardictBook.lookup()` 虽声明 `async`，内部是同步 IO（`readSync`），无真正 `await` 点；返回 Promise 仅为满足签名。
4. **`tags` 恒为 `[]`**；`exchange` 目前只从 `[时态]/[原型]/[级别]/[词形变化]` 等结构行收集，值形如 `["ran, run, running, runs"]`（不含标签前缀）。
5. `Wordbook.add()` 重复词的处理是契约的超集：`brief` + 非空的 `phonetic`/`dictName` 一起更新，`addedAt` 与位置不变；传入空串表示「保留旧值」。
6. `Wordbook.add()` 返回保存后的条目对象；`word` 为空时抛 `TypeError`（契约未规定，宿主已有兜底校验）。
7. `Wordbook.load()` **不创建文件**，首次写操作才落盘。
8. `DictionaryHub.status` 的顺序 = 优先级顺序（`order` 生效时不再是 `paths` 顺序）。
9. 同 headword 的多条 idx 记录（同形异义）会返回多条 entry，**不合并**。
10. 增量导出（契约未要求，可安全忽略）：`parseIfo`、`asciiLower`、`cacheDir`、`parseEntryBody`、`inflectionCandidates`、`StardictBook.{lookupSync,suggestSync,buildMs,cacheHit,ready,wordcount,dispose}`、`DictionaryHub.{suggest,diagnostics,dispose,readyCount}`、`Wordbook.filePath`。
11. **`loadPhonetics()` 失败一律抛 `Error`**（不返回 null）：文件缺失 / 非 gzip / 坏 JSON / 空数据各有明确消息（含路径与修复提示）。宿主按「可选增强」处理，用 try/catch 降级为单音标。
12. 双音标值**已去掉外层 `/`**，同词多读音以 `, ` 连接（如 `ˈskædʒuɫ, ˈskædʒʊɫ`）；UI 要显示 `/…/` 请自行包裹。
13. `PhoneticIndex.get()` 每次返回**新的** `{us, gb}` 对象（内部只存两个字符串，不缓存对象），`size` 是唯一词形数（两侧都为空的词不收录）。
14. `makePhoneticIndex(records)` 支持 `{word:[us,gb]}` / `Map` / `[word,[us,gb]]` 数组三种输入，非法输入抛 `TypeError`。

---

## 5. 已知限制

1. **单目录单词库**：一个目录里若有多个 `.ifo`，只取目录列举到的第一个；不支持一个目录挂多本。
2. **不支持 `.idx.gz`**：只处理裸 `.idx`（本机两本词库均满足）。
3. **不处理 `.syn` 同义词文件**（本机词库没有该文件，因此同义词查询不可用）。
4. **`sametypesequence` 只按纯文本 `m` 解析**；若换成含 HTML/音标二进制的词库，正文会出现乱码。
5. **大小写折叠只做 ASCII**：与 StarDict idx 的 `g_ascii_strcasecmp` 排序完全一致；对非 ASCII（如带变音符的欧洲词、土耳其语 `İ`）不做语言级折叠。
6. **屈折回退是启发式**，不是词典级词形还原（lemmatizer）：不规则变化（`went`、`mice`、`oxen`）不做规则推导——不过这两本词库本身就收录了大多数不规则形式，实测 `went`/`mice`/`children` 均直接精确命中。
7. 两本词库收录极全，**常见词的屈折形式几乎都有独立词条**，所以回退链在日常使用中很少触发（回归用例用 `weltschmerzes→weltschmerz`、`laconics→laconic`、`gubbinses→gubbins`、`nerdied→nerdy` 四个实测样例覆盖）。
8. **朗道「相关词组:」段落**会作为普通 text 行保留（如 `run` 有 40+ 条短语行），因此 `definitions` 可能较长；按契约「其余进 text」不做裁剪。
9. **冷启同步 CPU 峰值**约 300ms（ECDICT 首扫描）发生在主线程；虽远低于 10s 契约，宿主仍建议在插件启动后异步预热，避免与 UI 首帧抢 CPU。
10. **索引缓存与平台字节序绑定**（本机原生序写入），仅作本机加速，不可跨机器拷贝；删除 `.cache/` 会自动重建。
11. 单词本每次写**整个 JSON**（5000 条约 0.7MB），不是增量写；单次 `add` 为几 ms 量级，5000 条满载时仍在可接受范围。
12. 单词本并发安全仅限单实例（内部串行队列）；多个进程/实例同时写同一文件不保证一致。
13. 朗道无音标词条（如 `serendipity`、`recursion`）`phonetic` 为空串，属数据源缺失，不做推断。
14. **双音标覆盖率受英音源限制**：`en_UK.txt` 只有 65,119 词，合并后 147,488 个词形中仅 43,558 个有双音标（29.5%），82,369 个只有美音、21,561 个只有英音；缺的一侧为 `""`，宿主 UI 回退到词典自带单音标。
15. **同词多读音只做拼接**，不区分词性与义项（如 `record` 美音把名词/动词读音并列成 `ˈɹɛkɝd, ɹəˈkɔɹd, ɹɪˈkɔɹd`），也未标注主次读音。
16. **大小写折叠只做 ASCII**（与 StarDict / 单词本一致）；单词本双音标字段同样不区分大小写去重。
17. 加载器的字符串快路径只适用于**本构建脚本产物**（无转义字符）；若手工替换成含转义/异形的 JSON，会自动回退 `JSON.parse`（实测慢 2–3 倍但仍正确），不会读错数据。
18. **`data/phonetics.json.gz`（1.21MB）随仓库提交**：`package.json` 的 `files` 必须包含 `data`（已加入），否则 npm 打包会丢数据；构建脚本需要能下载约 4.7MB 源文件（离线时可用 `.cache/ipa/` 或 `/tmp/ipa-*.txt` 预置，脚本会自动复用）。

---

## 6. 回归测试覆盖

两个测试文件各自独立、失败即非零退出码：

| 命令 | 覆盖 | 断言数 |
| --- | --- | --- |
| `node test/engine.mjs` | StarDict 引擎 + 单词本基础行为 | 115 |
| `node test/phonetics.mjs` | 双音标数据 + 单词本双字段 | 41 |
| `node test/rpc.mjs`（Lead 维护） | Host RPC 端到端（含「收藏自动补美音」） | 32 |

### 6.1 `test/engine.mjs` → **115 项断言全绿**，退出码 0。分七段：

| 段 | 内容 |
| --- | --- |
| 0 | 词库定位（`DSH_DICT_LANDAO_DIR` / `DSH_DICT_ECDICT_DIR` 可覆盖，缺失则 SKIP 且退出码 0） |
| 1 | 两本词库建索引：耗时、词条数、ok、缓存写入 `.cache/` |
| 2 | `DictionaryHub.init` 与 `status` 完整性 |
| 3 | `apple` / `serendipity` / `glasses` / `hello` / `recursion` 首次耗时 + 热态 5 次、命中词典名与首条释义、热态中位 < 10ms |
| 4 | 契约细节：跨词典优先级排序、`glasses` 跨词典顺延、精确优先、真实屈折回退、`inflectionCandidates` 单测、`suggest` 有序性、未命中时 `suggestions`、大小写不敏感、条目字段结构、标签行/音标/词频行解析、空查询、坏路径降级 |
| 5 | 合成词库：缓存命中、idx mtime 变化后失效重建、`.dict.dz` 解压、`order` 优先级（两本同词命中排序） |
| 6 | Wordbook：去重/更新/保位置、重载持久化、无 `.tmp` 残留、5000 上限淘汰最旧、坏文件备份自愈、`remove`/`clear` 返回值 |
| 7 | 汇总每本词典的建索引耗时、缓存命中、状态，并 `dispose()` 释放 fd |

测试自带清理：合成词库临时目录与其产生的 `.cache` 条目都会删除，不污染仓库。

### 6.2 `test/phonetics.mjs` → **41 项断言全绿**，退出码 0

| 段 | 内容 |
| --- | --- |
| 0 | 数据文件存在 + gzip 魔数 |
| 1 | `loadPhonetics` 两次加载：条目数 > 100000、两次一致、`< 300ms`、heap 增量 `< 60MB` |
| 2 | 取样词 `schedule` / `tomato` / `either` / `advertisement` 美英都非空且不同；`apple` 两侧都有 |
| 3 | `Apple` / `APPLE` 命中、不存在词返回 `null`、空串/非字符串返回 `null`、`has()`、单侧缺失为空串（`read`） |
| 4 | 错误处理：缺文件（消息含路径与构建提示）、非 gzip、坏 JSON、空数据 |
| 5 | `makePhoneticIndex` 纯函数：对象/Map/数组三种输入、双空不收录、大小写不敏感、非法输入抛 `TypeError` |
| 6 | Wordbook：双音标 add/list/重载、重复 add 更新且空值不覆盖、旧格式补空串、旧条目补写双音标并落盘 |

