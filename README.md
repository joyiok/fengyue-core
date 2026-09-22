# story-core

自建小说站后端的核心层。目标形态见[《自建后端架构方案》](docs/product-backend-plan.md)，
**为什么这么设计、代价是什么**见[《架构与设计》](docs/architecture.md)（接手前建议先读后者）。
要在里面动手，先读 [`AGENTS.md`](AGENTS.md)：必须遵守的九条规矩、怎么验、加配置项的正确姿势。

- **M0 资产格式兼容层**：读写 SillyTavern 的角色卡、世界书、会话记录
- **M1 单用户对话**：提示词引擎 + 模型网关 + 会话持久化
- **M2 流式与幂等**：SSE 逐字输出、重新生成、中断不留脏数据、同一 requestId 不重复计费
- **M3 世界书生效**：关键词匹配、次关键词逻辑、概率、位置/深度/顺序插入、递归扫描、sticky/cooldown
- **M4 多用户与额度**：账号与会话、按用户隔离的数据、额度预留与不可变用量流水、全局熔断
- **M5 滚动摘要记忆**：旧对话压成一段滚动摘要，长对话不再丢掉开头
- **M6 积分与市场**：余额账本（签到/邀请/管理员加积分）、角色发布与搜索、按天聚合的榜单

## 为什么先做这一层

角色卡的生态价值在格式里，不在酒馆的代码里：

| 资产 | 格式 |
|---|---|
| 角色卡 | PNG + `tEXt` chunk：`chara`(V2) / `ccv3`(V3，读取优先)，值为 base64 的卡片 JSON |
| 世界书 | JSON，`entries` 是 `id → 词条`，31 个字段 |
| 会话 | `<角色>/<会话>.jsonl`，首行元数据 + 每行一条消息 |

格式是事实标准，但**酒馆的代码是 AGPL-3.0**，所以这里全部自己实现（含 PNG chunk 编解码与 CRC-32），不抄它的实现、不引入运行时依赖。

## 现状

### M0 — 资产层

- 角色卡：读 V1（扁平）/ V2 / V3，统一归一化为 V2 结构；写出 PNG 时**同时写 `chara` 与 `ccv3`**（与酒馆一致）
- 世界书：31 个字段的完整类型 + 缺省填充，容忍第三方工具写出的残缺文件
- 会话：JSONL 读写，容忍缺少首行元数据的文件
- 文件库：直接套在酒馆的 `data/<用户>` 目录上（`characters/`、`worlds/`、`chats/`）
- HTTP API（`/api/v1/...`）+ CLI

### M1 — 单用户对话

提示词引擎是一个**纯函数**（`assemblePrompt`），因为提示词组装是行为最微妙的地方，纯函数才能做快照回归。顺序：

| 顺序 | 内容 | 来源 |
|---|---|---|
| 1 | 角色指令（`{{char}}`/`{{user}}` 会替换） | 内置，可覆盖 |
| 2 | 卡片自己的 `system_prompt` | 角色卡 |
| 3 | `description` / `personality` / `scenario` | 角色卡 |
| 4 | 对话示例（解析 `<START>` 与 `{{char}}:`/`{{user}}:` 前缀） | 角色卡 `mes_example` |
| 5 | 历史消息，按 token 预算裁剪 | 会话 |
| 6 | `post_history_instructions`（独立 system，紧贴用户消息之前） | 角色卡 |
| 7 | 本轮用户消息 | 请求 |

1–3 合成**一条** system 消息（兼容性最好），4 是真实的 user/assistant 轮次，6 必须是独立消息且紧贴最后——大量社区卡依赖这个位置。

历史裁剪的优先级写死在代码和测试里：**近期上下文 > 开场白 > 角色顺序**。开场白只在「不牺牲最近一轮」时挤进窗口；窗口不会以角色的发言开头（否则模型会接着自己说话）。

模型网关是通用 OpenAI 兼容适配器（vLLM / One API / OpenRouter / DeepSeek / 硅基流动都能用）。密钥只从配置文件或环境变量读，日志与错误信息里从不出现。

### M2 — 流式、重新生成、幂等

**流式（SSE）**。`stream: true` 时返回事件流，前端按 `type` 分发：

```
data: {"type":"delta","text":"她把书合"}
data: {"type":"delta","text":"上了。"}
data: {"type":"done","reply":"她把书合上了。","model":"…","usage":{…},"usageSource":"estimated",
       "latencyMs":715,"firstTokenMs":64,"prompt":{…},"requestId":"…"}
data: {"type":"error","error":"…","status":429}
data: {"type":"aborted"}
```

