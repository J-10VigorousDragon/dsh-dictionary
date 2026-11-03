# 词典引擎实现说明（engine-notes）

> 适用版本：dsh-dictionary 0.1.0 · 引擎文件：`src/host/stardict.js`、`src/host/dict.js`、`src/host/wordbook.js`
> 测试入口：`node test/engine.mjs`（115 项断言，本次全部通过）
> 环境：Windows 10/11 · Node v24.15.0 · 零依赖（仅 `node:` 内置模块）· 沙箱内不联网

---

## 1. 已实现内容

### 1.1 文件划分

| 文件 | 职责 | 对外导出 |
| --- | --- | --- |
| `src/host/stardict.js` | StarDict 2.4.2 读取器：ifo 解析、idx 索引、正文读取、索引缓存 | `StardictBook`、`parseIfo`、`asciiLower`、`cacheDir` |
| `src/host/dict.js` | 多词典门面：优先级、词形回退、前缀补全、释义解析 | `DictionaryHub`、`parseEntryBody`、`inflectionCandidates` |
| `src/host/wordbook.js` | 单词本持久化：JSON 原子写入、去重、上限淘汰、坏文件自愈 | `Wordbook` |

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

- `list()` 最新收藏在前；`add()` 大小写不敏感去重，重复时更新 `brief`（以及非空传入的 `phonetic`/`dictName`），**保持原位置与 `addedAt`**。
- 上限 5000，超限从尾部淘汰最旧。
- 写入原子：先写 `<file>.tmp` 再 `rename`（Windows 上 `EPERM/EACCES/EBUSY` 重试一次）；`add/remove/clear` 通过 Promise 队列串行，避免并发覆盖。
- 文件缺失 ⇒ 空表（不创建文件）；JSON 损坏 ⇒ 备份为 `<file>.corrupt-<时间戳>.bak` 后回退空表，**不抛异常**；重复词条载入时保留更靠前（更新）的一条。

---

## 2. 实测性能

测试机：本机 Windows（Ryzen/Intel 桌面 CPU）、Node v24.15.0、词库在 `C:\Users\李晨曦\Documents\Readest词典`。

### 2.1 建索引（`StardictBook.open`）

| 词库 | 词条数 | 冷启（无缓存） | 热启（命中缓存） | 缓存文件 |
| --- | --- | --- | --- | --- |
| 朗道英汉 5.0 | 435,468 | **110 – 124 ms** | **约 60 – 145 ms** | `idx-80cdf7…starts` 1.7MB |
| ECDICT 简明增强版 | 3,402,564 | **311 – 342 ms** | **9.5 – 29 ms** | `idx-1911ac…starts` 13.0MB |

- 冷启包含 idx 全量扫描（朗道 39ms / ECDICT 262ms 纯扫描）+ 写缓存（13MB）。
- 朗道热启的时间几乎全花在 `.dict.dz` gunzip（压缩 5.0MB → 14.2MB），对 OS 文件缓存与机器负载敏感，多次实测落在 57–144ms；ECDICT 无解压，热启 9.5–29ms。
- `DictionaryHub.init()`（两本词库）热启 **约 67 – 175 ms**，冷启约 **370 ms**（几乎等于两本词典冷启之和）。
- 契约要求「朗道 < 3s、ECDICT 首次 < 10s」：分别富余 20× / 30×。

### 2.2 查词（`DictionaryHub.lookup`，两本词库同时开）

| 指标 | 实测 |
| --- | --- |
| 热态单次（5 词 × 5 次，中位数） | **0.29 – 0.79 ms**（契约要求 < 10ms） |
| 1000 次连续查词（25 个不同词循环） | **359 ms，均值 0.359 ms** |
| 首次查词（含首次读盘/解压后预热） | 0.4 – 2.1 ms |
| 前缀补全 `suggest()` | 约 **0.9 ms/次**（200 次 183ms，含两本词典与去重排序） |

### 2.3 内存

| 阶段 | RSS |
| --- | --- |
| Node 基线 | 62.2 MB |
| 两本词库 init 后（含瞬时 Buffer） | 98 – 125 MB |
| 稳态（GC 后） | **约 98 MB**，即引擎净增 ≈ **36 MB** |

净增构成：ECDICT starts 13.6MB + 朗道 starts 1.7MB + 朗道解压正文 14.2MB + 少量；ECDICT 的 82MB idx 与 112MB dict **不在内存**。

---

## 3. 与 API 契约的偏差 / 增量

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

---

## 4. 已知限制

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

---

## 5. 回归测试覆盖（`test/engine.mjs`）

`node test/engine.mjs` → **115 项断言全绿**，退出码 0。分七段：

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
