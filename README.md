# story-core

自建「本项目」后端的核心层。目标形态见[《自建后端架构方案》](../story-tavern/docs/product-backend-plan.md)。

- **M0 资产格式兼容层**：读写 SillyTavern 的角色卡、世界书、会话记录
- **M1 单用户对话**：提示词引擎 + 模型网关 + 会话持久化
- **M2 流式与幂等**：SSE 逐字输出、重新生成、中断不留脏数据、同一 requestId 不重复计费
- **M3 世界书生效**：关键词匹配、次关键词逻辑、概率、位置/深度/顺序插入、递归扫描、sticky/cooldown
- **M4 多用户与额度**：账号与会话、按用户隔离的数据、额度预留与不可变用量流水、全局熔断

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

1. **用量是不可变流水**。每次模型调用追加一行 `usage_ledger`，额度和余额都由它 `SUM` 出来，绝不维护一个可能漂移的可变计数器。
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
```

## 用法

```bash
npm install          # 只装 typescript / @types/node，仅用于类型检查
npm test             # 单元测试（69 项）
npm run typecheck

# 指向酒馆的数据目录直接操作
export STORY_LIBRARY_ROOT=../story-tavern/data/default-user
node src/cli.ts list
node src/cli.ts worldbooks
node src/cli.ts preview linzhao "今天有点累"     # 只看提示词，不调模型
```

配置模型（两种方式，环境变量优先）：

```bash
cp story.config.example.json story.config.json && $EDITOR story.config.json
# 或者
export STORY_MODEL_ENDPOINT=https://api.deepseek.com/v1/chat/completions
export STORY_MODEL_NAME=deepseek-chat
export STORY_MODEL_API_KEY=sk-...
```

对话：

```bash
node src/cli.ts ask linzhao "今天上班被骂了"          # 新建会话并说第一句
node src/cli.ts say linzhao 2026-09-21_22-09-41 "不想说话"   # 继续
node src/cli.ts model                                 # 显示当前配置（密钥打码）
```

HTTP（默认只监听回环）：

```bash
STORY_LIBRARY_ROOT=../story-tavern/data/default-user node src/server.ts --port 8787

curl -s localhost:8787/api/v1/model
curl -s -X POST localhost:8787/api/v1/chats \
  -H 'Content-Type: application/json' -d '{"cardId":"linzhao","personaName":"User"}'
curl -s -X POST localhost:8787/api/v1/chats/linzhao/2026-09-21_22-09-41/messages \
  -H 'Content-Type: application/json' -d '{"message":"在吗"}'
```

返回里带 `prompt` 统计（包含哪些段落、历史纳入/丢弃多少条、估算 tokens），前端可以直接把它显示成调试信息。

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

M0 两个方向都有可执行验证：

```bash
# 方向一：酒馆写的，我们能读
SILLYTAVERN_LIBRARY=../story-tavern/data/default-user npm test

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

M4 在三个层面覆盖：`test/auth.test.ts`（哈希自带参数、token 只存哈希、过期与吊销、首个账号是管理员）、`test/billing.test.ts`（预留计入限额、日/月/全局/并发四种拒绝、幂等计费、零额度=不限）、`test/server-m4.test.ts`（未带 token 401、两账号隔离到文件系统、流式计费一次、重发同一 requestId 只调一次模型、管理员路由与限额设置）。实测量级：169 项测试。

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
  prompt/         提示词引擎（纯函数 + 世界书扫描 + token 估算）
  db/             SQLite 打开/迁移/事务
  auth/           密码哈希（scrypt）、账号与会话
  billing/        额度策略、预留、不可变用量流水
  gateway/        OpenAI 兼容适配器 + 配置
  chat/           会话：建会话、发一轮、流式、重新生成、落盘
  config.ts       环境变量驱动的配置
  library.ts      套在酒馆数据目录上的文件库
  server.ts       HTTP API（node:http，无框架）
  cli.ts          命令行
test/             单元测试 + 交叉验证（交叉验证需环境变量，默认跳过）
scripts/          与酒馆的互操作验收脚本
```

## 下一步（M5 / M6）

**M5 — 摘要记忆**：滑动窗口已经有了（M1 的裁剪逻辑），M5 加滚动摘要；向量召回排在摘要之后，因为先做向量会花两周调 embedding 而用户感觉不到差别。

**M6 — 平台功能**：UGC 市场、榜单（增量聚合表）、积分与邀请、论坛、App（复用同一套 API）。

## 说明

- Node ≥ 22.6（直接运行 TypeScript，无需构建步骤）
- 依赖策略：运行时零依赖。PNG 用内置 `zlib`，HTTP 用内置 `node:http`，测试用内置 `node:test`
- token 数是**估算**（CJK 约 1 token/字，ASCII 约 4 字符/token）。精确计数需要目标模型自己的分词器，M3 之后再按需接入
- 单用户模式（`STORY_AUTH=off`，默认 `./data`）没有鉴权，只应监听回环；开启账号后每个数据接口都要求 Bearer token 或会话 cookie
- 账号相关的环境变量：`STORY_AUTH`、`STORY_DB`、`STORY_DATA_ROOT`、`STORY_ALLOW_REGISTRATION`、`STORY_DAILY_TOKENS`、`STORY_MONTHLY_TOKENS`、`STORY_MAX_TOKENS_PER_REQUEST`、`STORY_GLOBAL_DAILY_TOKENS`、`STORY_MAX_STREAMS`、`STORY_SESSION_TTL_DAYS`
- `node:sqlite` 是实验特性，换 Postgres 时只需替换 `src/db/database.ts`；预留表在内存里，多实例要挪到 Redis
- 直接对酒馆的数据目录写入前请先备份（读是安全的）
