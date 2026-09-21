# 自建后端架构方案（C 路线）

> 这是自建小说站后端的总体规划；本仓库 `story-core` 是它的第一步实现。
> story-tavern 只是个人的酒馆部署包，与本方案无关，它的定位保持「自己用的酒馆」不变。
>
> 结论基于对 SillyTavern 1.19 源码的核对和一次真实可行性验证（见文末「验证依据」）。

## 0. 这份方案的范围

**解决**：怎么自建一个同类的小说站——你自己写前端和后端，把「角色扮演引擎」掌握在自己手里。

**不解决**：把酒馆改造成这个后端。已核实酒馆做不到，原因见 §3.1。

**一句话架构**：

```
前端(Next.js/App)
   │  REST + SSE
   ▼
API 网关 ── 鉴权 / 限流 / 额度
   │
   ├─► 资产服务   角色卡 · 世界书 · 会话 · 消息
   │
   ├─► 提示词引擎  ← 本方案最贵的一块，必须自建
   │
   └─► 模型网关   多厂商适配 · key 池 · token 计量（扣费点）
                        │
                        ▼
                  上游模型 API
```

酒馆在本方案里的角色：**个人的角色卡编辑器 + 调试台**（它的格式就是我们兼容的目标）。

---

## 1. 可直接复用的资产格式（已验证）

角色卡的生态价值在这里：格式是事实标准，你的后端能直接读写，用户从酒馆带过来的卡和世界书能直接用。

### 1.1 角色卡

酒馆的角色库存放为 **PNG 文件**，卡片数据放在 PNG 的 `tEXt` chunk 里：

| chunk 关键字 | 内容 | 说明 |
|---|---|---|
| `chara` | `base64(JSON)` | V2 |
| `ccv3` | `base64(JSON)` | V3，**读取时优先** |

V2 结构：

```jsonc
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "data": {
    "name": "林昭",
    "description": "……",
    "personality": "……",
    "scenario": "……",
    "first_mes": "……",
    "mes_example": "……",
    "creator_notes": "……",
    "system_prompt": "",
    "post_history_instructions": "",
    "tags": ["演示"],
    "creator": "……",
    "character_version": "1.0",
    "alternate_greetings": [],
    "extensions": {}
  }
}
```

V3（`chara_card_v3` / `3.0`）在此基础上多出 `data.assets`（内嵌表情等资源）等字段；酒馆写入时两个 chunk 都写，读取以 `ccv3` 为准。

**实现提示**：PNG tEXt 读写大约 60 行代码（`png` chunk 格式 + zlib + base64），本次验证里已经用 Python 写出来了（`make_card.py`）。
**许可证**：格式是公有的事实标准，但**不要直接抄酒馆的代码**（AGPL-3.0）。自己实现解析逻辑。

### 1.2 世界书（World Info / Lorebook）

纯 JSON，`entries` 是 `id -> 词条` 的字典。我把真实的默认世界书 dump 出来，单条词条字段是：

| 字段 | 作用 |
|---|---|
| `uid` / `displayIndex` | 标识与展示顺序 |
| `key` / `keysecondary` | 主关键词 / 次关键词 |
| `comment` | 备注（给人看的标题） |
| `content` | 命中时注入的正文 |
| `constant` | 常驻注入（不看关键词） |
| `selective` | 启用次关键词逻辑 |
| `order` / `position` / `depth` | 插入顺序、插入位置、插入深度 |
| `disable` | 停用 |
| `probability` / `useProbability` | 触发概率 |
| `group` / `groupOverride` / `groupWeight` / `useGroupScoring` | 分组互斥与权重 |
| `sticky` / `cooldown` / `delay` | 命中后保持轮数 / 冷却 / 延迟 |
| `role` | 以哪个角色身份注入（system/user/assistant） |
| `vectorized` | 是否参与向量召回 |
| `excludeRecursion` / `preventRecursion` / `delayUntilRecursion` | 递归扫描控制 |
| `scanDepth` / `caseSensitive` / `matchWholeWords` | 扫描深度、大小写、整词匹配 |
| `addMemo` / `automationId` | 备忘与自动化钩子 |

**这是提示词引擎里第二复杂的东西**（见 §3.3），字段多且互相影响。

### 1.3 会话记录

路径：`data/<用户>/chats/<角色名>/<会话名>.jsonl`，每行一个 JSON：

```jsonc
// 第 1 行：元数据
{ "chat_metadata": {}, "user_name": "unused", "character_name": "unused" }
// 之后每行：一条消息
{ "name": "林昭", "is_user": false, "send_date": "2026-09-21T13:00:00.000Z", "mes": "……", "extra": {} }
```