响应头带 `Cache-Control: no-cache, no-transform` 与 `X-Accel-Buffering: no`，否则反向代理/CDN 会把流缓冲到结束才吐出来（表现为「模型卡住了」）。

三条不变量，都有测试守着：

1. **一轮是原子的**：直到模型调用完全成功才把用户消息与回复一起落盘。中途失败或中断，日志原封不动，下一次就是干干净净的一轮，不会留下半截回复。
2. **客户端断开就中止上游**：关标签页不会继续烧 token（测试断言 mock 侧确实收到了 abort）。
3. **同一个 `requestId` 不会重复计费**：每条助手消息都记下产出它的 requestId；带同一 id 重试时直接返回日志里的回复，**不再调用模型**。这挡住的正是那种模糊失败——客户端没收到流结束，但服务端其实已经完成并保存了。

**重新生成**：`regenerate` 替换最后一条回复（日志长度不变），可选先改写它回答的那句用户消息。被替换的回复保留在新消息的 `extra.story.previousReplies` 里而不是丢掉；模型调用失败时原始那一轮会被恢复。

**用量来源**：`usageSource` 明确区分 `provider`（模型上报）与 `estimated`（按文本估算）。大多数厂商流式默认不报用量，可用 `includeUsage: true` 打开 `stream_options.include_usage`（默认关闭，因为不认识该字段的厂商可能直接报错）。计费时必须区分这两者。

### M3 — 世界书生效

世界书是「像酒馆」的真正分水岭：角色扮演的质量差异主要来自命中与注入，而不是流式与否。

角色卡通过 **`data.extensions.world`** 关联世界书（酒馆的 primary world 机制），会话会自动加载；也可以用 `worldbookIds` 显式指定，或同时挂多本。解析逻辑在 `Library.resolveWorldbooks`，会话与 CLI 预览共用同一份实现——**预览必须与真实发送一致**，否则调试时会骗自己。

字段语义与枚举值取自 SillyTavern 1.19 源码：

| 维度 | 取值 |
|---|---|
| `position` | 0 before · 1 after · 2 ANTop · 3 ANBottom · 4 atDepth · 5 EMTop · 6 EMBottom · 7 outlet |
| `selectiveLogic` | 0 AND_ANY · 1 NOT_ALL · 2 NOT_ANY · 3 AND_ALL |
| `role` | 0 system · 1 user · 2 assistant（默认 system，仅在 atDepth 生效） |
| 默认值 | 扫描深度 2、插入深度 4 |

已实现：关键词匹配（大小写、整词、`/正则/标志`）、每词条独立的 `scanDepth`、`constant`、`selective` + `keysecondary` 四种逻辑、`probability`（随机源可注入，因此可测）、`delay`、`sticky`/`cooldown`、按 `position`+`depth`+`order` 插入、`role`、token 预算（高 `order` 优先）、递归扫描（`excludeRecursion`/`preventRecursion`/`delayUntilRecursion`）、内容里的 `{{char}}`/`{{user}}` 替换。

三条语义细节值得单独说明，因为它们最容易被实现错：

1. **激活内容只在下一轮递归可见**。让同一轮里的兄弟词条看见它，会让结果依赖词条顺序，也会让 `preventRecursion` 失去意义。
2. **`delayUntilRecursion` 可以是数字**（递归层级），不是纯布尔——归一化时按布尔处理会静默丢掉真实卡的配置。
3. **整词匹配的边界只认拉丁字母/数字**。中文没有空格，若把 CJK 也当词字符，整词匹配在中文卡上永远不命中（酒馆基于 `\b` 的实现正是这个问题）。

**明确未做**（写在代码注释里而不是藏着）：预算用估算 token（酒馆用上下文百分比）、Author's Note 未实现（故 ANTop/ANBottom 落在历史边界）、`outlet` 视为 after、分组评分与向量召回不做。

sticky/cooldown 状态按 **`<世界书>.<uid>`** 为键（uid 只在单本内唯一），存在会话的 `chat_metadata.story.worldInfo` 里，因此**重开进程、刷新页面都还在**；只有在整轮真正落盘时才推进，失败的一轮不会白白吃掉 sticky 窗口。

真实数据验证：用酒馆自带的 Seraphina 卡（其 `extensions.world = Eldoria`）与真实的 `Eldoria.json`：

