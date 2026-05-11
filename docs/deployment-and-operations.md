# 部署与运维

## 本地启动

后端依赖 Python 3.13 和 `uv`：

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 8000
```

前端开发：

```bash
cd web
npm run dev:local
```

Docker 本地：

```bash
docker compose -f docker-compose.local.yml up -d --build
```

默认访问：

```text
http://127.0.0.1:8000/image
http://127.0.0.1:8000/users
http://127.0.0.1:8000/version
```

## Docker 部署

主 Compose 文件：

```text
docker-compose.yml
```

关键配置：

```yaml
ports:
  - "${APP_PORT:-8000}:80"
volumes:
  - ./data:/app/data
  - ./config.json:/app/config.json
```

这两个 volume 是防止数据丢失的关键。重新构建镜像不会覆盖宿主机的 `data/` 和 `config.json`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `8000` | 宿主机端口。 |
| `CHATGPT2API_AUTH_KEY` | 空 | 管理密钥，优先于 `config.json`。 |
| `CHATGPT2API_BASE_URL` | 空 | OpenAI 兼容上游地址。 |
| `IMAGE_PROXY_BASE_URL` | `https://generate.muling.store` | 图片源站。 |
| `IMAGE_PROXY_IP_QUOTA_LIMIT` | `20` | 兼容旧变量的用户默认额度来源。 |
| `IMAGE_PROXY_USER_QUOTA_LIMIT` | 空 | 用户默认图片额度。 |
| `IMAGE_PROXY_GUEST_QUOTA_LIMIT` | 空 | 访客默认图片额度。 |
| `IP_IMAGE_TASK_MAX_WORKERS` | `80` | 图片任务全局并发。 |
| `MAX_OWNER_QUEUED_IMAGE_TASKS` | `4` | 单个 owner 排队上限。 |
| `IMAGE_PROXY_TIMEOUT` | `240` | 图片源站超时秒数。 |
| `IMAGE_PROXY_RETRIES` | `2` | 源站失败重试次数。 |
| `STORAGE_BACKEND` | `json` | 账号池存储后端。 |
| `DATABASE_URL` | 空 | 数据库存储连接。 |
| `IMAGE_PROMPT_POLISH_BASE_URL` | 源站 `/v1` | AI 润色接口地址。 |
| `IMAGE_PROMPT_POLISH_MODEL` | `gpt-5.5` | AI 润色模型。 |
| `IMAGE_PROMPT_POLISH_API_KEY` | 空 | AI 润色密钥。 |

## 远程部署信息

当前已知远程环境：

| 项 | 值 |
| --- | --- |
| 服务器 | `root@165.154.254.130` |
| 项目目录 | `/root/images-generate-for-phone` |
| 容器 | `images-generate` |
| 镜像 | `images-generate:latest` |
| 端口 | `8808 -> 80` |

之前部署方式是同步选定代码文件并在远程 Docker 构建，不应假设远程一定是干净的 `git pull` 工作流。部署前必须检查远程工作树和数据文件。

## 部署前备份

推荐备份命令：

```bash
cd /root/images-generate-for-phone
mkdir -p backups
tar -czf backups/pre-deploy-data-config-$(date +%Y%m%d%H%M%S).tar.gz \
  data config.json .env docker-compose.yml Dockerfile
```

最近一次已知备份：

```text
/root/images-generate-for-phone/backups/pre-deploy-data-config-20260506073619.tar.gz
```

## 安全部署步骤

1. 本地确认 `git status --short --branch`。
2. 本地运行后端语法检查和前端构建。
3. 本地确认版本号和发布说明。
4. SSH 到远程检查磁盘、容器、数据文件大小。
5. 备份远程 `data/`、`config.json`、`.env` 和部署配置。
6. 只同步代码和构建相关文件，不覆盖远程运行数据。
7. 远程重新构建镜像。
8. 重启容器。
9. 验证 `/version`、登录、用户管理、额度和图片任务。

## 回滚

数据回滚：

```bash
cd /root/images-generate-for-phone
tar -xzf backups/pre-deploy-data-config-YYYYMMDDHHMMSS.tar.gz
docker compose up -d app
```

镜像回滚取决于是否在部署前给旧镜像打标签。建议部署前执行：

```bash
docker tag images-generate:latest images-generate:backup-$(date +%Y%m%d%H%M%S)
```

## 运维检查

基础健康：

```bash
curl -s http://127.0.0.1:8808/version
docker ps --filter name=images-generate
docker logs --tail=100 images-generate
```

资源监控：

```bash
docker stats images-generate
top
free -h
df -h
```

Nginx 监控应关注：

- `access.log` 请求状态码。
- `error.log` 是否有 upstream timeout 或 client closed request。
- `proxy_read_timeout` 是否小于图片生成最长耗时。
- `client_max_body_size` 是否满足多图编辑上传。

## 常见问题

### 手机端请求失败

优先检查：

- 前端 API 地址是否写死 `localhost`。
- 部署服务器域名、端口、协议是否一致。
- Nginx 是否正确转发 `/api/`、`/auth/`、`/images/`。
- HTTPS 页面是否请求了 HTTP 接口导致混合内容被拦截。

### 图片加载失败

优先检查：

- `/images/...` 静态挂载是否可访问。
- `data/images` 是否挂载到容器。
- 图片 URL 是否来自允许的源站。
- 代理缓存是否写入 `data/images/proxy-cache`。
- Nginx 是否缓存了旧资源。

### 连接断开

长耗时生成场景应检查：

- 浏览器请求超时。
- Nginx `proxy_read_timeout`、`proxy_send_timeout`。
- 容器内 `IMAGE_PROXY_TIMEOUT`。
- 图片源站排队时间。
- 前端是否使用任务轮询而不是长时间阻塞直接请求。

### 额度没有增加或统计不准

检查：

- `data/ip_image_quotas.json` 是否写入。
- `data/ip_image_tasks.json` 成功任务是否包含 `quota_key` 和 `data`。
- 用户是否刚从访客迁移，访客 key 是否正确转为用户 key。
- 管理员或无限额度用户是否按规则不增加次数。

