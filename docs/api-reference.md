# 接口参考

本文档按业务分组列出项目当前主要接口。除特别说明外，管理员接口需要 `Authorization: Bearer <token>`，图片工作台接口应携带 `X-Device-Fingerprint`。

## 基础接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/version` | 返回应用版本。 |
| `POST` | `/auth/login` | 登录或创建访客身份。 |

### `POST /auth/login`

请求体可以为空、账号密码登录，也可以携带设备指纹：

```json
{
  "username": "admin",
  "password": "******",
  "device_fingerprint": "device-id"
}
```

返回字段：

| 字段 | 说明 |
| --- | --- |
| `ok` | 是否成功。 |
| `version` | 当前服务版本。 |
| `role` | `admin`、`user` 或 `guest`。 |
| `subject_id` | 用户或访客 ID。 |
| `name` | 展示名称。 |
| `token` | 登录用户后续请求使用的 Token。访客可为空。 |
| `ip` | 服务识别的客户端 IP。 |
| `fingerprint` | 设备指纹。 |
| `device_registered` | 当前设备是否已有注册用户。 |

## 图片工作台接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/ip-limited/quota` | 查询当前访客、用户或管理员额度。 |
| `POST` | `/api/ip-limited/quota/refund` | 失败后退回已消耗额度。 |
| `POST` | `/api/ip-limited/share-link` | 创建分享链接。 |
| `POST` | `/api/ip-limited/share-link/redeem` | 访问分享链接并领取奖励。 |
| `POST` | `/api/ip-limited/prompt-polish` | AI 润色提示词。 |
| `GET` | `/api/ip-limited/image-tasks` | 查询当前身份的图片任务。 |
| `POST` | `/api/ip-limited/image-tasks/generations` | 创建异步图片生成任务。 |
| `POST` | `/api/ip-limited/image-tasks/edits` | 创建异步图片编辑任务。 |
| `POST` | `/api/ip-limited/images/generations` | 直接图片生成。 |
| `POST` | `/api/ip-limited/images/edits` | 直接图片编辑。 |
| `GET` | `/api/ip-limited/image-proxy` | 代理读取允许的图片 URL。 |

### 任务创建请求

图片生成：

```json
{
  "client_task_id": "uuid",
  "prompt": "生成一张高级产品海报",
  "model": "gpt-image-2",
  "size": "1024x1024"
}
```

图片编辑使用 `multipart/form-data`：

| 字段 | 说明 |
| --- | --- |
| `image` | 参考图片，可多张。后端默认最多 4 张。 |
| `client_task_id` | 客户端任务 ID，用于幂等提交。 |
| `prompt` | 编辑提示词。 |
| `model` | 默认 `gpt-image-2`。 |
| `size` | 可选尺寸。 |

任务返回：

```json
{
  "id": "uuid",
  "status": "queued",
  "mode": "generate",
  "model": "gpt-image-2",
  "size": "",
  "created_at": "2026-05-11T00:00:00",
  "updated_at": "2026-05-11T00:00:00"
}
```

状态包括 `queued`、`running`、`success`、`error`。

## 管理员系统接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/settings` | 读取运行配置。 |
| `POST` | `/api/settings` | 更新运行配置。 |
| `GET` | `/api/images` | 查询本地图片。 |
| `POST` | `/api/images/delete` | 删除图片。 |
| `GET` | `/api/logs` | 查询系统日志。 |
| `POST` | `/api/proxy/test` | 测试代理。 |
| `GET` | `/api/storage/info` | 查询存储后端和健康状态。 |

## 用户管理接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/web-users` | 获取用户、访客、管理员列表和默认额度。 |
| `POST` | `/api/web-users/{user_id}/quota` | 追加或设置用户图片额度。 |
| `POST` | `/api/web-users/{user_id}/quota-package` | 设置临时套餐。 |
| `POST` | `/api/web-users/{user_id}/role` | 设置普通用户或管理员角色。 |
| `DELETE` | `/api/web-users/{user_id}` | 删除普通用户或访客。 |
| `POST` | `/api/web-users/default-quotas` | 设置用户和访客默认额度。 |

注意：

- 删除管理员被禁止。
- 至少保留一个管理员。
- 访客不能直接设置为管理员，需要先注册或登录为普通用户。
- 设置角色时会迁移额度 key 的 `user|` 和 `admin|` 前缀。

## OpenAI 兼容接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/models` | 返回可用模型列表。 |
| `POST` | `/v1/images/generations` | OpenAI 风格图片生成。 |
| `POST` | `/v1/images/edits` | OpenAI 风格图片编辑。 |
| `POST` | `/v1/chat/completions` | Chat Completions 兼容接口。 |
| `POST` | `/v1/responses` | Responses 兼容接口。 |
| `POST` | `/v1/messages` | Messages 兼容接口。 |

## 账号池和导入接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/auth/users` | API Key 用户列表。 |
| `POST` | `/api/auth/users` | 创建 API Key。 |
| `POST` | `/api/auth/users/{key_id}` | 更新 API Key。 |
| `DELETE` | `/api/auth/users/{key_id}` | 删除 API Key。 |
| `GET` | `/api/accounts` | 账号池列表。 |
| `POST` | `/api/accounts` | 批量导入账号。 |
| `DELETE` | `/api/accounts` | 批量删除账号。 |
| `POST` | `/api/accounts/refresh` | 刷新账号状态。 |
| `POST` | `/api/accounts/update` | 更新账号属性。 |
| `GET/POST/DELETE` | `/api/cpa/pools...` | CPA 连接、文件和导入任务。 |
| `GET/POST/DELETE` | `/api/sub2api/servers...` | Sub2API 连接、分组、账号和导入任务。 |