```
$ node src/cli.ts preview default_Seraphina "What is Eldoria?"
(world info: 3/4 activated; skipped key=1 probability=0 cooldown=0 delay=0 budget=0; ~792 tokens)
   [Eldoria.0] eldoria    ← key keys=eldoria/forest → before_definition role=system
   [Eldoria.1] shadowfang ← key keys=beast/beasts   → before_definition role=system
   [Eldoria.3] power      ← key keys=magic          → before_definition role=system
```

未命中的 `glade` 词条（keys = glade / safe haven / refuge）确实不在扫描窗口内，属正确行为。

### M4 — 多用户与额度

做产品必须先有这块：没有额度，公网多用户会直接烧穿账单且拦不住。

**存储用的是 Node 内置的 `node:sqlite`**（无需 flag，只有一条实验性告警，npm 脚本里已抑制）。这样 M4 拿到了真正的 SQL、事务、索引与唯一约束，同时**保持运行时零依赖**；换 PostgreSQL 是替换 `src/db/database.ts` 这一层的事，不是重写 API。

**两条规矩**，写在 `src/billing/service.ts` 顶部也写在测试里：

1. **用量是不可变流水**。每次模型调用追加一行 `usage_ledger`，额度与用量都由它 `SUM` 出来，绝不维护一个可能漂移的可变计数器（M6 的积分账本 `credit_ledger` 是同一套做法）。
2. **请求先预留、再调用**。检查完额度就发请求，会让十个并发请求一起通过检查然后一起超支；预留按最坏情况（提示词估算 + 请求的 `max_tokens`）算，才让限额真正成立。结算时用真实用量替换预留。

**认证**：账号用 scrypt 哈希，且**哈希串自带参数**（`scrypt$N$r$p$hash`），所以以后提高成本不会让老密码全部失效。会话是**不透明随机 token**（只存 SHA-256），不用 JWT——登出必须真的吊销，而且没有签名密钥要轮换。Bearer 头与会话 cookie 都支持。**第一个注册的账号自动成为管理员**（否则你没有任何途径拿到 admin），之后可用 `STORY_ALLOW_REGISTRATION=off` 关闭注册。

**隔离**：每个用户一棵目录树 `<dataRoot>/users/<userId>/`，所以隔离是**文件系统边界**而不是查询过滤条件；同一个 id 在别人的库里根本不存在（实测 404）。

**额度**：日 / 月 token 配额、单次 `max_tokens` 上限、每用户并发上限、以及跨所有用户的**日支出熔断**。超额返回 `402` 并带上 `limit`/`used`/`resetAt`，全局熔断返回 `503`，并发超限返回 `429`。计费落在网关层，并且区分 `usageSource`（`provider` 上报 vs `estimated` 估算）——两者不能混算。

**中断不计费**：客户端断开或模型失败的那一轮不写流水（用户没拿到任何东西），但预留仍然占用了额度，所以并发与熔断的保护不受影响。

**明确未做**（写在代码注释里）：预留表在内存里，多实例部署需要挪到 Redis；没有支付渠道、邮箱验证、按 IP 限流、内容审核。

运维命令：

```bash
node src/cli.ts user add owner owner-password      # 第一个自动是 admin
node src/cli.ts user list                          # 带用量
node src/cli.ts user quota guest --daily 5000 --per-request 256
node src/cli.ts user disable guest

node src/cli.ts credits show owner                 # 余额 + 总额 + 最近流水（对账用）
node src/cli.ts credits grant owner 500 --reference goodwill
node src/cli.ts credits invite owner --count 3
node src/cli.ts market list --sort hot --limit 10
node src/cli.ts market publish owner linzhao --root ./data/users/<user-id>
node src/cli.ts market unpublish owner linzhao
node src/cli.ts settings list                 # 全部配置 + 是否已改 + 是否要重启
node src/cli.ts settings set model.name deepseek-chat
```

### M5 — 滚动摘要记忆

M1 的窗口只保留最近若干条；M5 补上被挤出去的那部分。做法是**滚动摘要**：每次把「已有摘要 + 新的一段对话」交给模型合并成一段新摘要，所以这个块的大小是恒定的，不会随对话长度膨胀。

| 规则 | 说明 |
|---|---|
| 触发 | 未摘要的消息数达到 `messageThreshold`（默认 40）才跑一次 |
| 不动最近 | 最近 `keepRecent` 条（默认 12）永远保持原样，所以摘要不会追着当前对话跑 |
| 注入位置 | 作为独立的 system 块插在历史之前，被它覆盖的消息**不再重复发送** |
| 合并而非重来 | 有旧摘要时，提示词要求模型合并而不是重写，已经压缩过的信息不会丢 |
| 记账 | 摘要是一次真实的模型调用，所以它走**同一套 authorize → settle**：服务端在轮次之后单独预留与记账，账本里是一条 `…:summary:<upTo>` 的记录。把它做成免费的话，额度上就多了一个洞 |
| 失败不影响对话 | 摘要失败只记录日志，已经完成的那一轮照常返回；`POST /chats/:c/:n/summarize` 可以重试 |

