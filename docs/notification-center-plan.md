# 异步任务提醒中心实施计划

日期：2026-10-15

## 1. 目标与交互

在顶部导航右上角增加铃铛入口。用户发起耗时操作后可以继续使用页面，任务完成、部分完成或需要处理时，在提醒中心留下记录并更新未读角标，不再弹出该任务的 toast。

- 桌面端打开右对齐浮层，移动端使用适配屏幕宽度的面板；沿用现有深色主题和绿色强调色。
- 面板展示“进行中”和“最近提醒”，支持单条已读、全部已读、加载更多。
- 一次操作对应一条记录：例如一次修改迁移 12 个下载任务，展示“已完成 8 / 12”，最终更新同一条记录。
- 进行中的普通进度变化不增加未读。完成、部分完成、失败、首次需要处理时增加未读；相同错误持续发生时不重复提醒。
- 提醒包含番剧名、操作、状态、发生时间、简短结果及查看入口。打开面板不自动将全部消息标为已读。
- 不自动展开面板、不播放声音。角标统计未读提醒，超过 99 显示 `99+`。
- 表单保存失败仍在表单内展示；其他即时操作的 toast 保留。本次优先迁移下表中的耗时操作。

| 操作 | 提交后 | 后续提醒 | 查看入口 |
| --- | --- | --- | --- |
| 添加订阅后的 TMDB 刮削 | 已排队／正在刮削 | 刮削完成、图片不完整或失败 | 对应番剧、相关日志 |
| 编辑订阅更换 TMDB 关联 | 正在更新元数据和图片 | 更新完成、部分完成或失败 | 对应番剧、相关日志 |
| 修改番名或季度后的文件迁移 | 等待同步／已完成 N / M | 全部完成，或迁移受阻及原因 | 该订阅的下载任务 |
| 手动重新刮削 | 已提交后台处理 | 刮削完成、部分完成或失败 | 对应番剧、相关日志 |

不把每次自动 RSS 轮询、每个文件移动阶段都加入提醒列表。查询类请求，例如搜索 TMDB 候选，继续使用页面内反馈。

## 2. 已确认的代码现状

- `frontend\src\hooks\use-events.ts` 监听 `feed.setup.completed/partial/failed` 并弹 toast，通过内存集合去重，首次加载时跳过旧消息，不能作为提醒历史。
- `frontend\src\components\app-shell.tsx` 的 `top-actions` 已有审核、日志和设置入口，铃铛放在这里。
- `backend\app\api.py` 中 `_complete_feed_setup()` 执行后台刮削；新增和修改 TMDB 关联都复用它。现有 `feed.setup.completed` 文案只描述“订阅已添加”，需要区分新增和修改。
- `frontend\src\pages\shows.tsx` 的手动重新刮削仍等待 HTTP 返回后弹 toast，需要一并调整为提交后台任务。
- `backend\app\season_change.py` 为每个下载生成迁移计划和 token，完成后记录 `download.library.changed`，缺少一次修改对应的批次标识和完成汇总。
- `backend\app\download_queue.py` 每 5 秒处理队列，迁移异常通常保留状态继续重试，不能把每次异常都当成终态失败。
- 文件迁移事件目前写入 `DomainEvent`，没有像 API 的 `_record_and_publish_event()` 那样立即广播；仅在前端新增监听会遗漏在线更新。
- SSE 历史补发有 200 条限制，历史查询与订阅实时队列之间也存在时间窗口。提醒历史必须由数据库查询保障，不能只依赖 SSE。

## 3. 后端数据设计

新增 `BackgroundOperation` 和 `BackgroundOperationItem` 两张表，用于追踪操作及展示提醒。沿用现有刮削函数和下载队列执行任务，不引入新的任务队列框架。

### BackgroundOperation：一次用户操作

建议字段：

```text
id: UUID
user_id: 发起用户
kind: feed_scrape | metadata_refresh | artwork_scrape | library_migration
source_id: 可空的订阅引用
source_name: 操作发生时的名称快照
status: queued | running | blocked | completed | partial | failed | cancelled
total_count / completed_count: 迁移下载任务数量，不冒充文件数量或字节百分比
summary / error_summary: 可展示文案，错误信息经过脱敏
context: 旧/新番名、季度、TMDB 选择等必要快照
created_at / updated_at / finished_at
revision: 每次状态或进度更新递增
attention_revision: 出现值得提醒的新结果时更新
read_revision: 用户最后读到的 attention_revision
```

未读条件为 `attention_revision > read_revision`。普通进度更新不改变 attention_revision；已读后最终完成会再次变为未读。重复重试同一错误不重复增加 attention_revision。

