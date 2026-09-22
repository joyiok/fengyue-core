# AGENTS.md

在这个仓库里动手之前先读这一份。分工是：[`README.md`](README.md) 讲**有什么**，
[`docs/architecture.md`](docs/architecture.md) 讲**为什么这么设计、代价是什么**，这里讲
**必须遵守的规矩**和**怎么验**。

下面每条都带「不要这样做」，因为每一条都是会被顺手做错的事。

---

## 改完必须跑

```bash
npm run typecheck && npm test                 # 后端，224 项
cd web && npx tsc --noEmit && npm run build   # 前端
```

两条都要绿。跳过的 2 项是需要真实酒馆目录的交叉验证（`SILLYTAVERN_LIBRARY=… npm test`
才会跑），可以留着跳过。

没有测试的改动不算完成。新的行为要有新的断言，修过的 bug 要留下一条会红的测试。

---

## 规矩

### 1. 管理员功能单独成块，不要塞进别的地方

跑这个服务（运营者）和用这个服务（用户）是两件事，混在一个屏幕上就会有人在找自己余额的
时候改掉生产额度。

- **界面**：`web/app/(app)/admin/` 是一棵自己的路由树，有自己的 layout 与导航。不要把设置、
  用户管理塞进 `/account` 或任何用户页面。
- **接口**：`/api/v1/admin/*` 一个命名空间。**角色校验只有一处**，在 `src/server.ts` 的 admin
  块顶部，管理类路由全部写在它里面。
- **导航**：管理入口在侧栏单独一块（有分隔线和「管理」标签），不是列表里的一条。

> 不要这样做：在 `/api/v1/characters/:id` 里加一个「管理员可以删别人的角色」分支。那条分支
> 迟早会漏掉校验——这正是「一个命名空间、一处校验」要防的事。

### 2. 配置：环境变量说数据在哪，`settings` 表说服务怎么跑

`env` 只剩 `STORY_DB`、`STORY_DATA_ROOT`、`STORY_LIBRARY_ROOT`。其余一切（模型网关、额度、
积分、市场、摘要、注册开关、监听端口）都是 `settings` 表里的一行。

- 环境变量**只在某个键还没有值时填一次**，之后行就是真相。改 `.env` 对在跑的实例无效——这是
  目的，不是缺陷。
- 不要再加环境变量。要加一个可调项就走「加一个设置项」那一节。
- 读取**不缓存**：CLI 在服务运行时改的值必须立刻可见。每次读是一次主键查找，代价是微秒。
- 密钥走 HTTP 一律打码（`maskSecret`），只有 CLI 显示原文。写入只有「提交新值」一条路，这样
  一次保存不可能把 key 覆盖成它自己的掩码。

> 不要这样做：`process.env.STORY_XXX` 直接读一个业务配置，或者把启动值算出来当「当前值」——
> 「启动值」是行的历史（`boot_value` 一列），不是看的人的环境。算出来会让 `reset` 写错东西。

### 3. 流式不能被缓冲

逐字输出是产品的核心体验，被缓冲一次就表现为「模型卡住了」。

- SSE 响应必须带 `Cache-Control: no-cache, no-transform` 与 `X-Accel-Buffering: no`
- 反代必须 `flush_interval -1`，且**不能**压缩 `text/event-stream`
- 前端代理（`web/app/api/v1/[...path]/route.ts`）只转发字节，不改写、不攒
- 改到任何一条路径上的转发逻辑，就重测一次逐字到达时间：直连与经代理应当一致

### 4. 一轮是原子的

用户消息和回复**一起**落盘，模型完全成功才写。中途失败或中断，日志原封不动。

> 不要这样做：先写用户消息、成功了再补回复。那会让一次失败留下半截对话，而下一轮的提示词
> 组装会读到它。

界面要跟着一样：流式期间那一段只活在 `pending` 里，收到 `done` 才变成真消息；失败就什么也
不留，草稿放回输入框。

**改一条消息的内容不是一轮**（`PATCH …/messages/:index`）：不调模型、不计费、不需要原子性。
而「换一种说法」是 `regenerate` 带 `message`，它改的是最后那条回答在回答谁，被替换的回答
留在 `previousReplies` 里。这两件事是不同的动作，所以是两个接口——不要合并它们。

### 5. `requestId` 是一次「说这句话」的尝试

同一句话重试复用同一个 id，服务端因此能返回它已经生成好的回复，而不是再调一次模型、再扣一
次费。文本一改就换新 id。每条助手消息都记着产出它的 requestId，这挡的是「客户端没收到流结
束、但服务端其实已经完成并保存」这种模糊失败。

### 5b. 跑过的迁移是冻住的，只能往后面追加

