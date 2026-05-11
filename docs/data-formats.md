# 数据格式

运行数据默认存放在 `data/`，部署时通过 Docker 卷挂载到容器 `/app/data`。这些文件是生产数据，更新代码或重新构建镜像时不能覆盖。

## 运行配置

### `config.json`

常用字段：

| 字段 | 说明 |
| --- | --- |
| `auth-key` | 后端管理密钥。也可使用环境变量 `CHATGPT2API_AUTH_KEY`。 |
| `base_url` | 上游 OpenAI 兼容基础地址。也可使用 `CHATGPT2API_BASE_URL`。 |
| `proxy` | 出站代理配置。 |
| `refresh_account_interval_minute` | 账号刷新间隔，默认 5。 |
| `image_retention_days` | 本地图片保留天数，默认 30。 |
| `guest_image_quota_limit` | 访客默认图片额度，默认 5。 |
| `user_image_quota_limit` | 普通用户默认图片额度，默认 20。 |
| `auto_remove_invalid_accounts` | 是否自动移除无效账号。 |
| `auto_remove_rate_limited_accounts` | 是否自动移除限流账号。 |
| `log_levels` | 日志级别过滤。 |

### `VERSION`

纯文本版本号，例如：

```text
1.1.7
```

## 用户文件

### `data/web_users.json`

顶层结构为用户对象列表：

```json
[
  {
    "id": "user-id",
    "username": "demo",
    "name": "demo",
    "role": "user",
    "salt": "...",
    "password_hash": "...",
    "sessions": {
      "device-fingerprint": "issued-token-or-session"
    },
    "device_fingerprint": "device-fingerprint",
    "quota_limit": 20,
    "quota_package": "7d-100",
    "quota_package_base_limit": 9999,
    "quota_expires_at": "2026-05-18T00:00:00+00:00",
    "created_at": "2026-05-11T00:00:00+00:00",
    "last_used_at": "2026-05-11T00:00:00+00:00"
  }
]
```

兼容规则：

- `quota_package`、`quota_package_base_limit`、`quota_expires_at` 是可选字段，旧数据没有也能读取。
- `role` 只接受 `admin`、`user`、`guest`，异常值会按普通用户处理。
- 管理员 `admin` 会在服务启动或用户服务初始化时确保存在。
- 访客升级为用户时，访客信息会记录到用户的 `converted_guests` 中，最多保留最近 20 条。

## 额度文件

### `data/ip_image_quotas.json`

顶层结构为字典，key 为额度归属，value 为已使用数量：

```json
{
  "192.168.1.1|device-a": 2,
  "user|user-id|device-a": 8,
  "admin|admin|device-a": 1
}
```

key 规则：

| 类型 | Key 格式 |
| --- | --- |
| 访客 | 通常为 `<ip>|<fingerprint>`。 |
| 普通用户 | `user|<user_id>|<fingerprint>`。 |
| 管理员 | `admin|<user_id>|<fingerprint>` 或 `admin|<user_id>`。 |

注意：

- 访客迁移到普通用户时，只迁移真正的访客 key，必须排除 `user|` 和 `admin|` 前缀。
- 用户管理里的使用额度会合并 `ip_image_quotas.json` 和成功图片任务的统计，避免漏算。

## 图片任务文件

### `data/ip_image_tasks.json`

顶层结构：

```json
{
  "tasks": [
    {
      "id": "client-task-id",
      "owner": "user|user-id|device-a",
      "quota_key": "user|user-id|device-a",
      "quota_limit": 20,
      "ip": "192.168.1.1",
      "fingerprint": "device-a",
      "status": "success",
      "mode": "generate",
      "model": "gpt-image-2",
      "size": "1024x1024",
      "created_at": "2026-05-11T00:00:00",
      "updated_at": "2026-05-11T00:01:00",
      "data": [
        {
          "url": "/images/2026/05/file.png",
          "source_url": "https://..."
        }
      ],
      "error": ""
    }
  ]
}
```

兼容规则：

- `tasks` 必须是数组。
- 成功任务 `status=success` 的 `data` 数量会参与使用额度统计。
- 文件保存时只保留最近一部分任务，避免文件无限增长。
- 部署前发现超大任务文件时，应先备份再通过清理脚本或服务逻辑缩减。

## 分享奖励文件

### `data/image_share_rewards.json`

顶层结构为分享码字典：

```json
{
  "abc123": {
    "code": "abc123",
    "owner_type": "user",
    "owner_user_id": "user-id",
    "owner_fingerprint": "device-a",
    "owner_name": "demo",
    "created_at": "2026-05-11T00:00:00",
    "redeemed_by": []
  }
}
```

访客注册或登录成用户后，分享奖励会从访客身份迁移到用户身份。

## 图片目录

### `data/images/`

用途：

- 保存生成和编辑后的图片。
- 保存代理缓存 `proxy-cache`。
- 通过 FastAPI 挂载为 `/images`。

清理规则：

- `config.image_retention_days` 控制图片保留时间。
- 服务启动时会执行旧图片清理。
- 清理只删除过期文件，不应删除整个 `data/images` 目录。

## 账号池相关数据

根据存储后端不同，账号池可能在：

- `data/accounts.json`
- `data/auth_keys.json`
- `data/accounts.db`
- 外部数据库
- Git 存储后端缓存目录

`STORAGE_BACKEND` 支持 `json`、`sqlite`、`postgres`、`git`。生产环境未明确迁移前应保持原后端不变。

## 数据兼容检查清单

部署前至少确认：

1. `web_users.json` 是用户列表。
2. `ip_image_quotas.json` 是字典。
3. `ip_image_tasks.json` 是 `{ "tasks": [...] }`。
4. `image_share_rewards.json` 是字典。
5. 新字段缺失时服务能用默认值读取。
6. 远程 `data/`、`config.json`、`.env` 不被代码同步覆盖。