按 `(user_id, updated_at, id)` 建索引，接口按当前登录用户过滤。首版仅向操作发起者提供提醒。

### BackgroundOperationItem：迁移批次中的下载任务

```text
id / operation_id / download_job_id
migration_token
status: queued | running | blocked | completed | cancelled
error_summary / updated_at
```

为 `(operation_id, download_job_id)` 和迁移 token 设置合适的唯一约束，避免队列重试重复计数。同一订阅下一次有效修改生成新 operation；已有迁移未结束时，沿用现有冲突校验，不生成重复批次。

新表通过现有 `init_database()` 建表路径创建，不需要重置已有数据库。删除订阅后保留名称快照与提醒历史，关联改为空；尚未完成的操作变为取消，详情入口提示关联订阅已删除。

## 4. 任务接入与状态规则

### 4.1 刮削

1. 添加订阅或修改 TMDB 关联时，在保存事务中创建 operation；提交成功后启动 `_complete_feed_setup(source_id, operation_id)`。
2. `FeedRead` 增加兼容字段 `background_operation_ids`，默认空列表；现有调用方不必改变基础数据结构。
3. 后台执行时更新 `running`，按结果写入 `completed / partial / failed`。保留“订阅已保存，刮削失败”的语义，避免让用户误认为保存失败。
4. 操作记录保存提交时的 TMDB 选择；应用结果前核对当前关联，旧请求不能覆盖新关联。过期操作标记取消，不留在进行中。
5. 手动重新刮削改为返回 `202` 和当前番剧数据、operation ID，后续结果通过提醒中心和查询刷新展示。
6. 新增与编辑使用不同操作文案，同一次后台结果只更新一条提醒。

### 4.2 文件迁移

1. `schedule_season_change()` 返回实际安排的下载任务 ID 和迁移 token，替代仅返回数量；在同一事务中记录批次和子项。
2. 零个任务需要迁移时不创建“文件移动完成”提醒。
3. 队列推进时更新对应子项；阶段变化不生成独立消息。
4. 在现有 `restore` 完成、下载任务已确认恢复原运行状态、最终计划已保存之后，才将该子项标记完成。qB 接受移动请求不等于完成。
5. 所有子项完成后，父操作变成 `completed`，提醒“《番剧名》文件整理完成，已同步 12 个下载任务”。
6. 下载器未启用、路径冲突、任务被移除等明确需要处理的情况变成 `blocked`；网络等暂时异常显示等待重试，按同一操作去重。为这些情况补充明确的错误分类，避免靠错误字符串判断。
7. `blocked` 可恢复为 `running`，最终完成后更新同一记录并再次显示未读。只要仍有任务继续重试，就不宣告整个批次“部分完成”。
8. 更新子项与批次计数应幂等；重复执行同一迁移完成逻辑，不重复递增完成数或产生提醒。

### 4.3 重启处理

- 文件迁移使用已有持久化计划继续执行，启动时从子项和下载任务状态重新汇总操作状态。
- FastAPI 的进程内后台刮削任务不保证重启恢复。启动时将上一进程遗留的刮削操作标为中断失败，提供明确的重新刮削入口，避免永久“进行中”。
- 首版不把新的后台执行基础设施混入提醒功能；后续可以单独增加可恢复刮削队列。

## 5. 查询接口与实时更新

新增 `backend\app\notifications.py` 和独立的 `notification_api.py`。

```text
GET   /api/v1/notifications?cursor=...&limit=20
      -> items, next_cursor, unread_count, active_count
GET   /api/v1/notifications/summary
      -> unread_count, active_count
GET   /api/v1/notifications/{id}
      -> 操作详情、迁移汇总；子项按需分页
PATCH /api/v1/notifications/{id}/read
      { attention_revision: 用户实际看到的版本 }
POST  /api/v1/notifications/read-all
      { cutoff: 服务端列表快照时间 }
```

- 所有接口校验登录和操作归属；已读更新幂等，不能把读取之后才到达的新结果误标为已读。
- 列表按 `(updated_at, id)` 倒序游标分页。活动项发生排序变化时刷新第一页，客户端按 ID 去重。
- 操作变化时记录 `notification.changed` 事件，携带 operation ID 和 revision，前端收到后刷新查询，不直接拼装提醒文本。
- 提取“记录事件”和“提交后广播”公共函数，供 API 与下载队列使用；操作状态、迁移状态、事件先在同一事务提交，成功后再广播。避免直接复用会自行 commit 的 API 私有函数破坏队列事务边界。
- SSE 首次连接、重连、窗口重新获得焦点时重新查询提醒摘要和当前列表；有活动任务或 SSE 异常时以 15 秒间隔补查摘要、必要时刷新列表。
- 历史由 GET 接口提供。即便 SSE 漏发、重复、乱序或历史超过 200 条，提醒记录和未读数仍以数据库为准。