`MIGRATIONS` 里每一条都只在**第一次**启动时执行一次，版本号记在 `schema_migrations` 里。
**往一个已经跑过的版本里补语句，它在已部署的库上永远不会执行**——而测试库是全新的、按顺序
跑全部迁移，所以看起来完全健康。这个 bug 的形状是：测试绿、自检绿、线上缺表，直到有人
第一次用到那张表才炸。

> 不要这样做：在 `version: 4` 的语句列表里加一句 `CREATE TABLE`。**加一个新的 `version`。**
> 哪怕是修旧账，也用 `CREATE TABLE IF NOT EXISTS` 追一条新的（见 v7 就是这么修的）。

部署后值得核一下：

```bash
python3 -c "import sqlite3;db=sqlite3.connect('file:data/story.sqlite?mode=ro',uri=True);print(db.execute('select max(version) from schema_migrations').fetchone())"
```

### 6. 账本只追加

`usage_ledger` 与 `credit_ledger` 都是不可变流水，余额与用量一律 `SUM` 出来。

> 不要这样做：加一个可变的 `balance` 字段然后原地更新。它一定会漂，而且漂了没人能对账。
>
> 同理，**删用户要「注销」而不是「删除」**：`AuthService.anonymize` 释放用户名、废掉密码、吊销会话、
> 删掉库，但账本一行不动。硬删会连账本一起 cascade 掉，让运营者对的每一笔账都悄悄变小——
> 那正是账本存在的理由要防的事。举报记录同理：「处理」不等于「删除」。

**预留也是行**（`reservations` 表，带 `expires_at`），不是进程里的 Map。放在内存里时，一次重启
会把还在飞的请求的预留忘掉——而那正是「十个并发请求一起超支」的保护，重启会把它变弱。
过期是为了让崩溃的那一轮不会永远占着额度。

请求**先预留、再调用**，结算时用真实用量替换预留。失败/中断的轮次不写流水（用户没拿到东西），
但预留照常占用额度。

### 7. 后端运行时零依赖

PNG 用内置 `zlib`，HTTP 用内置 `node:http`，SQLite 用内置 `node:sqlite`，测试用内置
`node:test`。`package.json` 的 `dependencies` 必须是空的。

> 不要这样做：「就加一个小包」。前端（`web/`）不受这条约束，它是 Next.js。

### 8. 只借鉴酒馆的行为，不碰它的代码

SillyTavern 是 AGPL-3.0，抄实现会传染本仓库。字段语义、插入位置、匹配规则可以照它的**行为**
做（并且要写测试钉住），代码不能看、不能复制。格式是事实标准，代码不是。

### 9. 删除是破坏性的，界面必须二次确认

删角色会连带删掉打不开的那些会话；删会话没有回收站。所有删除走 `components/ui.tsx` 的
`ConfirmButton`。

---

## 加一个设置项

1. `src/settings/schema.ts` 加一条 spec（`description` 会直接显示在界面上，用英文写清楚它管什么）
2. `src/config.ts` 的 **`appConfigFrom` 和 `appConfigToValues` 两处都要加**
3. `web/components/SettingsPanel.tsx` 的 `LABELS` 加中文名

漏掉第 2 步不会编译报错，但那一行会永远躺在表里没人读——所以 `test/settings.test.ts` 有一条
断言映射对 schema 是**全覆盖**的，漏了就红。这是设计的，别删那条断言。

重启才生效的项标 `restart: true`，界面上会直说。目前只有 `auth.enabled`（还决定数据目录布局）
和 `server.host` / `server.port`。

---

## 部署

```bash
cd /opt/story-core && git pull && chown -R 1000:1000 .
cd deploy && docker compose up -d --build && ./check.sh
```

两个踩过的坑：

- **改了 `Caddyfile` 必须 `docker compose up -d --no-deps --force-recreate caddy`**。它是单文件
  bind mount，挂的是 inode；`git pull` 用新文件覆盖旧文件后容器里那份停在旧 inode 上，而
  `docker compose up -d` 比较的是 compose 配置、不是挂载文件内容，`caddy reload` 重读的也还是
  旧文件。现象是网页照常打开但走的还是旧路由，很难一眼看出来。重建后比对两边 md5。
- **CLI 的纯数据库命令不要碰文件系统**（`user` / `settings` / `model`）。容器里只有 `/data`
  可写，`ensureDirs` 直接 ENOENT。

`check.sh` 每次部署后都要跑，它验的是「经反代的真实请求」而不是「容器起来了」。

---

## 词汇表

| 说法 | 指什么 |
|---|---|
| 一轮（turn） | 一次用户消息 + 一次回复，落盘时是一对 |
| 额度（quota） | 运营者的上限，保护账单，超了是 402 |
| 积分（credits） | 用户的余额，花完也是 402 但 `insufficient_credits` |
| 启动值（boot value） | 某一行刚被写进来时的值，`reset` 写回它 |
| primary world | 角色卡 `data.extensions.world` 指向的世界书，酒馆的关联机制 |