`ChatSession.send()` **本身不做摘要**——这是有意的：摘要要单独计费，所以由调用方决定何时付这笔钱。服务端在轮次后做，CLI 在每轮后做（命令行没有账号，直接跑）。`summaryPlan()` 用来问「现在该摘要了吗」，`summarize()` 用来执行。

实测（60 轮、120 条消息、mock 摘要器）：

```
第 15 轮 | 日志  31 条 | 送入历史  8 条 | 摘要覆盖  23 条（1 次） | 提示词约 318 tokens
第 60 轮 | 日志 121 条 | 送入历史 10 条 | 摘要覆盖 111 条（5 次） | 提示词约 355 tokens

日志完整保留：121 条消息落盘（60 轮全部在）
第一轮的事实「我养了一只叫豆豆的猫」是否还在提示词里：在（通过摘要）
```

**明确未做**：向量召回（排在摘要之后——先做向量会花两周调 embedding 而用户感觉不到差别）、摘要的人工编辑、按角色卡定制摘要提示词。

### M6 — 积分与市场

先分清两套账，它们回答的是不同的问题：

| | 额度（M4） | 积分（M6） |
|---|---|---|
| 回答 | 「这个账号一天最多烧多少 token」 | 「这个账号还剩多少钱」 |
| 目的 | 保护运营者的账单 | 用户自己的余额 |
| 拒绝 | 402，日/月/全局/并发四种 | 402 `insufficient_credits` |

两者都是**只追加的流水**，余额一律 `SUM(amount)` 算出来，没有可漂移的余额字段。
积分规则：

| 项 | 默认 | 说明 |
|---|---|---|
| 注册赠送 | 100 | 第一个会话不用先签到 |
| 每日签到 | 10 | 每个 UTC 日一次；reference 就是日期，重复调用只发一次 |
| 邀请 | 邀请人 50 / 被邀请人 50 | 一个码只能兑换一次，自己的码不能兑换 |
| 计价 | 1000 tokens = 1 credit，向上取整 | 按一次真实调用的实际 tokens 结算 |
| 幂等 | `(user_id, reason, reference)` 唯一 | 重试同一 `requestId` 不会重复扣 |

关键取舍：

- **一轮对话结束后**按实际 tokens 扣积分——成本只有模型回复后才知道，所以扣费不可能是前置条件；请求前只查余额，为 0 直接 402，**模型根本不会被调用**；
- 摘要也一样扣（账本里是 `…:summary:<upTo>`），否则额度上就多一个洞；
- 扣费失败只写日志：回复已经给到用户了，真正的硬上限是 token 额度，不是积分；
- 失败/中断的轮次不计费（与 M4 一致）。

市场：

| 规则 | 说明 |
|---|---|
| 发布是显式的 | `POST /characters/:id/publish`；默认私有，按 id 猜也拿不到 |
| 列表读快照 | 发布时把 name/tags/描述长度快照进 `character_shares`，所以浏览列表**不读任何人的目录**——这是市场页能快的前提 |
| 重发不重置时间 | 重新发布刷新快照，但保留首次 `published_at`，否则改一次就跳到「最新」第一 |
| 榜单按天聚合 | `character_stats` 一行/角色/天，day/week/month/all 都是范围扫描，不是扫事件表；score = 收藏×3 + 导入×2 + 浏览×1 |
| 不刷分 | 浏览/导入未发布的角色不计入统计；看自己的发布不算浏览 |
| 导入是复制 | 把对方的卡 PNG 复制进自己的库（卡里内嵌的世界书随卡一起走），原主人那份不动 |

`STORY_MARKET=off` 可以关掉市场而保留账号与积分；两者都只在多用户模式（`STORY_AUTH=on`）下存在——没有账号的话，「余额」和「谁的公开角色」都没有意义。

**明确未做**：审核/举报流程、真实支付、讨论区（§8 里 M6 只要求「可公开、可搜索；积分流水可对账」）。

### 网页客户端

`web/` 是 Next.js 客户端，也是这套接口的唯一消费者：对话（流式、重新生成、删单条）、
角色（导入/新建/编辑/换头像/发布）、世界书（逐词条编辑命中与插入）、市场与榜单、
积分与额度（含管理员面板）。页面清单与已知取舍见 [`web/README.md`](web/README.md)。