`is_user` 区分谁说的；`is_system` 用于旁白/事件；`extra` 放模型名、token 数等附加信息。

### 1.4 兼容策略

建议后端**直接支持导入/导出酒馆的目录结构**（`characters/*.png`、`worlds/*.json`、`chats/<角色>/*.jsonl`）：

- 用户从酒馆搬家零成本，这是你相对同类商业产品的差异化优势；
- 你自己的编辑器产出的卡也能被酒馆读，双向可用；
- 出问题时酒馆就是现成的调试台。

---

## 2. 提示词引擎（本方案最贵的一块）

### 2.1 为什么必须自建

酒馆的服务端**没有**提示词组装器。它的 `/api/backends/chat-completions/generate` 直接收下前端拼好的 `messages` 数组再转发给模型；服务端代码里搜 `world_info` / `lorebook` / `buildPrompt` **命中 0 次**。

真正做这件事的代码在浏览器里，规模是：

| 文件 | 行数 |
|---|---|
| `public/scripts/openai.js` | 7,396 |
| `public/scripts/world-info.js` | 6,408 |
| `public/scripts/sysprompt.js` | 264 |
| `public/scripts/itemized-prompts.js` | 399 |
| **合计** | **≈ 14,500 行 JS** |

而且它依赖 DOM 和全局状态，不能整块 `require` 到后端。所以：**要么移植，要么重写**。本方案建议重写一个"够用且可控"的引擎，按里程碑逐步逼近酒馆的效果。

### 2.2 最小可用提示词结构（M1 目标）

按顺序拼成一个 `messages` 数组：

| 顺序 | 内容 | 来源 |
|---|---|---|
| 1 | 主系统提示（"你扮演 X，不要代替用户说话……"） | 全局配置 |
| 2 | 角色描述 `description` | 角色卡 |
| 3 | 性格 `personality` | 角色卡 |
| 4 | 场景 `scenario` | 角色卡 |
| 5 | 对话示例 `mes_example`（解析 `<START>` 分段） | 角色卡 |
| 6 | 历史消息（滑窗，按 token 预算裁剪） | 会话 |
| 7 | `post_history_instructions`（越狱/风格指令，放最后权重最高） | 角色卡 |
| 8 | 本轮的 `user` 消息 | 请求 |

注意第 7 条的顺序很关键——酒馆社区的大量卡依赖"历史之后注入"这个特性。

### 2.3 世界书扫描（M3 目标）

简化版算法，按顺序：

1. 取最近 `scanDepth` 轮（或最近 N 条）消息文本，与每条词条的 `key` 做匹配（大小写、整词、正则选项）；
2. `constant: true` 的词条无条件命中；
3. `selective: true` 时，要求 `keysecondary` 按逻辑（AND / AND_ANY / NOT_ALL / NOT_ANY）也命中；
4. 按 `probability` 掷骰；
5. 命中的词条按 `position` + `depth` + `order` 插入（`depth 0` = 插到历史末尾之前，值越大越靠前）；`role` 决定以谁的身份注入；
6. `sticky` / `cooldown` 维持状态，`excludeRecursion` 等控制是否再用注入的正文递归扫描一轮；
7. 最后按 token 预算整体裁剪。

工程上建议：把这一层做成**纯函数**（输入：词条列表 + 消息列表 + 配置 → 输出：待注入条目），这样能用固定用例做快照回归。本次验证中我踩过一个"只在数据量足够大时才复现"的 bug，纯函数 + 快照测试能挡住这类问题。

### 2.4 记忆与长上下文（M5 目标）

分层推进，不要一上来做向量库：

1. **滑动窗口**：按 token 预算保留最近若干轮；
2. **滚动摘要**：每 N 轮把更早的对话压成一段摘要，固定注入（这就是酒馆内置 Memory 扩展做的事）；
3. **向量召回**：只在 1+2 不够时加，否则你会先花两周调 embedding，用户却感觉不到差别。

### 2.5 采样参数

`temperature` / `top_p` / `top_k` / `max_tokens` / `frequency_penalty` / `presence_penalty` / `stop` 按"用户默认 → 角色卡覆盖 → 单次请求覆盖"三级解析。

---

## 3. 模型网关

### 3.1 为什么不直接用酒馆的转发接口

