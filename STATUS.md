# vrc-monitor 项目状态（对账文件）

> **本文件是长期项目"清醒协议"的核心**：每次会话开工先读它对齐进度，收工更新"本次进展/下一步"。
> 完整运维手册见 skill `vrc-monitor-ops`（启动/升级/MCP直调/收藏转移/推荐评分等）。

## 基本情况（2026-08-10 核对）

| 项 | 值 |
|---|---|
| 主目录 | `F:\soft\vrc-monitor`（git 仓库，fork 克隆，唯一运行目录） |
| origin | `https://github.com/uhu005/vrc-monitor.git`（老大 fork，push 目标） |
| upstream | `https://github.com/ggg123124/vrc-monitor.git`（原作者，同步来源） |
| 运行版本 | fork main（v1.12.0 上游 46 工具 + 自研 6 个 = **52 个 MCP 工具**） |
| 服务端口 | 8799（`/health` 健康检查，`/mcp` JSON-RPC+SSE 端点） |
| 服务状态 | ✅ 运行中：authenticated=true（shine trick）、events 648,208、friends 614 |
| 最新 commit | `f550445` 共享评分系统重构（recommend_join 与 get_favorite_friends_locations 同一套评分） |
| 未提交/未跟踪 | `proto-intimacy.mjs`（早期"亲密度原型"临时脚本，已被正式 MCP 工具取代，**可清理，待老大确认**） |

## 运行态文件（升级/备份必须保留，全部 .gitignore 排除）

- `credentials.json`（VRChat 邮箱密码 + IMAP 授权码）
- `auth_cookie.txt`（登录态）
- `vrc-monitor.sqlite3`（数据库，better-sqlite3 + WAL，崩溃安全）
- `.env`（个人配置：`VRC_MONITOR_GROUP_WEIGHTS` / `VRC_MONITOR_CONTACT_GROUPS` / `VRC_MONITOR_DIR` 等，**不进 git**）

## 功能地图（现成能力，先查再动手）

- **查好友动态/位置**：`get_favorite_friends_locations`（收藏夹成员）、`recommend_join`（全部在线好友推荐）、`get_online_friends`、`get_companions`（同屏统计）、`get_friend_info`、`get_online_pattern`（作息规律）
- **新地图**：`scan_new_worlds`（扫描写库）、`get_new_worlds`（查询未逛，字段 worldName）
- **开图/加入**：`node open-world.mjs "<世界名或主题>"`（core/vrchat-launch.js 管道探测+API回退，游戏内弹菜单）；`--instance "<完整location>"` 加入现有实例
- **照片/媒体**：`upload_print`（照片墙，64 张上限）、`upload_gallery_image`（图库）、`download_*`（返回本地路径可发图）
- **偏好/学习**：`set_join_preference`（自然语言调推荐权重）、`record_join_choice`（记录选择自动学习）
- ⚠️ **规则**：查询默认走 MCP 工具，禁止手拼 SQL/翻 VRCX 库（除非老大明确说"去 VRCX"）

## 进行中事项

- [ ] PR #5（open-world 管道增强）评审 CHANGES_REQUESTED 已修复推送（d446316），等作者合并
- [ ] PR #6（推荐/偏好/学习工具集，54 工具分支）已提交，等评审
- [ ] `proto-intimacy.mjs` 清理确认（已被正式工具取代）
- [ ] 旧方案遗留：VRCX「新地图」分组 187 条历史重复数据，老大未定是否清理

## 已知坑（速查，详见 skill）

- 查 MCP 走 HTTP 直调时响应是 **SSE 格式**（`data: {...}` 行，剥前缀再 json.loads）
- 中文查询必须 Python urllib UTF-8 发（git-bash curl 中文乱码）
- 服务代码改完：`node --check` → `vrc_restart` → `netstat -ano | grep :8799` 确认新 PID → 看 `monitor.log`
- 大文件进 git 会触发 pre-receive hook 拒推：**提交前 `git status --short` 核对，绝不 `git add -A`**
- gh/curl 走代理 `127.0.0.1:7897`，curl exit 23 会短路 `&&` 链（分开跑）
- VRCX 改库后要重启 VRCX 才显示（内存缓存）

## 会话日志

- **2026-08-10**：建本状态文件（清醒协议落地）。核对：服务健康、52 工具、工作区仅 proto-intimacy.mjs 未跟踪。待办：等 PR #5/#6 评审、proto-intimacy.mjs 清理确认。