## 6. 前端改动

| 文件 | 改动 |
| --- | --- |
| `frontend\src\components\notification-center.tsx`（新增） | 铃铛、角标、面板、进行中列表、已读操作、空状态和加载失败重试 |
| `frontend\src\components\notification-item.tsx`（新增） | 操作名称、状态、时间、进度和详情入口 |
| `frontend\src\hooks\use-notifications.ts`（新增） | React Query 查询、分页、已读 mutation、摘要同步 |
| `frontend\src\components\ui\popover.tsx`（新增） | 封装现有 radix-ui 的 Popover，用于具有交互内容的提醒面板 |
| `frontend\src\components\app-shell.tsx` | 在 `top-actions` 接入铃铛，验证小屏导航宽度 |
| `frontend\src\styles\shell.css` | 提醒面板与角标样式，移动端布局 |
| `frontend\src\hooks\use-events.ts` | 移除后台刮削结果 toast，监听提醒变化并刷新查询，保留原有业务数据刷新 |
| `frontend\src\lib\api.ts` | 提醒、状态、响应及操作 ID 类型 |
| `frontend\src\pages\feeds.tsx` | 添加订阅后刷新提醒列表，保留表单内错误 |
| `frontend\src\components\edit-subscription-dialog.tsx` | 有后台操作时停止成功 toast，通过提醒中心展示后续状态；普通字段修改保留即时反馈 |
| `frontend\src\pages\shows.tsx` | 重新刮削提交后刷新提醒，移除对应完成和失败 toast，避免 SSE 与请求回调双重提醒 |
| `frontend\src\pages\downloads.tsx`、`shows.tsx`、`logs.tsx` | 支持提醒入口携带订阅或操作过滤条件，准确定位关联记录 |

面板支持键盘打开、Esc 关闭、关闭后焦点回到铃铛。图标按钮提供“提醒，3 条未读”等可访问名称，颜色配合文字和图标表示状态。登录退出时清除提醒查询缓存，防止显示上一用户的记录。

## 7. 实施顺序

1. **提醒存储和 API**：新增模型、操作服务、鉴权与已读接口、事务内事件记录和提交后广播。
2. **刮削接入**：添加订阅、TMDB 修改和手动重新刮削接入 operation，处理过期结果和启动中断记录。
3. **迁移汇总**：接入批次、子项、阻塞状态及完成计数，复用现有移动流程。
4. **右上角入口**：实现提醒面板、分页、未读角标、详情跳转、SSE 更新与补查。
5. **移除重复反馈**：逐一替换上述后台操作的 toast，保留表单内即时错误与其他普通操作反馈。
6. **回归与文档**：更新数据库表文档和使用说明，完成以下验收。

## 8. 验收清单

- 添加订阅后立刻关闭弹窗和切换页面，刮削完成后铃铛出现未读，且没有完成 toast。
- 修改 TMDB ID 后文案正确显示“元数据更新”，不会误显示“订阅已添加”。
- 一次迁移多个下载任务只生成一条提醒，全部完成前不报告成功；进度单位明确为下载任务。
- 下载器离线或路径冲突时显示受阻原因；重复队列轮询不刷屏，恢复后同一记录最终变为完成。
- 普通订阅字段修改或无下载可迁移时，不生成空迁移任务。
- 刮削部分成功、失败、过期结果，迁移重复推进和订阅删除均有覆盖测试。
- 刷新页面、断网重连、SSE 重复/遗漏及超过 200 条历史，不丢提醒、不重复计数。
- 标记已读时恰好产生新结果，新结果仍保留未读；已读状态可跨刷新和设备保持。
- 重启后迁移继续汇总，刮削中断有明确结果，不残留永久运行中的记录。
- 未登录无法查询，不同用户不能读取或标记对方提醒；登出后不残留缓存。
- 验证桌面与移动端布局、键盘操作、详情定位；原有订阅编辑、刮削、文件迁移回归测试通过。
- 前端构建目前存在 `react-router-dom`、`motion/react` 等导出类型错误；实施前单独确认并修复本地依赖环境，再执行完整构建和浏览器验收。

本文件为实施计划。本轮不修改提醒相关业务代码。
