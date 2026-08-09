#!/usr/bin/env bash
# vrc-monitor 一键同步脚本
# 功能：拉取原作者(upstream)最新更新 → 合并到本地 main → 推送到你的 fork(origin)
# 用法：bash sync-upstream.sh  或 双击运行（git-bash）
#
# 注意：
# - 如果有本地未提交的修改，脚本会中止（避免合并冲突把工作搞乱）
# - 如果合并有冲突，脚本停在冲突状态，解决后手动 git commit

set -e
cd "$(dirname "$0")"

echo "══════════════════════════════════════════"
echo "  vrc-monitor 上游同步"
echo "══════════════════════════════════════════"

# 1. 检查工作区是否干净（排除脚本自身——它常以未跟踪状态存在于新 clone 中）
DIRTY=$(git status --porcelain | grep -v "^?? sync-upstream.sh$" || true)
if [ -n "$DIRTY" ]; then
    echo "⚠️  工作区有未提交的修改，先处理它们再同步："
    echo "$DIRTY"
    echo ""
    echo "  选项："
    echo "    git add -A && git commit -m '你的提交说明'   # 提交你的修改"
    echo "    git stash                                    # 暂存修改"
    exit 1
fi

# 2. 拉取上游更新
echo ""
echo "① 拉取 upstream (ggg123124/vrc-monitor) 最新更新..."
git fetch upstream
echo "   完成。"

# 3. 检查上游是否有新提交
LOCAL=$(git rev-parse HEAD)
UPSTREAM=$(git rev-parse upstream/main)
if [ "$LOCAL" = "$UPSTREAM" ]; then
    echo ""
    echo "✅ 本地已经是最新，无需同步。"
    exit 0
fi

# 4. 合并
echo ""
echo "② 合并 upstream/main 到本地 main..."
echo "   本地:   $(git log --oneline -1 $LOCAL)"
echo "   上游:   $(git log --oneline -1 $UPSTREAM)"
git merge upstream/main --no-edit || {
    echo ""
    echo "❌ 合并冲突！请手动解决后执行: git add <文件> && git commit"
    exit 1
}
echo "   合并完成。"

# 5. 推送到 fork
echo ""
echo "③ 推送到你的 fork (uhu005/vrc-monitor)..."
git push origin main
echo ""
echo "✅ 同步完成！本地 main 和 fork 都已更新到上游最新。"
echo ""
git log --oneline -5
