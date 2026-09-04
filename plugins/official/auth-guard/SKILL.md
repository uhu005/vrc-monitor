---
name: auth-guard
description: 公网访问鉴权与安全防护插件，提供 HTTP Bearer/API-Key 访问拦截、Token 密码学生成与公网就绪度状态评估
---

# auth-guard 插件

本插件为 vrchat-assistant 服务提供**零外部依赖的 HTTP 访问鉴权**支持，方便将服务安全地暴露在局域网、公网（如 VPS、Docker 容器）或反向代理后。

## 核心特性

1. **零外部软件依赖**：无需安装第三方 VPN 或代理工具，Node.js 原生校验。
2. **多方式兼容**：
   - `Authorization: Bearer <TOKEN>`（标准 REST Header，生产环境推荐）
   - `X-API-Key: <TOKEN>`（API Key Header）
   - `?token=<TOKEN>`（URL 查询参数，兼容不支持自定义 Header 的客户端与浏览器直连；注意 URL 参数可能被代理日志记录，建议生产环境优先使用 Header）
3. **时序安全比对**：采用 `crypto.timingSafeEqual` 防范侧信道计时攻击。
4. **向后完全兼容**：若未设置 `VRC_MONITOR_AUTH_TOKEN`，服务默认完全放行，不影响本地单机使用体验。

## 环境变量配置

在项目根目录 `.env` 文件中配置：

```env
# 1. 开启公网网卡监听（默认 127.0.0.1 仅本地可连，设为 0.0.0.0 允许外部连接）
VRC_MONITOR_HOST=0.0.0.0

# 2. 自定义端口（可选，默认 8799）
VRC_MONITOR_PORT=8799

# 3. 访问认证令牌（配置后强制开启全接口 401 拦截防护）
VRC_MONITOR_AUTH_TOKEN=your_secure_random_token_here
```

> **Docker 部署提示**：若使用 Docker Compose 部署，请在 `.env` 中配置 `VRC_MONITOR_AUTH_TOKEN`，Compose 文件已配置自动将环境变量透传进容器。

## MCP 工具

| 工具名 | 说明 |
| :--- | :--- |
| `auth_get_status` | 查看当前服务的监听 IP、端口、Token 启用情况与公网安全就绪度 |
| `auth_generate_token` | 生成 32 字节高强度随机 Token，并输出可直接写入 `.env` 的配置片段 |
| `auth_verify_token` | 校验指定 Token 是否与当前生效配置相匹配 |
