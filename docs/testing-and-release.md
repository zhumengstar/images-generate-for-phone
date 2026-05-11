# 测试与发布

## 本地基础检查

后端语法检查：

```bash
python -m py_compile api/app.py api/system.py services/web_user_service.py main.py
```

后端测试：

```bash
python -m pytest
```

前端构建：

```bash
cd web
npm run build:local
```

Docker 构建：

```bash
docker compose build app
```

基础服务验证：

```bash
curl http://127.0.0.1:8000/version
curl http://127.0.0.1:8000/image
```

## 功能验收清单

### 图片工作台

- 访客打开 `/image` 成功。
- 普通用户登录后进入 `/image`。
- 管理员登录后可以从手机端进入用户管理。
- 图片生成任务可创建、轮询、成功展示。
- 图片编辑支持上传参考图。
- 点击生成结果的“编辑图片”可加载到上传区域。
- 最多加载 4 张参考图。
- AI 润色可用。
- 分享按钮可用。
- 刷新页面不使用旧缓存。

### 用户管理

- `/users` 只有管理员可访问。
- 列表展示访客、用户、管理员。
- 搜索可用。
- 角色筛选可用。
- 使用额度可排序。
- 最后登录和创建时间可排序。
- 用户名称居中。
- 图标列对齐。
- 单个删除可用。
- 批量删除可用。
- 手机端保留所有列。
- 手机端刷新和退出靠右。
- 默认用户额度和访客额度可保存。
- `7 天 100 张` 套餐计算正确。
- “无限”展示正确。

### 额度

- 访客生成后使用次数增加。
- 用户生成后管理端使用额度增加。
- 访客注册或登录为用户后，访客数据迁移且不丢失。
- 管理员为无限额度。
- 无限用户不应因为分享奖励增加次数。
- 套餐到期后恢复到套餐前总额度。

## 7 天套餐测试用例

准备用户当前额度：

```text
已使用 = 1
总额度 = 9999
可用 = 9998
```

点击 `7 天 100 张` 后应为：

```text
总额度 = 10099
可用 = 10098
```

到期后应恢复：

```text
总额度 = 9999
可用 = 9998
```

如果套餐内消耗了图片，到期后可用额度按恢复后的总额度减去真实已使用次数计算。

## 发布规则

1. 未经用户明确允许，不发布远程服务。
2. 发布前必须本地提交代码。
3. 发布前必须形成发布说明或更新相关文档。
4. 发布前必须备份远程运行数据。
5. 部署不得覆盖远程 `data/`、`config.json`、`.env`。
6. 发布后必须验证 `/version` 和关键功能。
7. 如用户要求“直到所有测试成功”，失败项必须修复后重测。

## Git 提交流程

```bash
git status --short --branch
git diff --check
git add <changed-files>
git commit -m "Add project documentation suite"
```

如涉及版本发布，应同时更新：

- `VERSION`
- `docs/release-YYYY-MM-DD.md`
- 相关功能文档

## 远程发布后检查

```bash
curl -s http://127.0.0.1:8808/version
docker ps --filter name=images-generate
docker logs --tail=100 images-generate
```

浏览器验证：

- `/image`
- `/users`
- 手机端 `/image`
- 手机端 `/users`

如远程前面有 Nginx，还要确认公网域名对应的服务和容器资源：

```bash
docker stats images-generate
tail -n 100 /var/log/nginx/access.log
tail -n 100 /var/log/nginx/error.log
```

