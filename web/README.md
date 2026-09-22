# story-web

story-core 的网页客户端。后端只出 JSON 与 SSE，这一层负责看：角色卡、世界书、对话、
市场、积分与额度。

## 跑起来

```bash
npm install
npm run dev            # http://localhost:3000，接口默认指向 http://127.0.0.1:8787
```

先起后端（见 [`../README.md`](../README.md)）：

```bash
cd .. && STORY_AUTH=on STORY_DATA_ROOT=./data STORY_DB=./data/story.sqlite \
  STORY_MODEL_ENDPOINT=… STORY_MODEL_NAME=… STORY_MODEL_API_KEY=… \
  node --disable-warning=ExperimentalWarning src/server.ts
```

接口地址用 `STORY_API_BASE` 覆盖：

```bash
STORY_API_BASE=http://127.0.0.1:9999 npm run dev
```

## 页面

| 路径 | 是什么 |
|---|---|
| `/login` `/register` | 账号。第一个注册的账号是管理员 |
| `/chats` | 会话列表（按最后一条时间倒序）+ 新建会话（选角色、选开场白） |
| `/chats/:cardId/:chatName` | 对话：流式输出、停止、重新生成、删单条、删会话，以及「这一轮发出去了什么」的调试面板 |
| `/characters` | 角色库：导入 PNG/JSON 卡、新建 |
| `/characters/:id` | 编辑卡、换头像、导出 PNG、发布/下架、删角色 |
| `/worldbooks` `/worldbooks/:id` | 世界书：导入/新建/删除，逐词条编辑命中与插入的那几个字段 |
| `/market` `/market/:ownerId/:characterId` | 市场与榜单：搜索、收藏、导入 |
| `/account` | **你自己的**账户：积分（签到/邀请/流水）、额度（日月/单次/熔断/用量流水）、收藏 |
| `/admin` | **管理区**（独立路由树与导航，仅管理员）概览：模型是否配好、账号数、今日/本月 tokens、积分与市场 |
| `/admin/settings` `/admin/users` | 全部配置（改完即生效）、账号与限额 |

## 三条实现上的规矩

**一、流式不能被缓冲。** `app/api/v1/[...path]/route.ts` 把上游响应体原样交给
`Response`，中间不攒。实测经这一层与直连后端的逐字到达时间一致（9 帧 / 490ms）。
`lib/sse.ts` 自己解析 SSE 而不是用 `EventSource`——后者不能 POST，而发一轮对话要有
body。解析器容忍 CRLF、心跳注释行和非 JSON 的 `data:` 行。

**二、一轮没落盘就不算发生。** 后端是原子的：模型完全成功才把用户消息和回复一起写进
日志。所以这里在流式期间把那一段放在 `pending` 里，收到 `done` 才变成真消息；失败或
按「停止」就什么也不留，草稿放回输入框。这与日志的行为一一对应，不会出现"页面上有一
条、文件里没有"。

**三、`requestId` 是一次"说这句话"的尝试。** 同一句话重试会复用同一个 id，服务端因此
能直接返回它已经生成好的回复而不是再调一次模型、再扣一次费。文本一改就换新 id。

## 部署时它在哪

生产环境 Caddy 把 `/api/*` 与 `/health` 直接反代给 story-core（见
[`../deploy/Caddyfile`](../deploy/Caddyfile)），其余给这个容器。所以**生产里这一层根本
收不到 `/api` 请求**，那个代理路由只是本地开发用的——两处都转发字节、不改写、不缓冲。

镜像用 `output: 'standalone'`，最终镜像里没有 `node_modules`：

```bash
docker build -t story-web:local .
docker run --rm -p 3000:3000 -e STORY_API_BASE=http://host:8787 story-web:local
```

## 已知取舍

- **世界书只编辑决定"是否命中、插到哪"的那些字段**（关键词、常驻、次关键词、概率、
  顺序、位置、深度、扫描深度、sticky/cooldown/delay、role），其余字段原样保留，所以
  更新版本的酒馆写的书在这里过一遍不会掉东西。分组评分、向量召回没做（后端也没做）。
- **新建会话时不能"关掉"世界书。** 接口的 `worldbookIds` 传空数组会退回角色卡的
  primary world，没有"一本都不要"这个表达。界面上只显示会生效哪一本。
- **消息不能"编辑后重生成"成两条路径。** 改写就是「删掉那条 + 重新生成时带上改后的
  用户消息」，被替换的回答留在 `extra.story.previousReplies` 里，不丢。
- **配置不走 `.env`。** 「设置」面板编辑的是数据库里的 `settings` 行，保存即生效——这正是
  它存在的理由：模型 key 和额度以前要改 `.env` 再重启容器。密钥显示为打码，只有重新输入
  才会提交，所以一次保存永远不会把 key 覆盖成自己的掩码。
- **管理员面板只做常用三件事**（额度、加积分、停用/启用）。其余运维走 `src/cli.ts`。
