# 部署 story-core

单机 Docker Compose：一个 `story-core` 容器 + 一个 Caddy（自动 HTTPS）。运行时状态都在
本目录（`data/`、`caddy/`、`backups/`、`.env`），代码在仓库里，两者分开。

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

`docker compose up -d --build` 会在本机构建镜像（没有构建步骤，只是把 `src/` 复制进
`node:22-alpine`），不需要拉取任何私有镜像。

## 第一个账号

开启账号后（`STORY_AUTH=on`），**第一个注册的账号自动成为管理员**：

```bash
curl -sS -X POST https://你的域名/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"handle":"owner","password":"一个足够长的密码"}'
```

响应里的 `token` 就是后续所有请求的 `Authorization: Bearer <token>`。注册完可以按需
把 `STORY_ALLOW_REGISTRATION` 改成 `off`（`docker compose up -d` 生效）。

没有账号时，`GET /` 会返回这个服务是什么、有哪些接口，以及"下一步该注册"的提示。

## 模型网关

`STORY_MODEL_ENDPOINT` 要指向一个 OpenAI 兼容的 `/chat/completions`，例如：

```bash
STORY_MODEL_ENDPOINT=https://api.deepseek.com/v1/chat/completions
STORY_MODEL_NAME=deepseek-chat
STORY_MODEL_API_KEY=sk-...
```

没配也能启动：账号、角色卡、世界书、市场都正常，只是发一轮对话会返回 `503`。改完
`.env` 后 `docker compose up -d` 重建容器即可。

## 更新

```bash
cd /opt/story-core && git pull
cd deploy && docker compose up -d --build && ./check.sh
```

`data/` 与 `.env` 是 gitignore 的，`git pull` 不会碰它们。数据库迁移在启动时自动跑。

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
- **应用容器是只读根文件系统**，只有 `data/`、`/tmp` 可写；Caddy 同理，只有 `caddy/`。
