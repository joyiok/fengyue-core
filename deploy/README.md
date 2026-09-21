# 部署 story-core

单机 Docker Compose：一个 `story-core` 容器 + 一个 `web` 容器（网页客户端）+ 一个 Caddy
（自动 HTTPS）。运行时状态都在本目录（`data/`、`caddy/`、`backups/`、`.env`），代码在
仓库里，两者分开。

## 前置

- Docker Engine 24+ 与 Compose v2
- 一个解析到本机的域名（自动证书需要它）；只想本地试就用 `APP_DOMAIN=:80`
- 对外只开 80/443，应用端口只绑回环

## 首次部署

```bash
git clone https://github.com/joyiok/story-core.git /opt/story-core
cd /opt/story-core/deploy

cp .env.example .env
chmod 600 .env
$EDITOR .env                 # 至少填 APP_DOMAIN，以及模型的三项

# data/ 与 caddy/ 必须由容器运行时的 uid 拥有（.env 里的 PUID:PGID）
mkdir -p data caddy/data caddy/config backups
sudo chown -R 1000:1000 data caddy backups

docker compose up -d --build
./check.sh
```

`docker compose up -d --build` 会在本机构建两个镜像：`story-core` 只是把 `src/` 复制进
`node:22-alpine`（运行时零依赖，没有构建步骤），`web` 会跑一次 `next build` 产出
standalone 包。不需要拉取任何私有镜像。

## 第一个账号

开启账号后（`STORY_AUTH=on`），**第一个注册的账号自动成为管理员**。直接打开域名，页面
会把它送到 `/register`。

不想用浏览器也可以：

```bash
curl -sS -X POST https://你的域名/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"handle":"owner","password":"一个足够长的密码"}'
```

响应里的 `token` 是给脚本用的 `Authorization: Bearer <token>`（网页端走服务端下发的会话
cookie，不需要自己存）。注册完可以按需把 `STORY_ALLOW_REGISTRATION` 改成 `off`
（`docker compose up -d` 生效）。

Caddy 把 `/` 给了网页客户端，所以接口那个自述页只在应用端口
（`http://127.0.0.1:8787/`）上直接可见。

## 模型网关

**配置在数据库里，不在 `.env` 里**——改完立刻生效，不用重建容器：

```bash
cd /opt/story-core/deploy
docker compose exec -T story-core node --disable-warning=ExperimentalWarning \
  src/cli.ts --root /data settings set model.endpoint https://api.deepseek.com/v1/chat/completions
docker compose exec -T story-core node --disable-warning=ExperimentalWarning \
  src/cli.ts --root /data settings set model.name     deepseek-chat
docker compose exec -T story-core node --disable-warning=ExperimentalWarning \
  src/cli.ts --root /data settings set model.apiKey   sk-...
```

或者注册完管理员账号后在网页端改：**账户 → 设置 → 模型网关**。

没配也能跑：账号、角色卡、世界书、市场都正常，只是发一轮对话会返回 `503`，启动日志里也会
直说「model: not configured」。

同样的规则适用于额度、积分、市场开关、摘要、注册开关、会话时长、监听端口——全部是
`settings` 表里的行。**`.env` 只放基础设施**（数据在哪、域名、证书联系人、容器 uid、备份
份数），见 [`.env.example`](.env.example) 顶部那段说明。唯一的例外是标了「重启」的三项：
`auth.enabled`、`server.host`、`server.port`。

## 更新

```bash
cd /opt/story-core && git pull
cd deploy && docker compose up -d --build && ./check.sh
```

`data/` 与 `.env` 是 gitignore 的，`git pull` 不会碰它们。数据库迁移在启动时自动跑。

**改了 `Caddyfile` 就必须重建 caddy 容器**：它是以单文件 bind mount 挂进去的，挂的是
inode；`git pull` 会用新文件覆盖旧文件，容器里那份就停在旧 inode 上，`docker compose
up -d` 也看不出配置变了（它比较的是 compose 配置，不是挂载文件的内容）。现象是网页照常
打开但走的还是旧路由。所以 Caddyfile 有变更时多走一步：

```bash
cd deploy && docker compose up -d --no-deps --force-recreate caddy
docker compose exec caddy md5sum /etc/caddy/Caddyfile && md5sum Caddyfile   # 两个要一样
```

`caddy reload` 解决不了这个——它重读的是容器里那份旧文件。

如果以 root 身份 `git pull`，新拉下来的文件会属于 root，而 `data/` 与 `caddy/` 属于
`PUID:PGID`——两套属主混在一起正是让备份脚本读不到证书的那类坑。拉完顺手统一：

```bash
chown -R 1000:1000 /opt/story-core
```

## 备份

```bash
./backup.sh                    # 生成 backups/story-core-<时间戳>.tar.gz 与 .sha256
```

归档内容：`data/`（SQLite 库 + 每个用户的角色卡/会话）与 `.env`（模型 key）。
**两者都是机密**（库里有密码哈希），所以归档权限是 600，不要放到公开位置。

定时备份：

```bash
sudo cp systemd/story-core-backup.{service,timer} /etc/systemd/system/
sudo nano /etc/systemd/system/story-core-backup.service   # 改成你的路径和属主
sudo systemctl daemon-reload
sudo systemctl enable --now story-core-backup.timer
systemctl list-timers story-core-backup.timer
```

保留份数由 `.env` 里的 `BACKUP_KEEP` 决定（默认 14）。

### 恢复

```bash
cd /opt/story-core/deploy
docker compose down
sha256sum --check backups/story-core-<时间戳>.tar.gz.sha256
tar -xzf backups/story-core-<时间戳>.tar.gz      # 恢复 data/ 与 .env
docker compose up -d
./check.sh
```

## 已知取舍

- **备份是崩溃一致的，不是在线一致的。** 备份时服务可能正在写库；SQLite 用 WAL，归档里
  也包含 `-wal`/`-shm`，所以恢复后它会像断电重启那样正常回放或回滚。要一份"按构造就是
  干净"的快照，就在备份前停栈：`docker compose down && ./backup.sh && docker compose up -d`。
- **Caddyfile 里只压缩 JSON**，并且给 `reverse_proxy` 设了 `flush_interval -1`。这两条都是
  为了 SSE：压缩或缓冲 `text/event-stream` 会让逐字输出变成一坨。
- **路由全部写在一个 `route` 块里**，所以 `/api/*`、`/health`、其余的优先级是写死的。不这样做的话 Caddy 会按指令种类排序，“这两个代理哪个先匹配上”就不再显而易见。
- **`/api/*` 不经过 web 容器**。生产里网页客户端根本收不到接口请求，它自带的那个
  代理路由只是 `next dev` 用的。
- **应用容器是只读根文件系统**，只有 `data/`、`/tmp` 可写；`web` 同理，只多 `/app/.next/cache`（Next 的构建缓存）；Caddy 只有 `caddy/`。
- **`check.sh` 不注册账号。** 实例里一个账号都没有时，“第一个注册的就是管理员”这一步必须由你自己做，脚本只验路由、页面和健康。
