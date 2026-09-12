# Mooncell 技术设计

> 版本：v0.1  
> 状态：讨论稿  
> 对应产品企划：`PRODUCT_PLAN.md` v0.2

## 1. 设计目标

Mooncell 的核心不是“把磁力链接发给下载器”，而是建立一条可恢复、可解释、幂等的自动化流水线：

```text
采集 → 解析 → 识别 → 匹配 → 候选选择 → 下载 → 完成确认 → 整理计划 → 执行 → 验证
```

每一步都必须：

1. 保存输入、输出与决定原因。
2. 失败后可以重试，并且不会重复提交或覆盖文件。
3. 无法可靠判断时进入待确认状态，而不是猜测后继续执行。
4. 与具体 RSS 站点、下载器和元数据服务解耦。

## 2. 从 Auto_Bangumi 吸收的设计经验

参考 [Auto_Bangumi](https://github.com/EstrellaXD/Auto_Bangumi) 当前公开实现与发布记录，Mooncell 应直接吸收这些已经被真实场景验证过的原则：

- 解析和业务准入分离：解析器负责描述标题中包含什么，策略层决定是否足够安全，可以进入自动流程。
- 下载器使用统一协议和能力标记，不能假设 qBittorrent 与 aria2 拥有相同能力。
- 投递失败不能提前持久化成“已处理”，否则下一轮 RSS 无法重试。
- 特殊篇默认归入 `Season 00`；电影使用独立的扁平电影目录。
- 下载器返回的模糊失败不能直接当作“重复”，应尽量通过 infohash 或实时任务确认。
- 重命名必须验证目标结果，并为相同目标路径建立唯一占用。
- 修订版替换必须比普通重命名更保守，默认记录冲突并等待处理。
- SSE 只负责界面增量更新，下载器离线不能拖垮整个事件流。

Mooncell 不照搬 Auto_Bangumi 的内部模型，而采用独立的领域流水线和任务状态。

Mooncell 自己是 RSS、匹配规则和任务状态的唯一事实来源。即使 qBittorrent 提供原生 RSS Rule，核心流程也不依赖它；否则 aria2 无法获得一致行为，规则解释、重试和跨下载器迁移也会失去控制。

## 3. 系统上下文

```text
┌─────────────────────────────────────────────────────────────┐
│ React + shadcn/ui WebUI                                     │
│ 快照查询 REST API + 增量更新 SSE                            │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ FastAPI                                                     │
│                                                             │
│ FeedService ── Parser ── Matcher ── ReleaseSelector          │
│                                  │                          │
│                         DownloadCoordinator                 │
│                                  │                          │
│                         DownloadReconciler                  │
│                                  │                          │
│                         OrganizePlanner                     │
│                                  │                          │
│                         Organizer                           │
│                                                             │
│ Scheduler ── EventBus ── AuditLog ── SQLite                 │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
     RSS Adapter / HTTP              DownloadClient Protocol
                │                             │
   Mikan / DMHY / Nyaa             qBittorrent / aria2
                                              │
                                      下载目录 / 媒体库
```

## 4. 模块边界

### 4.1 FeedAdapter

负责把不同站点的 RSS 表达统一成 `RawFeedItem`，不负责识别番剧。

```python
class FeedAdapter(Protocol):
    async def fetch(self, source: FeedSource) -> FeedFetchResult: ...
    def normalize(self, entry: object) -> RawFeedItem: ...
```

统一输出至少包括：

- `source_id`
- `guid`
- `title`
- `published_at`
- `detail_url`
- `download_url`
- `info_hash`
- `raw_payload`

站点适配器只处理站点差异，例如下载链接位于 `link`、`enclosure` 或自定义字段，不应包含番剧命名规则。

### 4.2 ReleaseParser

负责从发布标题和种子内文件名中提取结构化信息。

解析器输出是事实候选，不直接触发订阅或下载：

```json
{
  "raw_title": "[ANi] Sousou no Frieren - 05 [1080P][Baha][WEB-DL][AAC AVC][CHT]",
  "titles": {
    "primary": "Sousou no Frieren",
    "aliases": []
  },
  "release_group": "ANi",
  "media_type": "episode",
  "release_kind": "single",
  "season": 1,
  "episode_start": 5,
  "episode_end": null,
  "revision": 1,
  "resolution": "1080p",
  "source": ["Baha", "WEB-DL"],
  "subtitle_languages": ["zh-Hant"],
  "video_codecs": ["AVC"],
  "audio_codecs": ["AAC"],
  "container": null,
  "confidence": 0.97,
  "evidence": ["group_brackets", "episode_separator", "resolution_tag"],
  "warnings": []
}
```

建议使用两个正交枚举：

```text
MediaType:
  EPISODE | MOVIE | OVA | OAD | SPECIAL | PV | OPENING | ENDING | UNKNOWN

ReleaseKind:
  SINGLE | RANGE | BATCH | COLLECTION
```

这样可以区分“这是 OVA”和“这是一个包含多集 OVA 的合集”，避免用一个字段承载两个概念。

### 4.3 AdmissionPolicy

负责判断解析结果能进入哪一条业务路径：

```text
普通单集 + 明确标题/集数        → 可自动匹配
OVA/OAD/Special + 准确编号       → 可自动匹配，Season 00
Movie + 明确标题                → 电影流程
PV/OP/ED                        → 默认拒绝
Range/Batch/Collection          → 下载后逐文件解析
只有标题、没有发布证据          → 待确认或拒绝
结构明确但缺少可用标题          → 待确认
```

建议的默认置信度门槛：

```text
confidence >= 0.90  → 可参与全自动流程
0.70–0.89           → 可以下载，但整理前需要确认
confidence < 0.70   → 不自动下载
```

数值应通过真实标题测试集校准，不能只靠主观设定。

P0 自动处理准入矩阵：

| 情况 | 自动下载 | 自动整理 |
|---|---:|---:|
| 唯一订阅匹配的普通编号单集 | 是 | 是 |
| 小数集，如 `12.5` | 是 | 是，必须保留小数 |
| 明确编号且媒体身份已绑定的 OVA/OAD/Special | 是 | 是，进入 Season 00 |
| 无编号 OVA/OAD/Special | 可选 | 否，进入审核 |
| 单视频且媒体身份明确的剧场版 | 是 | 是 |
| 多视频剧场版 | 可选 | 否，进入审核 |
| Range、Batch、Collection | 可选 | 否，下载后逐文件审核 |
| TV 与 OVA 等混合集合 | 否 | 否 |
| PV、CM、NCOP、NCED | 否 | 否 |
| 多个订阅同时匹配或字段冲突 | 否 | 否 |

“审核收件箱”是 P0 模块：解析成功但未达到下载或整理准入条件的内容，都必须在这里展示证据、警告、文件清单和拟执行计划。

### 4.4 MetadataResolver

负责把发布标题映射到媒体库身份：

- 规范标题
- 首播年份
- TV 或 Movie
- 季度
- TMDB ID 或其他元数据 ID
- Special 的准确集号
- 海报

解析器与元数据解析必须分开：发布标题解析成功，不代表已经知道媒体库应使用的官方季和集数。

推荐顺序：

```text
用户手动绑定
    ↓
已缓存的媒体身份
    ↓
TMDB 精确或高置信匹配
    ↓
Bangumi 等动漫元数据补充
    ↓
保持解析标题，并进入待确认
```

### 4.5 Matcher 与 ReleaseSelector

`Matcher` 判断一个候选属于哪个订阅；`ReleaseSelector` 在同一集的多个发布中选择哪个版本。

两者必须分开，避免把“属于这部番”和“这是最想要的版本”混成一个正则表达式。

硬条件示例：

- 标题或别名必须匹配
- 季度必须匹配
- 必须包含关键词
- 不得包含排除关键词
- 媒体类型必须允许

软偏好示例：

- 首选字幕组
- 首选分辨率
- 首选字幕语言
- 首选来源
- 首选编码

推荐使用分层比较，而不是难以解释的总分：

```text
硬条件过滤
    ↓
字幕组是否精确命中
    ↓
分辨率是否命中
    ↓
字幕语言是否命中
    ↓
来源是否命中
    ↓
修订号
    ↓
发布时间与稳定排序键
```

当设置了发布偏好时，可将同一内容身份的候选暂存一段时间，再选择最佳版本；否则早到的次优版本会立即开始下载，后到的首选版本又造成重复。

### 4.6 DownloadClient

下载器适配层使用统一协议，并公开能力：

```python
@dataclass(frozen=True)
class DownloaderCapabilities:
    can_query: bool
    can_pause: bool
    can_resume: bool
    can_rename: bool
    can_move: bool
    can_tag: bool
    can_set_category: bool
    can_remove: bool

class DownloadClient(Protocol):
    capabilities: DownloaderCapabilities

    async def health(self) -> DownloaderHealth: ...
    async def add(self, request: AddDownloadRequest) -> AddDownloadResult: ...
    async def get_task(self, remote_id: str) -> RemoteDownloadTask | None: ...
    async def list_files(self, remote_id: str) -> list[RemoteFile]: ...
    async def pause(self, remote_id: str) -> None: ...
    async def resume(self, remote_id: str) -> None: ...
    async def rename_file(self, remote_id: str, old: str, new: str) -> None: ...
    async def move(self, remote_id: str, destination: str) -> None: ...
```

适配器差异：

- qBittorrent 使用 hash 作为远程任务 ID，可使用分类、标签、文件重命名和位置移动。
- aria2 使用 GID，缺少的分类、标签或关联信息必须由 Mooncell 数据库补足。
- aria2 的磁力任务可能先产生元数据 GID，再通过 `followedBy` 产生实际下载 GID，适配器必须跟踪最终任务。
- aria2 自动整理依赖 Mooncell 能访问 aria2 报告的文件路径；路径可见性预检失败时只允许下载，不允许自动整理。
- UI 只能展示适配器声明支持的操作，不能让不可用按钮静默失败。

添加任务的统一结果不能使用布尔值：

```text
ADDED
DUPLICATE_CONFIRMED
RETRYABLE_FAILURE
PERMANENT_FAILURE
```

重命名结果至少区分：

```text
RENAMED
ALREADY_APPLIED
DESTINATION_EXISTS
RETRYABLE_FAILURE
```

qBittorrent 适配器需要吸收版本兼容边界：登录成功可能是 `200 Ok` 或 `204`；暂停/恢复端点可能是 `pause/resume` 或 `stop/start`；模糊的 `Fails.` 必须按哈希对账；重命名 API 返回成功后还要轮询文件列表确认；凭据错误不得并发重复登录，以免触发 IP 封禁。

### 4.7 DownloadReconciler

定期把下载器的真实状态同步到 Mooncell，不直接依赖下载器内部状态字符串。

建议统一状态：

```text
PENDING
SUBMITTING
SUBMITTED
DOWNLOADING
PAUSED
COMPLETED
FAILED_RETRYABLE
FAILED_FINAL
MISSING
```

关键规则：

- `add()` 请求使用唯一幂等键。
- 只有明确成功或通过哈希确认已经存在，才能标记 `SUBMITTED`。
- 网络超时属于未知结果，应先去下载器按哈希对账，再决定是否重试。
- 下载器离线时保持最后状态，不能把全部任务标记为 `MISSING`。
- 连续多次成功查询不到单个任务后，才进入 `MISSING`。
- `COMPLETED` 后还需要检查文件列表和大小稳定，再创建整理计划。
- 文件清单至少连续读取两次一致，才能认定适合进入整理阶段。

### 4.8 OrganizePlanner 与 Organizer

`OrganizePlanner` 只生成计划，不接触文件；`Organizer` 执行已经通过校验的计划。

整理计划示例：

```json
{
  "strategy": "downloader_managed",
  "download_job_id": 42,
  "operations": [
    {
      "source": "[ANi] Sousou no Frieren - 05 [1080P].mkv",
      "target_directory": "葬送的芙莉莲 (2023)/Season 01",
      "target_name": "葬送的芙莉莲 S01E05.mkv",
      "media_type": "episode"
    }
  ],
  "warnings": []
}
```

整理状态：

```text
PLANNING
NEEDS_REVIEW
READY
EXECUTING
VERIFYING
COMPLETED
CONFLICT
FAILED_RETRYABLE
FAILED_FINAL
```

整理事务建议：

1. 下载器确认完成。
2. 连续获取两次一致的实际文件列表，逐文件解析。
3. 生成规范目标路径。
4. 在数据库中预约所有规范化目标路径。
5. 检查目标不存在，且没有其他活跃任务占用。
6. 根据策略执行重命名、移动、硬链接或复制。
7. 验证目标存在、大小一致；必要时计算哈希。
8. 提交操作记录，并给下载任务打上已整理标记。
9. 任何一步失败都保留操作日志，进入可重试或冲突状态。

严禁使用“目标存在就覆盖”的实现。

## 5. 路径与存储设计

### 5.1 为什么需要路径映射

qBittorrent 在局域网可访问，不代表 Mooncell 能访问 qBittorrent 下载后的文件。例如：

| 视角 | 路径示例 |
|---|---|
| qBittorrent Windows 主机 | `D:\Downloads\Anime` |
| Mooncell Docker 容器 | `/downloads` |
| 媒体库容器 | `/library/anime` |
| Windows 媒体库宿主机 | `D:\Media\Anime` |

Mooncell 至少需要保存：

```text
downloader_root     下载器 API 看到的根目录
mooncell_root       Mooncell 进程看到的同一目录
library_root        Mooncell 进程看到的媒体库目录
```

只有 API 原地整理模式可以不要求 Mooncell 直接读取下载文件；硬链接或复制模式必须挂载 SMB、NFS 或同一 Docker 卷，并通过路径映射找到源文件。

### 5.2 三种整理策略

#### downloader_managed

通过下载器 API 重命名与移动：

- 优点：不要求 Mooncell 直接访问远程文件；可保持下载器做种关系。
- 限制：依赖下载器的 rename/move 能力；所有目标目录必须对下载器可见。
- 推荐：局域网 qBittorrent 的首选模式。

建议先在临时下载目录完成下载，随后先重命名任务内文件，再将任务移动到最终媒体库目录。移动失败时，干净名称仍留在临时目录，可安全重试。

#### hardlink

保留下载目录原文件，在媒体库创建硬链接：

- 优点：继续做种，不占用第二份文件空间，媒体库名称独立。
- 限制：源目录与目标目录必须位于同一文件系统；Mooncell 必须看到两边路径。
- 推荐：下载器与媒体库共享同一块 NAS 存储时使用。

#### copy

复制到媒体库：

- 优点：跨文件系统兼容性最好，下载目录与媒体库完全隔离。
- 限制：占用双倍空间，复制大文件耗时，需要校验和失败恢复。

P0 不自动删除复制后的源文件。

### 5.3 路径安全

- 路径拼接只接受经过清洗的单个路径片段。
- 禁止 `..`、绝对路径注入和越过配置根目录。
- 清理 Windows 保留字符 `< > : " / \ | ? *`、控制字符、结尾点与空格。
- 保留原始标题用于展示，但绝不直接把原始标题作为未经处理的路径。
- 比较目标占用时统一大小写、分隔符和 Unicode 规范化。
- 对 Windows 保留设备名，如 `CON`、`PRN`、`AUX`、`NUL`，追加安全后缀。

## 6. 媒体库命名策略

### 6.1 普通剧集

```text
{library_root}/
└── {canonical_title} ({year})/
    └── Season {season:02d}/
        ├── {canonical_title} S{season:02d}E{episode:02d}.mkv
        └── {canonical_title} S{season:02d}E{episode:02d}.zh-Hans.ass
```

### 6.2 多集文件

```text
{canonical_title} S01E01-E02.mkv
```

多集种子不等于多集文件。必须读取实际文件列表，为每个媒体文件单独解析；不能仅凭种子标题给所有文件生成同一个目标名。

### 6.3 OVA、OAD 与 Special

```text
{canonical_title} ({year})/
└── Season 00/
    └── {canonical_title} S00E01.mkv
```

`Season 00` 是目录约定，但 `E01` 必须尽量来自媒体元数据。发布名中的 `OVA 1` 不一定等于 TMDB 或媒体服务器中的 `S00E01`。如果没有可靠映射，平衡模式应允许下载，但整理前进入 `NEEDS_REVIEW`。

### 6.4 剧场版

```text
{movie_library_root}/
└── {canonical_title} ({year})/
    └── {canonical_title} ({year}).mkv
```

多文件电影种子中，可以将体积最大的媒体文件作为主影片建议，但 P0 不自动确认这一启发式结果。计划进入审核收件箱；其他媒体文件不得生成相同目标名，应进入 Extras 或使用不冲突的附加名称。

### 6.5 小数集与修订版

- `12.5` 保留为 `E12.5`，不能向下取整覆盖 `E12`。
- `06v2` 的内容身份仍是第 6 集，修订号是 2。
- 修订号不是季度或集数的一部分。
- 默认不自动覆盖已经整理的 V1。

## 7. 数据模型

### 7.1 主要实体

| 实体 | 作用 | 关键字段 |
|---|---|---|
| `FeedSource` | RSS 源 | 类型、URL 密文/脱敏值、刷新周期、ETag、状态 |
| `FeedItem` | 原始 RSS 条目 | source、guid、标题、链接、发布时间、fingerprint |
| `ReleaseCandidate` | 结构化解析结果 | parser_version、媒体类型、季集、发布属性、置信度、trace |
| `Series` | 媒体库中的番剧身份 | 规范标题、年份、元数据 ID、海报 |
| `SeriesAlias` | 标题别名 | series_id、别名、语言、来源 |
| `Subscription` | 追番规则 | series_id、季度、状态、偏移、自动下载 |
| `ReleaseProfile` | 发布偏好 | 字幕组、分辨率、字幕、来源、等待窗口 |
| `DownloadClientConfig` | 下载器配置 | 类型、地址、加密凭据、路径映射、能力快照 |
| `DownloadJob` | 下载任务 | 幂等键、remote_id、content_key、状态、重试信息 |
| `DownloadFile` | 实际下载文件 | remote_path、size、selected、解析结果 |
| `OrganizeJob` | 整理批次 | strategy、状态、计划、警告、重试信息 |
| `OrganizeOperation` | 单文件操作 | source、target、动作、状态、校验结果 |
| `ReviewItem` | 人工审核事项 | 原因、证据快照、建议计划、处理结果 |
| `JobRun` | 周期任务运行 | 类型、开始/结束时间、租约、结果、correlation_id |
| `DomainEvent` | SSE 与审计事件 | event_id、类型、资源、时间、correlation_id、payload |

### 7.2 唯一性与幂等约束

```text
FeedItem:          UNIQUE(source_id, fingerprint)
ReleaseCandidate: UNIQUE(feed_item_id, parser_version)
DownloadJob:      UNIQUE(download_client_id, idempotency_key)
Remote task:      UNIQUE(download_client_id, remote_id)
Selected content: 同一 subscription_id + content_key 最多一个已选择版本
Organize target:  同一 library_root + normalized_target 最多一个活跃操作
```

内容身份建议：

```text
普通/特殊单集：series_id : media_type : season : episode_start : episode_end
电影：          movie_metadata_provider : movie_metadata_id
```

字幕组、分辨率和修订号属于发布版本，不属于内容身份。

可另行建立 `release_identity = content_key + revision + group + resolution`，用于比较和审计同一内容的多个发布版本；不要把它与内容身份混用。

## 8. 三组独立状态机

不要用一个超长 `status` 字段同时表达 RSS、下载和整理状态。

### 8.1 条目状态

```text
DISCOVERED
  ├── PARSED ── MATCHED ── CANDIDATE ── SELECTED
  │                  └── UNMATCHED
  ├── NEEDS_REVIEW
  └── REJECTED
```

### 8.2 下载状态

```text
PENDING → SUBMITTING → SUBMITTED → DOWNLOADING → COMPLETED
              │             │            │
              └──── FAILED_RETRYABLE ────┘
                            │
                       FAILED_FINAL

SUBMITTED / DOWNLOADING ── PAUSED
SUBMITTED / DOWNLOADING ── MISSING（需多次对账确认）
```

### 8.3 整理状态

```text
PLANNING
  ├── NEEDS_REVIEW
  └── READY → EXECUTING → VERIFYING → COMPLETED
                 ├── CONFLICT
                 └── FAILED_RETRYABLE → FAILED_FINAL
```

UI 可以投影出一个简化总状态，但数据库仍保留三组真实状态。

## 9. RSS 到媒体库的完整流程

1. 调度器读取已启用 RSS 源。
2. 按主机分组；不同主机可并发，同一主机串行并限速。
3. 使用 ETag/Last-Modified 拉取 RSS。
4. 适配器产生标准 `RawFeedItem`。
5. 计算入口 fingerprint，数据库去重。
6. 确定性解析器产生 `ReleaseCandidate` 与解析轨迹。
7. 准入策略拒绝 PV/OP/ED，标记不确定内容。
8. 匹配已有订阅；新番可生成待确认订阅建议。
9. 对同一 `content_key` 聚合发布候选。
10. 等待窗口结束后按发布偏好选出一个版本。
11. 计算 infohash 和下载幂等键。
12. 提交下载器；未知结果先对账再重试。
13. 下载同步器更新状态和文件列表。
14. 下载完成且文件稳定后生成整理计划。
15. 元数据、季集或路径不确定时进入人工确认。
16. 预约所有目标路径并执行整理。
17. 验证结果，写入审计记录。
18. 通过 SSE 推送状态变化，首页与任务页同步更新。

## 10. 修订版冲突策略

默认策略：`hold`。

发现 V2/V3 时：

1. 验证新旧任务属于同一个 `series_id`。
2. 验证媒体类型、季、集数、字幕组和分辨率一致。
3. 验证新修订号严格大于旧修订号。
4. 任一身份缺失、多文件合集或多个任务共同占用目标时，进入冲突状态。
5. P0 不删除旧任务与旧文件。

未来可选自动替换应使用可恢复的三阶段事务：

```text
暂存旧文件 → 提升新文件到规范路径 → 清理旧任务
```

每一步写入持久化操作日志，重启后可以继续或回滚。

## 11. SSE 事件设计

REST API 提供当前快照，SSE 只推送增量。

建议事件类型：

```text
system.health.changed
feed.refresh.started
feed.refresh.completed
feed.refresh.failed
release.discovered
release.needs_review
release.selected
download.submitted
download.progress
download.completed
download.failed
organize.planned
organize.completed
organize.conflict
organize.failed
log.appended
```

每个事件包含：

```json
{
  "id": 10241,
  "type": "download.completed",
  "occurred_at": "2026-08-28T12:00:00Z",
  "resource_type": "download_job",
  "resource_id": 42,
  "payload": {}
}
```

可靠性要求：

- 客户端通过 `Last-Event-ID` 断点续传。
- 服务端定期发送心跳。
- 慢客户端使用有界队列；溢出后断开并让客户端重新获取快照。
- 下载器健康查询有独立超时，不阻塞事件流。
- 日志事件应做限速和脱敏。

## 12. 初版 REST API 边界

```text
/api/v1/setup/*
/api/v1/health
/api/v1/feeds
/api/v1/feed-items
/api/v1/parser/preview
/api/v1/series
/api/v1/subscriptions
/api/v1/release-profiles
/api/v1/download-clients
/api/v1/download-jobs
/api/v1/organize-jobs
/api/v1/events/stream
/api/v1/logs
/api/v1/settings
```

设计规则：

- REST 返回资源快照，不把日志当作唯一状态来源。
- 所有外部写操作支持幂等键。
- 密码、token、passkey 只接受写入，不在响应中回显。
- 预览接口只生成解析或整理计划，不执行副作用。
- 删除下载任务或文件属于危险操作，P0 不提供自动调用。

## 13. 调度建议

| 任务 | 建议默认值 | 说明 |
|---|---:|---|
| RSS 刷新 | 5 分钟 | 每个源可覆盖 |
| 活跃下载同步 | 5 秒 | 有下载中任务时 |
| 空闲下载同步 | 30 秒 | 没有活跃任务时 |
| 整理队列 | 10 秒 | 只处理 READY 任务 |
| 下载器健康检查 | 60 秒 | 失败后退避 |
| SSE 心跳 | 15 秒 | 保持代理连接 |
| 日志清理 | 每天 | 按保留天数 |

所有周期任务必须具备单实例锁，防止一次任务未完成时下一次再次启动。

## 14. 推荐后端目录

```text
backend/
├── app/
│   ├── api/                 # FastAPI 路由
│   ├── core/                # 配置、安全、日志、事件
│   ├── db/                  # 模型、仓储、迁移
│   ├── domain/              # 领域实体、状态与策略
│   ├── feeds/               # RSS 通用逻辑与站点适配器
│   ├── parsing/             # 标题解析、tokenizer、trace
│   ├── metadata/            # TMDB / Bangumi 适配器
│   ├── matching/            # 订阅匹配与发布选择
│   ├── downloaders/         # Protocol、qBittorrent、aria2
│   ├── organizing/          # 计划、路径、执行、验证
│   ├── scheduler/           # 周期任务
│   └── main.py
└── tests/
    ├── fixtures/releases/   # 真实发布标题测试集
    ├── unit/
    ├── integration/
    └── contract/
```

## 15. 测试策略

### 15.1 解析器夹具

至少覆盖：

- `[ANi] Sousou no Frieren - 05 ...`
- 中文、日文、英文和罗马字标题
- `S02E01` 与绝对集数
- `06v2`、`06v3`
- `12.5`
- `01-12` 合集
- OVA、OAD、SP、Special
- 剧场版、Movie
- PV、NCOP、NCED
- 多字幕组、不同分辨率和语言版本
- 无集数但带完整发布证据的单发资源
- 标题很像发布名但没有任何发布证据的弱输入

每条夹具保存期望结构与准入结果，解析器升级时按版本重新评估。

### 15.2 路径与整理测试

- Windows 保留字符和设备名
- 中文、日文、Emoji 与 Unicode 组合字符
- 目标文件已存在
- 同一计划重复执行
- 小数集不覆盖整数集
- 多文件种子不生成重复目标
- 下载器返回成功但实际未改名
- 硬链接跨文件系统失败
- 复制中断与磁盘空间不足
- 服务重启后恢复未完成整理操作

### 15.3 下载器契约测试

同一组测试分别运行于 qBittorrent、aria2 和 MockDownloader：

- 认证成功与失败
- 添加磁力链接和种子文件
- 重复任务确认
- 查询状态和文件
- 暂停、恢复
- 重命名和移动能力
- 网络超时后的对账

### 15.4 端到端测试

使用 Docker 启动 Mock RSS、Mooncell、真实 qBittorrent 和临时媒体目录，验证：

```text
RSS 条目 → 自动订阅/匹配 → 下载 → 完成 → 重命名 → 媒体库路径
```

首个发布版本至少应拥有一条真实 qBittorrent 端到端测试，而不只依赖 Mock。

## 16. 推荐的当前决策

在用户勾选 `PRODUCT_PLAN.md` 前，暂按以下建议继续细化：

1. qBittorrent 首选 `downloader_managed`，不要求 Mooncell 直接访问远程下载目录。
2. aria2 通过统一能力接口接入；若无法远程重命名，则要求共享挂载并使用硬链接或受控文件操作。
3. P0 使用“平衡模式”：不确定条目可以下载，但不自动整理。
4. TMDB 在 P0 可选；Movie 与 Special 若缺乏可靠映射则待确认。
5. 发现修订版默认 `hold`，不自动覆盖和删除。
6. 仅当番剧设置了发布偏好时启用 20 分钟候选等待窗口。
7. 默认目录模板使用 `Season 01`，普通集使用 `S01E01`。

## 17. 下一步

完成 `PRODUCT_PLAN.md` 第 8 节的关键决策后，下一轮设计应输出：

- 数据库 ER 模型
- `ReleaseParser` 详细语法与测试夹具格式
- 下载器 Protocol 的准确请求/响应模型
- qBittorrent 与 aria2 路径能力矩阵
- P0 REST API 请求和响应定义
- 首页、订阅页与整理冲突页线框图