三条和后端对应得上的实现约束：

1. **流式不能被缓冲。** 生产里 Caddy 把 `/api/*` 直接反代给本服务（`flush_interval -1`），
   本地开发走 `web/app/api/v1/[...path]` 那个代理；两者都只转发字节，不改写、不攒。
   实测逐字到达时间直连与经代理一致（9 帧 / 490ms）。
2. **一轮没落盘就不算发生。** 后端是原子的，所以界面上那一段在 `done` 之前只活在
   `pending` 里；失败或按「停止」什么也不留，草稿回输入框——不会出现“页面上有一条、
   文件里没有”。
3. **`requestId` 是一次“说这句话”的尝试。** 同一句话重试复用同一个 id，命中日志里的
   回复就不会再调模型、再扣一次费。

### 配置在哪里

**环境变量说数据在哪，`settings` 表说服务怎么跑。**

启动时给 `settings` 的每个键写一行：有对应环境变量就用它，否则用出厂默认值（`INSERT OR
IGNORE`）。**这是环境变量唯一被读取的时刻**；行一旦存在就是它说了算。所以：

- 改模型 key、改额度、关掉市场 → 改数据库，立刻生效，不重启
- 改 `.env` → 对已经在跑的实例没有任何影响（有意如此，见上一条）
- 想回到出厂值 → `settings reset <key>`，它写回启动时那一行的值

三个例外标了 `restart`：`auth.enabled`（决定要不要建账号服务，也决定数据目录布局）、
`server.host` / `server.port`（监听地址在启动时绑一次）。

改的方式三选一：网页端「管理 → 设置」、`node src/cli.ts settings set <key> <value>`、或者
`PUT /api/v1/admin/settings`。管理类接口全部在 `/api/v1/admin/*` 一个命名空间下，角色校验
只有一处——运营者做的事和用户做的事分开，见 [AGENTS.md](AGENTS.md)。`settings list` 会把每个键的值、是否已改、是不是要重启
都列出来；`model.apiKey` 这类密钥走 HTTP 一律打码，只有 CLI 会显示原文。

存储就是一个三列的小表：

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
```

值按 JSON 存，所以数字还是数字、布尔还是布尔。每次读都是一次主键查找，不缓存——CLI 在
服务运行时改了值，服务下一次读就能看见。

## 用法

```bash
npm install          # 只装 typescript / @types/node，仅用于类型检查
npm test             # 单元测试（215 项，其中 2 项是需要真实酒馆目录的交叉验证，默认跳过）
npm run typecheck

# 网页客户端（另开一个终端）
cd web && npm install && npm run dev     # http://localhost:3000，接口默认指向 127.0.0.1:8787

# 指向酒馆的数据目录直接操作
export STORY_LIBRARY_ROOT=/path/to/sillytavern/data/default-user
node src/cli.ts list
node src/cli.ts worldbooks
node src/cli.ts preview linzhao "今天有点累"     # 只看提示词，不调模型
```

配置模型——配置在数据库里，改完即生效：

```bash
node src/cli.ts settings set model.endpoint https://api.deepseek.com/v1/chat/completions
node src/cli.ts settings set model.name     deepseek-chat
node src/cli.ts settings set model.apiKey   sk-...
# 或者在网页端：账户 → 设置（管理员）
```

配不齐会怎样：`GET /api/v1/model` 说 `configured: false`，发一轮返回 `503`，其余（账号、
角色卡、世界书、市场）照常。

对话：

```bash
node src/cli.ts ask linzhao "今天上班被骂了"          # 新建会话并说第一句
node src/cli.ts say linzhao 2026-09-21_22-09-41 "不想说话"   # 继续
node src/cli.ts model                                 # 显示当前配置（密钥打码）
```

HTTP（默认只监听回环）：

```bash
STORY_LIBRARY_ROOT=/path/to/sillytavern/data/default-user node src/server.ts --port 8787

curl -s localhost:8787/api/v1/model
curl -s -X POST localhost:8787/api/v1/chats \
  -H 'Content-Type: application/json' -d '{"cardId":"linzhao","personaName":"User"}'
curl -s -X POST localhost:8787/api/v1/chats/linzhao/2026-09-21_22-09-41/messages \
  -H 'Content-Type: application/json' -d '{"message":"在吗"}'
