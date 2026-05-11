# 前端说明

前端位于 `web/`，使用 Next.js、React、Tailwind CSS、Radix UI、lucide-react 和 localforage。生产构建后由 FastAPI 托管静态产物。

## 环境配置

`web/scripts/use-web-env.cjs` 支持两套前端环境：

```bash
npm run env:local
npm run env:server
```

对应文件：

- `web/.env.local.local`
- `web/.env.local.server`

常用脚本：

```bash
npm run dev:local
npm run dev:server
npm run build:local
npm run build:server
```

## API 地址解析

前端通过 `web/src/lib/request.ts` 和 `web/src/lib/api.ts` 解析 API Base URL。移动端部署时要避免写死 `localhost`，应按当前部署服务地址请求。

请求图片、登录、分享和用户接口时通常会带：

- `cache: "no-store"`
- `Cache-Control: no-cache`
- `Pragma: no-cache`
- `Authorization`
- `X-Device-Fingerprint`

## 登录态

登录态由 `web/src/store/auth.ts` 管理：

- 新存储名：`images-generate`。
- 兼容旧存储名：`chatgpt2api`。
- 普通用户和管理员会保存 Token。
- 访客不保存为正式登录态。
- 管理员默认路由为 `/users`，普通用户默认路由为 `/image`。

## 图片工作台

主文件：

```text
web/src/app/image/page.tsx
```

核心行为：

- 桌面端左右区域布局，左侧为历史，右侧为生成区域。
- 手机端自适应底部输入区，监听 `visualViewport` 修正键盘高度。
- 手机端最大并发生成任务为 1。
- 支持 AI 润色、图片生成、图片编辑、分享、额度展示。
- 支持点击生成结果进入编辑，最多加载 4 张参考图。
- 生成和编辑请求都不使用浏览器缓存。

手机端输入区相关常量：

| 常量 | 说明 |
| --- | --- |
| `MOBILE_SHELL_TOP_HEIGHT` | 顶部安全高度。 |
| `MOBILE_KEYBOARD_COMPOSER_CLEARANCE` | 键盘弹出后输入区保留空间。 |
| `MOBILE_COMPOSER_MIN_TOP` | 输入区最小顶部间距。 |
| `MOBILE_MAX_CONCURRENT_IMAGE_TASKS` | 手机端任务并发上限。 |

## 用户管理页

主文件：

```text
web/src/app/users/page.tsx
```

功能：

- 用户列表。
- 搜索用户。
- 角色筛选。
- 额度筛选。
- 使用额度排序。
- 最后登录排序。
- 创建时间排序。
- 用户名称居中展示。
- 图标列对齐。
- 单个删除和批量删除。
- 默认额度设置。
- 用户额度追加。
- `7 天 100 张` 套餐。
- 角色设置，管理员可给其他用户设置管理员权限。
- 手机端保留所有列，通过横向滚动查看。
- 手机端保留刷新和退出，并靠右展示。

## 样式原则

近期需求重点：

- 电脑端独立设计，不影响手机端。
- 手机端独立自适应，不影响电脑端。
- 字不要拥挤。
- 无用信息移除。
- 重要文字尽量不换行。
- 用户管理表格列保持对齐。
- 额度展示使用“无限”，不使用“不限”。

修改前端时，应优先查看现有 Tailwind 类名和响应式断点，避免把桌面端样式泄漏到手机端。

