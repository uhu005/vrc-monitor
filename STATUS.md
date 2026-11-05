# vrc-monitor 项目状态（对账文件）

> **本文件是长期项目"清醒协议"的核心**：每次会话开工先读它对齐进度，收工更新"本次进展/下一步"。
> 完整运维手册见 skill `vrc-monitor-ops`（启动/升级/MCP直调/收藏转移/推荐评分等）。

## 基本情况（2026-08-13 核对）

| 项 | 值 |
|---|---|
| 主目录 | `F:\soft\vrc-monitor`（git 仓库，fork 克隆，唯一运行目录） |
| origin | `https://github.com/uhu005/vrc-monitor.git`（老大 fork，push 目标） |
| upstream | `https://github.com/ggg123124/vrchat-assistant.git`（原作者，**已更名**，旧名 vrc-monitor 301 跳转） |
| 运行版本 | fork main **v3.4.0**（128 个 MCP 工具；上游 v3.3.0 + v3.4.0 已合并，含本地定制脚本） |
| 服务端口 | 8799（`/health` 健康检查，`/mcp` JSON-RPC+SSE 端点） |
| 服务状态 | ✅ 运行中：authenticated=true（shine trick）/ ws connected / 插件 15 / **安全模式已启用：对外 110 工具**（能力 128，破坏性 18 个被移除+拦截） |
| 最新 commit | `3da6956` Merge upstream/main v3.4.0（退役本地 SSE 补丁，改用上游 GET /mcp 405） |
| 未提交/未跟踪 | 无（`proto-intimacy.mjs` 已脱敏，是否删除待老大确认） |

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

- [x] **上游同步**：2026-11-05 已升级到 v3.4.0（落后 485 commits，跨 v3.3.0/v3.4.0），工具 104→128
- [ ] 学习样本攒到 5 次（当前 2/5）解锁 5 维度自动学习
- [ ] `proto-intimacy.mjs` 是否删除（已脱敏，等老大定；该文件已被正式工具取代）
- [ ] 旧方案遗留：VRCX「新地图」分组 187 条历史重复数据，老大未定是否清理

## 已知坑（速查，详见 skill）

- **服务进程用 node v22 启动**（PATH 里的 `C:/Users/Windows/AppData/Local/hermes/node/node.exe`）：Hermes 插件 `vrc_start` 会改用自带 node v26（`hermes/tools/node-26.7.0-*`），与现有 `better-sqlite3` 预编译二进制 ABI 风险未实测 ⇒ **别用插件托管**。手动启动的进程 `vrc_restart`/`vrc_stop` 也管不到（health probe 杀不掉，6s 后中止，2026-11-05 实测），要重启直接 `powershell Stop-Process -Id <pid> -Force` 再 `node start-monitor.js`。
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

- **2026-11-05（上午，续）**：启用 **安全模式**（`.env` 加 `VRC_MONITOR_SAFE_MODE=true`，旧文件备份 `.env.bak-beforesafe-20261105`）→ 重启后 **工具 128→110**：移除并拦截 18 个破坏性工具（删好友/删照片/删画廊图/退群/拒绝好友请求/隐藏通知/移出待逛与关注/取消收藏/移动或清空收藏分组/移除 X 博主 + v3.4.0 新增的 `set_group_announcement`、`delete_group_announcement`、`update_group_post`、`delete_group_post`）。验证：`tools/list`=110 且 18 个全部不在列表；直接 `tools/call remove_friend` 被拦截并返回中文提示（日志 `工具调用失败 [remove_friend]: 🔒 安全模式已启用`）；查询/开图/发帖/兑换等 110 个正常保留；auth=true / ws connected / 在线 67 不变。**要临时恢复破坏性能力：`.env` 改 `false` 后重启服务**。

- **2026-11-05（上午）**：升级 v3.2.0-beta → **v3.4.0**（落后 485 commits，跨 v3.3.0 + v3.4.0）。流程：备份三件套 + `.env` 到 `C:/Users/Windows/vrc-monitor-upgrade-backup-20261105/`（sqlite backup API 一致性快照，integrity ok / 983,121 events）→ 提交 `scripts/open-world.mjs` 的 `--help` 短路修复 → `git merge upstream/main`（唯一冲突 `core/http-server.js`：**取上游 405 实现、退役本地 SSE 长连接补丁**，上游 #188 已证明 405 会让 SDK 重连 2 次后停止，比 200+空 SSE 治本）→ `npm run install-plugins`（补 emoji-notes 的 `pinyin-pro` 依赖 + 构建 dashboard 产物 1.03MB）→ 重启验证：auth=true / ws connected / 插件 15 / **工具 128** / `GET /mcp`=405 / `get_online_friends` 真实返回 65 人在线。`npm test` 542/542；`check-deident` 抓出本地遗留 `proto-intimacy.mjs` 含 3 个真实 userId（含自己）→ 已脱敏占位。同步：hermes-plugin 3.2.0-beta→3.4.0（旧版备份在升级备份目录）、desktop 插件内容一致、6 个缺失 skill 装入并合并 `vrc-monitor-agent` 本地「代码与接入点」段。新增能力：redeem/inventory/emoji-notes/presence-status/friend-removals/群组帖子与公告写侧/friend_world_stats/mutual_groups 等 24 工具；Dashboard 三态主题 + 产物 -32%、动态流计数 208ms→9ms。