```

返回里带 `prompt` 统计（包含哪些段落、历史纳入/丢弃多少条、估算 tokens），前端可以直接把它显示成调试信息。

多用户模式下和积分/市场相关的接口：

```
GET    /api/v1/me/credits                      余额、今日收支、最近流水
POST   /api/v1/me/password                      改密码 {"currentPassword","newPassword"}（吊销全部会话，返回新 token）
POST   /api/v1/me/checkin                      每日签到（幂等）
GET    /api/v1/me/invites                      我发出的邀请码
POST   /api/v1/me/invites                      生成邀请码 {"count":1}
POST   /api/v1/me/invites/redeem               兑换 {"code":"..."}
GET    /api/v1/me/favorites                    我收藏的角色
POST   /api/v1/admin/users/:id/credits         管理员加积分 {"amount":N,"reference":"..."}

GET    /api/v1/market?q=&tag=&sort=hot|new|name&limit=&offset=
GET    /api/v1/market/:ownerId/:characterId    详情（非本人浏览会计一次浏览）
POST   /api/v1/market/:ownerId/:characterId/favorite   {"favorited":true|false}
POST   /api/v1/market/:ownerId/:characterId/import     复制进自己的库
GET    /api/v1/rankings?window=day|week|month|all&limit=

GET    /api/v1/characters/:id/publish          发布状态
POST   /api/v1/characters/:id/publish          发布/刷新快照
DELETE /api/v1/characters/:id/publish          下架
GET    /api/v1/chats/:cardId/:chatName         读一份会话（名字里的空格与中文要 URL 编码）
```

网页客户端还要用到的那几条（都是同一套读写，只是开了 HTTP 入口）：

```
PUT    /api/v1/characters/:id                  编辑卡（{"data":{…}} 浅合并进现有字段）
PUT    /api/v1/characters/:id/avatar           换头像（body 是一张 PNG，卡片字段不动）
DELETE /api/v1/characters/:id                  删角色，连同打不开的那些会话
PUT    /api/v1/worldbooks/:id                  写世界书（新建或覆盖）
DELETE /api/v1/worldbooks/:id                  删世界书
GET    /api/v1/market/:ownerId/:characterId/card.png    已发布卡的头像
GET    /api/v1/market/:ownerId/:characterId/card.json   已发布卡的完整内容
DELETE /api/v1/chats/:cardId/:chatName         删一个会话
PATCH  /api/v1/chats/:cardId/:chatName/messages/:index  改一条消息的内容（日志编辑，不调模型）
DELETE /api/v1/chats/:cardId/:chatName/messages/:index  删一条消息
GET    /api/v1/admin/overview               概览：模型是否配好、账号数、今日/本月用量、积分、市场
GET    /api/v1/admin/settings               全部配置（密钥打码）
PUT    /api/v1/admin/settings               改配置 {"model.name":"…"}
POST   /api/v1/admin/settings/reset         改回启动值 {"keys":["…"]}
GET    /api/v1/admin/users                   账号列表 + 用量
PUT    /api/v1/admin/users/:id/quota          改限额
PUT    /api/v1/admin/users/:id/status         启用/停用
```

`GET /api/v1/chats/:cardId/:chatName` 带 `?offset=&limit=` 可以分页（都不给就是整份，
响应里的 `total` 始终是全量长度）。

改一条消息是**日志编辑**（`PATCH …/messages/:index`）：不调模型、不计费。而「换一种说法」
是另一件事：用 `regenerate` 带 `message`，它改的是最后那条回答**在回答谁**，并且把被替换的
回答留在 `extra.story.previousReplies` 里而不是丢掉。两者是不同的动作，所以是两个接口。
```

`GET /` 与 `GET /health` 不需要 token：前者说明这个服务是什么、有哪些接口（还没有账号时会提示先去注册），后者是给探针用的。其余所有数据接口都要 Bearer token 或会话 cookie。

部署里 Caddy 把 `/` 与 `/api/*` 之外的东西给了网页客户端（`web/`），所以接口的这个自述页只在应用端口上直接可见。

## 部署

单机 Docker Compose（一个应用容器 + 一个 Caddy 自动 HTTPS），全套在 `deploy/` 里：

```bash
git clone https://github.com/joyiok/story-core.git /opt/story-core
cd /opt/story-core/deploy
cp .env.example .env && chmod 600 .env && $EDITOR .env   # APP_DOMAIN + 模型三项
mkdir -p data caddy/data caddy/config backups
sudo chown -R 1000:1000 data caddy backups                # 容器以 PUID:PGID 运行
docker compose up -d --build
./check.sh
```

细节（首个账号、模型配置、更新、备份与恢复、已知取舍）见 [`deploy/README.md`](deploy/README.md)。两处和流式有关的配置值得单独记住：`reverse_proxy` 必须 `flush_interval -1`，并且**不能**压缩 `text/event-stream`，否则逐字输出会变成一坨。

