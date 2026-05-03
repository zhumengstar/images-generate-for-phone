# images-generate Docker 部署

## 1. 准备环境变量

复制示例文件：

```bash
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
APP_PORT=8000
NEXT_PUBLIC_DEFAULT_AUTH_KEY=your_secret_key_here
CHATGPT2API_AUTH_KEY=your_secret_key_here
IMAGE_PROXY_BASE_URL=http://165.154.254.130:3000
IMAGE_PROXY_IP_QUOTA_LIMIT=20
```

`NEXT_PUBLIC_DEFAULT_AUTH_KEY` 会在前端构建时写入页面，用于免登录生成图片。

## 2. 启动

```bash
docker compose up -d --build
```

访问：

```text
http://localhost:8000/image/
```

## 3. 常用命令

```bash
docker compose logs -f
docker compose restart
docker compose down
```

数据默认保存在本机 `./data` 目录。