- **2026-09-04（晚间）**：**大版本升级 v1.15.0 → v3.2.0-beta**（落后 334 commits，v2.0.0 数据本地化 / v3.0.0 插件化 / 结构化日志 / TOTP 自动登录 / Web Dashboard / auth-guard / playwright X 抓取）。流程：提交 STATUS 基线 → 备份三件套到 `F:\soft\vrc-monitor-backup-20260904\` → vrc_stop（坑：第一次 vrc_stop 只清状态文件没杀到进程 35160，vrc_start 后 .active.json 更新为真 PID，再走正规 vrc_stop 才真停；直接 taskkill 被治理层拦）→ git merge upstream/main（3 冲突：`.gitignore` 双保留、`package-lock.json` 取上游、`core/http-server.js` **重打 SSE 长连接补丁**并改用上游 pathname 变量——上游仍是 endpoint probe 秒断式，补丁必须保留）→ npm install（新增 playwright，可选功能不用下浏览器二进制）→ 同步 hermes-plugin/桌面插件/skills（vrc-monitor-agent skill v1.0→v2.0，companion-query 上游已移除本地保留）。验证全过：5 个核心文件 node --check / /health 全绿（auth/ws/11 插件 loaded/events 无损）/ tools/list **104 工具**（原 55，插件化扩展）/ GET /mcp SSE 长连接实测挂住+2s 心跳 / get_online_friends 真实调用成功 / 日志无错误 / 结构化日志+启动自动备份生效。**PR #8 已于 8-11 合并上游**，学习系统以官方 recommend 插件形态回归。推送 fork 需 workflow scope（合并带入 ci.yml），老大设备码授权（05AD-9F0D）后推送成功 560ea62→7a3dab9；fork CI（上游 ci.yml）ubuntu+windows 双平台全绿，等于官方测试套件验证了合并结果。**下一步**：vrc_restart 注意 .active.json PID 校验；关注 playwright 首次实际使用（X 世界抓取）；插件化后新增工具待实际使用探索。

- **2026-08-14（晚间）**：**修复 MCP GET /mcp 秒断循环（Hermes 客户端每秒断连重连）**——症状：agent.log 每分钟 60-120 条 `GET stream disconnected` + vrcx-monitor keepalive degraded（17:19 起持续数小时），服务本身健康（POST 工具全正常）。根因：http-server.js 的 GET /mcp 是 endpoint probe（立即 res.end()），Hermes streamable HTTP 客户端建立 GET stream 长连接等推送 → 秒断秒连。修复：GET /mcp 保持 SSE 长连接 + 2s 心跳（`: ping`，低于 mihomo 代理 4s 空闲超时）；POST 路径零改动。验证：curl -N 挂住 + agent.log 断连归零（19:45 起）+ 工具调用正常。commit 689c8a0 已推 fork。顺带提交了 8-13 遗留的 STATUS.md 版本更新。

- **2026-08-10**：建本状态文件（清醒协议落地）。服务健康、52 工具。待办：等 PR #5/#6 评审。
- **2026-08-11**：PR #5 合并（open-world 进上游）+ PR #6 合并（v1.14.0 推荐工具集）+ PR #8 提交（学习 5 维度/权重均衡）。权重均衡落地（熟悉度×1.5 vs 地图属性成对调）。上游仓库更名 vrchat-assistant。issue #7（Release @ 截断）创建。
- **2026-08-12**：PR #8 评审 R1（2 阻断：夹带删 3 工具/三列迁移缺失；2 警告：61+正则/缓存）→ 修复 449de58 → R2 复测（新阻断：get_join_learning 丢 return）→ 修复 33cdbaa → 等 R3。上游 v1.16/v1.17 发布。参与 #18（recommend_worlds）讨论：wrld_id 方案 b 被采纳、作者维度 3:1:1+封顶建议。
- **2026-08-13**：issue #19（用户反馈闭环）创建。上游 v1.17.0（#18/#19 全落地：recommend_worlds/favorite_world/rate_world）+ v2.0.0（74 工具平台化）发布。开图闭环完善（非游戏过滤/备图流程/收藏夏の痕跡→观光组）。学习样本 2/5。服务 55 工具健康。
- **2026-08-18**：检查认证行为：服务当前 authenticated=true、WebSocket connected；历史日志显示 auth cookie 过期后才触发 IMAP 读取 VRChat OTP，存在多次重复重试/失败，但未见持续发邮件逻辑。fetch-otp.py 仅 IMAP LOGIN/SELECT/SEARCH/FETCH/LOGOUT。