## 验收标准

> **M0**：能把酒馆的 `characters/*.png`、`worlds/*.json` 原样导入并列出；**导出的卡能被酒馆读回**。
>
> **M1**：用最简提示词结构，能围绕一张卡连续对话 20 轮不串味。
>
> **M2**：SSE 逐字输出；刷新页面能恢复历史；中断可重试且不重复扣费。
>
> **M3**：导入的酒馆世界书能生效——关键词命中、`depth`/`order` 插入位置肉眼可验证。
>
> **M4**：两个账号的数据互不可见；额度耗尽后请求被拒；用量可查。
>
> **M5**：长对话（100+ 轮）不丢早期关键信息。
>
> **M6**：角色可公开、可搜索；积分流水可对账。

M0 两个方向都有可执行验证：

指向一份真实的酒馆数据目录即可（本机示例：`../story-tavern/data/default-user`）。

```bash
# 方向一：酒馆写的，我们能读
SILLYTAVERN_LIBRARY=/path/to/sillytavern/data/default-user npm test

# 方向二：我们写的，酒馆能读（需要 story-tavern 的酒馆容器在运行）
./scripts/verify-with-sillytavern.sh
```

第二个脚本会：用本项目的写卡器导出 → 放进酒馆的角色目录 → **在容器里调用酒馆自己的 `src/character-card-parser.js`** 解析 → 比对两边的角色名。

M1 的「不串味」由 `test/session.test.ts` 里的 20 轮测试守着：mock 模型把收到的提示词原样回显，测试逐轮断言——

1. 角色定义（描述/性格/场景）**每一轮都在**；
2. `post_history_instructions` 始终紧贴本轮用户消息之前；
3. 发送的窗口有界（不是把全部历史都塞进去），而落盘的日志完整保留每一轮。

M2 的三条不变量在 `test/streaming.test.ts`、`test/session-m2.test.ts`、`test/server-m2.test.ts` 里：

| 断言 | 怎么测的 |
|---|---|
| 逐字输出 | 断言多个 `delta` 帧按序拼接等于完整回复；CRLF、心跳注释、非 JSON 行都要能容忍 |
| 刷新能恢复历史 | 发两轮后重新 `load`，逐字段比对内存与磁盘 |
| 中断不落半截 | 流到一半 abort：日志与文件都只剩开场白 |
| 断开就停上游 | 客户端 abort 后断言 **mock 侧收到 abort** |
| 不重复扣费 | 同一 requestId 重发：断言回复来自缓存且 **mock 只被调用过 1 次** |
| 重新生成不追加 | 日志长度不变、旧回答进 `previousReplies`、失败时原轮次被恢复 |

M5 在 `test/memory.test.ts` 里覆盖：阈值与水位线的纯函数行为、注入位置与被覆盖消息不再重复发送、会话集成（摘要落盘后重载仍在）、以及「摘要调用单独记账」与「摘要失败不影响轮次」。

M6 在 `test/m6.test.ts` 里覆盖（18 项）：账本对账（`granted - spent == balance`，且流水逐条加起来等于余额）、同一 reference 不重复扣、UTC 日签到的边界（跨天前后各一次）、邀请双边各只发一次（含用自己的码、重复兑换、不存在的码）、发布快照与「重发不重置发布时间」、未发布角色按 id 也拿不到、榜单权重与日/周/月/全窗口的边界、标签整词匹配（`cat` 不匹配 `category`）、收藏幂等、跨账号导入是复制而非移动、余额为 0 时 **mock 一次都没被调用**、市场关闭不影响积分、以及中文/空格会话名走 URL 的编码链路。

M4 在三个层面覆盖：`test/auth.test.ts`（哈希自带参数、token 只存哈希、过期与吊销、首个账号是管理员）、`test/billing.test.ts`（预留计入限额、日/月/全局/并发四种拒绝、幂等计费、零额度=不限）、`test/server-m4.test.ts`（未带 token 401、两账号隔离到文件系统、流式计费一次、重发同一 requestId 只调一次模型、管理员路由与限额设置）。网页客户端要用的编辑/删除接口在 `test/server-editing.test.ts`（卡片原地编辑不动头像与未改字段、换头像不动字段、删角色连带会话、世界书写/删、删会话、删单条消息且越界是 404、会话分页、已发布卡的头像与完整内容）。实测量级：215 项测试。