| 问题 | 证据 |
|---|---|
| 需要酒馆会话 | 插件路由注册在 `requireLoginMiddleware` 之后（`src/server-main.js` 248 行 vs 313 行），未登录访问返回 **403**（已实测） |
| POST 还要 CSRF | 全局 `csrfSynchronisedProtection`（202 行），需带 `X-CSRF-Token` |
| 是内部接口、版本耦合 | 请求体直接映射各厂商参数，随酒馆版本变化 |
| 没有额度概念 | 只有登录失败限速，没有按用户计费/限流 |

所以模型调用必须在你自己的网关里完成。

### 3.2 网关职责

- **多厂商适配**：OpenAI 兼容优先（vLLM / One API / OpenRouter / DeepSeek / 硅基流动都兼容），Claude / Gemini 单独适配；
- **key 池与轮询**：多 key 分摊配额，单 key 失败自动切换；
- **重试与超时**：区分可重试（429/5xx/超时）与不可重试（400/内容拦截）；
- **SSE 透传**：流式不缓冲、不聚合，直接转发（注意别让压缩中间件把流缓冲了——酒馆的 `compression()` 阈值 1KB，短流能过、长流要小心）；
- **用量计量**：记录 prompt/completion token、耗时、模型名、用户 id —— **扣费点必须在这里**，绝不要放在前端；
- **审计**：谁在什么时候调了什么模型、花了多少。

---

## 4. 多租户 / 额度 / 隔离

酒馆的教训：它只有"登录失败限速"，没有额度。公网多用户会直接把账单烧穿且拦不住。所以额度是**必须自己做的**第一等公民。

| 关注点 | 建议 |
|---|---|
| 用户 | 账号 + 会话（JWT 或 httpOnly cookie），支持管理员/普通用户/被封禁 |
| 额度 | 按 token 计费；日配额 + 月配额 + 单次 `max_tokens` 上限；余额为 0 直接拒绝（不是超了再提醒） |
| 并发 | 每用户同时进行的流式请求数上限，防止一个人占满上游 |
| 熔断 | 全局日支出上限，触顶后降级到便宜模型或拒绝新请求 |
| 内容 | 上游返回被拦截时要有明确的用户提示，不要把 5xx 直接抛给前端 |
| 隔离 | 数据库行级（`owner_id`）为准；图片等大文件放对象存储；用户的卡默认私有，公开才进市场 |
| 反面清单 | 不要用"共享一个酒馆实例 + 多个账户"当多租户——那是同一个进程、同一份配置、没有配额 |

---

## 5. 前端接口契约

