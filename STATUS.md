# vrc-monitor 项目状态（对账文件）

> **本文件是长期项目"清醒协议"的核心**：每次会话开工先读它对齐进度，收工更新"本次进展/下一步"。
> 完整运维手册见 skill `vrc-monitor-ops`（启动/升级/MCP直调/收藏转移/推荐评分等）。

## 基本情况（2026-08-13 核对）

| 项 | 值 |
|---|---|
| 主目录 | `F:\soft\vrc-monitor`（git 仓库，fork 克隆，唯一运行目录） |
| origin | `https://github.com/uhu005/vrc-monitor.git`（老大 fork，push 目标） |
| upstream | `https://github.com/ggg123124/vrchat-assistant.git`（原作者，**已更名**，旧名 vrc-monitor 301 跳转） |
| 运行版本 | fork main（55 个 MCP 工具：上游 v1.14 基础 52 + 本地 5 维度学习等） |
| 服务端口 | 8799（`/health` 健康检查，`/mcp` JSON-RPC+SSE 端点） |
| 服务状态 | ✅ 运行中：authenticated=true（shine trick） |
| 最新 commit | `1c0e2e8` 学习系统 5 维度扩展 + 权重均衡（PR #8 分支另含评审修复 `33cdbaa`） |
| 未提交/未跟踪 | `proto-intimacy.mjs`（早期"亲密度原型"，已被正式工具取代，**可清理，待老大确认**） |

## 运行态文件（升级/备份必须保留，全部 .gitignore 排除）

- `credentials.json`（VRChat 邮箱密码 + IMAP 授权码）
- `auth_cookie.txt`（登录态——**会过期**，失效后 vrc_restart 重新认证刷新）
- `vrc-monitor.sqlite3`（数据库，better-sqlite3 + WAL，崩溃安全）
- `.env`（个人配置：`VRC_MONITOR_GROUP_WEIGHTS` / `VRC_MONITOR_CONTACT_GROUPS` / `VRC_MONITOR_DIR` 等，**不进 git**）

## 功能地图（现成能力，先查再动手）

- **查好友动态/位置**：`get_favorite_friends_locations`（收藏夹成员）、`recommend_join`（全部在线好友推荐）、`get_online_friends`、`get_companions`（同屏统计）、`get_friend_info`（**实时状态，比好友列表缓存准**）、`get_online_pattern`
- **新地图**：`scan_new_worlds`、`get_new_worlds`（未逛查询，可带 excludeTheme）
- **开图/加入**：`node open-world.mjs "<世界名或主题>"`（core/vrchat-launch.js 管道探测+API回退）；`--instance "<完整location>"` 加入现有实例
- **偏好/学习**：`set_join_preference`（自然语言调权重）、`record_join_choice`（记录选择，**样本 2/5**：D_mikan + 5000）、`get_join_learning`（5 维度：重复选人/人数舒适区/类型偏好/安静图/熟悉度）
- **评分体系**：熟悉度×1.5（上限132）vs 地图属性（人数×1+黄金区30）**均衡**；动态调整成对系数（avoid 熟悉×1.15/人数×0.75，love ×0.9/×1.25）封顶 1.3
- ⚠️ **规则**：查询默认走 MCP 工具，禁止手拼 SQL/翻 VRCX 库（除非老大明确说"去 VRCX"）

## 进行中事项

- [ ] **PR #8**（学习 5 维度 + 权重均衡）：R1 修复（449de58）+ R2 return 修复（33cdbaa）已推送，**等 R3 复测**。https://github.com/ggg123124/vrchat-assistant/pull/8
- [ ] **上游同步决策**：上游已发 v1.17.0（recommend_worlds/favorite_world/rate_world，62 工具）+ v2.0.0（收藏 PDF/X 博主/BOOTH/常驻服务，74 工具）。**建议等 PR #8 合并后再同步**（避免评审基线冲突）。#18/#19 我们参与讨论的功能已全部落地
- [ ] 学习样本攒到 5 次（当前 2/5）解锁 5 维度自动学习
- [ ] `proto-intimacy.mjs` 清理确认（已被正式工具取代）
- [ ] 旧方案遗留：VRCX「新地图」分组 187 条历史重复数据，老大未定是否清理

## 已知坑（速查，详见 skill）

- 查 MCP 走 HTTP 直调时响应是 **SSE 格式**（`data: {...}` 行，剥前缀再 json.loads）
- 中文查询必须 Python urllib UTF-8 发（git-bash curl 中文乱码）
- 服务代码改完：`node --check` → `vrc_restart` → 确认新 PID → 看 `monitor.log`
- **大文件进 git 会触发 pre-receive hook 拒推**（.bak 备份文件实测被拒过）：**绝不 `git add -A`**，提交前 `git status --short` 核对
- gh/curl 走代理 `127.0.0.1:7897`，curl exit 23 会短路 `&&` 链（分开跑）
- **OTP 偶发失败**：`fetch-otp.py` 手动跑通但服务里偶发 FAILED（邮件 10 分钟窗口）——vrc_restart 重试即可
- **auth_cookie.txt 会过期**（10h+ 后文件失效，但服务端内存 cookie 仍有效）——open-world.mjs 报 OTP 失败时先 vrc_restart 刷新 cookie 文件
- **searchName 依赖在线好友列表缓存**（可能滞后）——查实时状态用 `get_friend_info`（即使不在线也能确认）
- 世界详情 occupants = 世界所有实例聚合，**实例真实人数要查 `/instances/{location}`**（MCP 无此工具，临时脚本）
- 收藏世界 API：tags 必须用分组 tag（`worlds0-4`），空 tags 会被拒；分组上限 4 个
- VRCX 改库后要重启 VRCX 才显示（内存缓存）

## 会话日志

- **2026-08-10**：建本状态文件（清醒协议落地）。服务健康、52 工具。待办：等 PR #5/#6 评审。
- **2026-08-11**：PR #5 合并（open-world 进上游）+ PR #6 合并（v1.14.0 推荐工具集）+ PR #8 提交（学习 5 维度/权重均衡）。权重均衡落地（熟悉度×1.5 vs 地图属性成对调）。上游仓库更名 vrchat-assistant。issue #7（Release @ 截断）创建。
- **2026-08-12**：PR #8 评审 R1（2 阻断：夹带删 3 工具/三列迁移缺失；2 警告：61+正则/缓存）→ 修复 449de58 → R2 复测（新阻断：get_join_learning 丢 return）→ 修复 33cdbaa → 等 R3。上游 v1.16/v1.17 发布。参与 #18（recommend_worlds）讨论：wrld_id 方案 b 被采纳、作者维度 3:1:1+封顶建议。
- **2026-08-13**：issue #19（用户反馈闭环）创建。上游 v1.17.0（#18/#19 全落地：recommend_worlds/favorite_world/rate_world）+ v2.0.0（74 工具平台化）发布。开图闭环完善（非游戏过滤/备图流程/收藏夏の痕跡→观光组）。学习样本 2/5。服务 55 工具健康。