M3 的世界书行为在 `test/worldinfo.test.ts` 与 `test/session-m3.test.ts` 里逐条覆盖：匹配（大小写/整词/正则/扫描深度）、四种次关键词逻辑、`constant`、`disable`、`delay`、`probability`（注入随机源）、`sticky`+`cooldown` 窗口、预算按 `order` 取舍、三种递归开关、六种插入位置与 `atDepth` 的深度、以及跨本状态不串号。真实数据的验证命令就是上面那条 `preview`。

用真实模型跑同一件事：

```bash
# 配好 STORY_MODEL_* 之后
node src/cli.ts ask <cardId> "第一句" --stream
node src/cli.ts say <cardId> <chatName> "第二句" --stream
node src/cli.ts regen <cardId> <chatName> --stream
node src/cli.ts preview <cardId> "提到某个关键词"   # 看世界书命中详情
```

风格是否真的一致只有真实模型能判定；上面这些断言保证的是**机制**：定义从不丢失、窗口有序且不越界、世界书按酒馆语义命中与插入、中断不留脏数据、重试不重复计费。

## 目录

```
src/
  png/            PNG chunk 编解码 + CRC-32（无依赖）
  cards/          V1/V2/V3 归一化、PNG/JSON 读写
  worldbooks/     世界书类型与读写
  chats/          会话 JSONL 读写
  prompt/         提示词引擎（纯函数 + 世界书扫描 + 滚动摘要 + token 估算）
  db/             SQLite 打开/迁移/事务
  auth/           密码哈希（scrypt）、账号与会话
  billing/        额度策略、预留、不可变用量流水
  credits/        积分账本：签到、邀请、计价
  market/         发布快照、搜索、收藏、按天聚合的榜单
  gateway/        OpenAI 兼容适配器 + 配置
  chat/           会话：建会话、发一轮、流式、重新生成、落盘
  config.ts       环境变量驱动的配置
  library.ts      套在酒馆数据目录上的文件库
  server.ts       HTTP API（node:http，无框架）
  cli.ts          命令行
web/              网页客户端（Next.js）：对话、角色、世界书、市场、账户
deploy/           Docker Compose 部署：Dockerfile、Caddyfile、备份、systemd 单元、自检
test/             单元测试 + 交叉验证（交叉验证需环境变量，默认跳过）
scripts/          与酒馆的互操作验收脚本
```

## 下一步

M0–M6 与网页客户端都已完成。按 `docs/product-backend-plan.md` §8，接下来不是再加功能，而是把它推到能被真实用户使用的位置：

- **规模**：预留表在内存里（多实例要挪到 Redis）；SQLite 换 Postgres 只需替换 `src/db/database.ts`；榜单已经是按天聚合的，日均增长与角色数同阶而不是与浏览量同阶。
- **合规**：商业化 + NSFW 涉及支付与内容合规，技术方案之外，自行评估。

**M6 明确未做**：审核/举报、真实支付、讨论区。**网页客户端明确未做**：世界书的分组评分
与向量召回（后端也没做）、新建会话时“不挂任何世界书”（接口的 `worldbookIds` 传空会退回
primary world，没有“一本都不要”这个表达）。

## 说明

- Node ≥ 22.6（直接运行 TypeScript，无需构建步骤）
- 依赖策略：运行时零依赖。PNG 用内置 `zlib`，HTTP 用内置 `node:http`，测试用内置 `node:test`
- token 数是**估算**（CJK 约 1 token/字，ASCII 约 4 字符/token）。精确计数需要目标模型自己的分词器，M3 之后再按需接入
- 单用户模式（`STORY_AUTH=off`，默认 `./data`）没有鉴权，只应监听回环；开启账号后每个数据接口都要求 Bearer token 或会话 cookie
- **环境变量只剩「数据在哪」**：`STORY_DB`（SQLite 文件）、`STORY_DATA_ROOT`（用户库的根）、`STORY_LIBRARY_ROOT`（CLI 单用户模式直接指向某个库）。其余一切——模型网关、额度、积分、市场、摘要、注册开关、会话时长、监听地址端口——都是 `settings` 表里的一行
- **环境变量只在某个键还没有值时填一次**，之后不再读取。所以改 `.env` 对已经在跑的实例没有影响，这正是目的：要改就改数据库（网页端或 `cli.ts settings set`），不用重启
- `auth.enabled` / `server.host` / `server.port` 是启动时读一次的，改它们要重启，界面上标了「重启」
- `node:sqlite` 是实验特性，换 Postgres 时只需替换 `src/db/database.ts`；预留表在内存里，多实例要挪到 Redis
- 直接对酒馆的数据目录写入前请先备份（读是安全的）