最小可用的一组（REST + SSE）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/characters` | 我的角色 + 订阅/公开角色，分页 |
| `GET` | `/api/characters/:id` | 角色详情（含卡 JSON） |
| `POST` | `/api/characters/import` | 上传 PNG/JSON 卡，落库并解析 |
| `POST` | `/api/chats` | 新建会话（角色 + 可选开场白索引） |
| `GET` | `/api/chats/:id/messages` | 历史消息，游标分页 |
| `POST` | `/api/chats/:id/messages` | 发消息，`Accept: text/event-stream` 时流式返回 |
| `POST` | `/api/chats/:id/regenerate` | 重新生成最后一条 |
| `DELETE` | `/api/chats/:id/messages/:mid` | 删除/编辑后重生成 |
| `GET` | `/api/me/usage` | 额度与用量 |

约定：
- 流式统一用 SSE（`data: {"delta":"…"}` + 结束事件带 usage），别用 WebSocket——反向代理和 CDN 友好得多；
- 所有写接口幂等（客户端生成 `request_id`），移动端弱网重试不会重复扣费；
- 版本前缀 `/api/v1`。

---

## 6. 平台功能（同类产品都有的那些）——最后做

按"离核心体验越远越晚做"排序：

1. **UGC 市场**：角色的公开/私有、审核、举报、搜索；
2. **榜单**：日/周/月/总榜 —— 用**增量聚合表**（每次会话/点赞/收藏写一条事件，定时 rollup），不要实时全表扫；
3. **积分/充值/邀请/签到**：支付渠道 + 账本（所有余额变动走不可变流水，别直接改余额字段）；
4. **论坛/小说**：独立模块，别和角色系统耦合；
5. **App**：直接复用 §5 的 API，不要另开一套。

先不做这些也能上线——这类产品的核心体验是"能聊天 + 角色卡好看"，不是榜单。

---

## 7. 部署与运维

直接复用已经打磨好的那套（Caddy + Docker + 只读根文件系统 + 备份与校验 + 定时备份 + 自检脚本），把服务换成你的应用即可：

- 对外只开 80/443，应用端口绑回环；
- Caddy 以普通用户运行，避免 root 属主文件（否则备份读不到、卸载删不掉——这个坑在部署包里已经踩过并修好）；
- 每日备份 + `sha256` 校验 + 定期做一次**真实恢复演练**；
- 上线前把 `check.sh` 那套自检沿用过来（健康检查 + 经反代的真实请求）。

---

## 8. 里程碑与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0** | 数据兼容层 | 能把酒馆的 `characters/*.png`、`worlds/*.json` 原样导入并列出；导出的卡能被酒馆读回 |
| **M1** | 单用户对话（非流式） | 用 §2.2 的最简提示词结构，能围绕一张卡连续对话 20 轮不串味 |
| **M2** | 流式 + 会话持久化 | SSE 逐字输出；刷新页面能恢复历史；中断可重试且不重复扣费 |
| **M3** | 世界书 | 导入的酒馆世界书能按 §2.3 生效（关键词命中、`depth`/`order` 插入位置肉眼可验证） |
| **M4** | 多用户 + 额度 | 两个账号数据互不可见；额度耗尽后请求被拒；用量可查 |
| **M5** | 摘要记忆 | 长对话（100+ 轮）不丢早期关键信息 |
| **M6** | 市场/积分 | 角色可公开、可搜索；积分流水可对账 |

**为什么这个顺序**：M0 就能立刻带来用户价值（搬家），M1-M2 是能不能用的分水岭，M3 才是"像酒馆"的分水岭。**不要把 M3 之前的进度拿去和成熟商业产品比体验。**

---

## 9. 风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| 提示词引擎被低估 | 酒馆那块是 1.45 万行，逐步逼近会持续消耗时间 | 按里程碑交付；M1 先用最简结构跑通 |
| 与上游生态脱节 | 酒馆的卡格式会演进（V2→V3→CharX） | 只依赖格式不依赖代码；保留导入导出双向验证 |
| 许可证 | 酒馆是 AGPL-3.0，抄代码会传染 | 自己实现格式解析；只借鉴行为，不复制实现 |
| 模型成本失控 | 多用户 + 长上下文 = 账单 | 额度、单次上限、全局熔断、用量看板（§4） |
| 合规 | 商业化 + NSFW 涉及支付与内容合规 | 技术方案之外，自行评估；个人自用与对外经营是两回事 |

---

## 10. 技术栈建议

| 层 | 建议 | 理由 |
|---|---|---|
| 后端 | **Go**（或 Node/TypeScript） | Go 部署简单、并发与 SSE 稳；Node 的优势是能复用 JS 生态与 PNG 解析 |
| 数据库 | PostgreSQL | 账本、聚合表、行级隔离都顺手 |
| 缓存/队列 | Redis | 限流计数、榜单 rollup、任务队列 |
| 文件 | S3 兼容对象存储 | 角色卡 PNG、生成图片 |
| 前端 | Next.js | 与同类商业产品同代技术栈，SSR + 流式渲染成熟 |
| 向量（可选，M5 以后） | pgvector | 先用数据库自带能力，别急着上独立向量库 |

目录草案：

```
backend/
  cmd/api/            入口
  internal/
    assets/           角色卡 PNG/JSON 读写、世界书、导入导出
    prompt/           提示词引擎（纯函数 + 快照测试）
    gateway/          模型网关（provider 适配、key 池、计量）
    auth/             账号、会话、额度
    chat/             会话与消息
    market/           市场、榜单、审核（M6）
  migrations/
web/                  Next.js 前端
```

---

## 附：验证依据

本方案的结论来自对本机部署的 SillyTavern 1.19 的真实核对与实验，不是推测：

1. 服务端无提示词组装：`src/endpoints/backends/chat-completions.js` 的 `/generate` 直接使用 `request.body.messages`；服务端搜 `world_info|lorebook|buildPrompt` 命中 0 次。
2. 客户端组装逻辑规模：`openai.js` 7,396 行、`world-info.js` 6,408 行（GitHub release 分支实测行数）。
3. 插件路由需登录：`src/server-main.js` 中 `requireLoginMiddleware`（248 行）在 `loadPlugins`（313 行）之前；实测未登录访问插件路由返回 **403**。
4. 格式：世界书词条字段来自真实文件 dump；聊天 JSONL 结构来自 `src/endpoints/chats.js`；角色卡来自 PNG `chara` chunk 的读写实验（本方案附带的 `make_card.py` 生成的卡被酒馆正常识别）。
5. 端到端验证：用一个最小服务端插件跑通"读卡 → 自建提示词 → 调模型 → 返回"，流式 SSE 可用；发送给模型的消息数是 **2 条**，而酒馆"自己的味道"在那 1.45 万行里。
