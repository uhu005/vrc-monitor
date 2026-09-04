#!/usr/bin/env python3
"""vrchat-assistant 仓库协作审核参考脚本。

本脚本全部使用 GitHub CLI 的 REST API（gh api repos/<owner>/<repo>/...）。
原仓库使用 gh pr list / gh issue list 等 GraphQL 命令会报
"Could not resolve to a Repository"，因此强制走 REST 端点。
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone


REPO_DEFAULT = "ggg123124/vrchat-assistant"
MAX_DEFAULT = 3
CLAIM_RE = re.compile(r"^\[AGENT-REVIEW\](?![A-Z-])")
WITHDRAW_RE = re.compile(r"^\[AGENT-REVIEW-WITHDRAW\]")
DONE_RE = re.compile(r"^\[AGENT-REVIEW-DONE\]")


def _configure_stdout():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def run_gh(args, check=True):
    """运行 gh api 命令并返回解析后的 JSON。失败时返回 None。"""
    cmd = ["gh", "api"] + args
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
        )
    except subprocess.TimeoutExpired:
        print(f"API 调用超时: {' '.join(cmd)}", file=sys.stderr)
        return None
    except FileNotFoundError:
        print("未找到 gh 命令，请先安装 GitHub CLI。", file=sys.stderr)
        return None

    if result.returncode != 0:
        # 静默处理 404，其它错误输出到 stderr
        if "404" not in result.stderr:
            err = result.stderr.strip() or result.stdout.strip()
            print(f"gh api 错误: {err}", file=sys.stderr)
        return None

    if not result.stdout.strip():
        return None

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        print(f"无法解析 gh api 输出: {result.stdout[:200]}", file=sys.stderr)
        return None


def fetch_prs(repo):
    result = run_gh([f"repos/{repo}/pulls?state=open", "--paginate", "--jq", "map({number: .number, title: .title, author: .user.login, draft: .draft, updated_at: .updated_at, state: .state})"])
    return result if result is not None else None


def fetch_issues(repo):
    result = run_gh([f"repos/{repo}/issues?state=open", "--paginate", "--jq", "map({number: .number, title: .title, author: .user.login, updated_at: .updated_at, state: .state, pull_request: .pull_request})"])
    if result is None:
        return None
    return [i for i in result if i.get("pull_request") is None]


def fetch_item_details(repo, number):
    """返回 (is_pr, details) 或 (None, None)。"""
    pr = run_gh([f"repos/{repo}/pulls/{number}", "--jq", "{user: .user.login, draft: .draft, state: .state, merged: .merged, updated_at: .updated_at}"])
    if pr:
        return True, pr
    issue = run_gh([f"repos/{repo}/issues/{number}", "--jq", "{user: .user.login, state: .state, updated_at: .updated_at}"])
    if issue:
        return False, issue
    return None, None


def fetch_comments(repo, number):
    return run_gh([f"repos/{repo}/issues/{number}/comments", "--paginate", "--jq", "map({id: .id, user: .user.login, body: .body, created_at: .created_at})"]) or []


def fetch_reviews(repo, number):
    return run_gh([f"repos/{repo}/pulls/{number}/reviews", "--paginate", "--jq", "map({user: .user.login, state: .state, submitted_at: .submitted_at})"]) or []


def parse_time(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def analyze_claims(repo, number, current_time):
    """分析单个条目的认领情况。

    返回 dict:
      is_pr, item_author, item_state, is_merged, is_draft,
      valid_claims (list of {login, claimed_at, has_done}),
      all_authors (dict login -> {claims, withdraws, dones}),
      reviews
    若条目不存在返回 None。
    """
    is_pr, details = fetch_item_details(repo, number)
    if details is None:
        return None

    comments = fetch_comments(repo, number)
    reviews = fetch_reviews(repo, number) if is_pr else []

    item_author = details["user"]
    item_state = details["state"]
    is_merged = details.get("merged", False)
    is_draft = details.get("draft", False)

    all_authors = {}
    for c in comments:
        login = c["user"]
        body = c["body"] or ""
        created = c["created_at"]
        if login not in all_authors:
            all_authors[login] = {"claims": [], "withdraws": [], "dones": []}
        if CLAIM_RE.match(body):
            all_authors[login]["claims"].append(created)
        elif WITHDRAW_RE.match(body):
            all_authors[login]["withdraws"].append(created)
        elif DONE_RE.match(body):
            all_authors[login]["dones"].append(created)

    valid_claims = []
    for login, info in all_authors.items():
        if not info["claims"]:
            continue
        earliest = min(info["claims"])

        # 排除条目作者本人
        if login == item_author:
            continue

        # 排除已退出
        if info["withdraws"]:
            continue

        created_dt = parse_time(earliest)
        expired = (current_time - created_dt) > timedelta(hours=24)
        has_done = bool(info["dones"])

        # PR 场景下检查非 PENDING review
        has_non_pending_review = False
        if is_pr:
            for r in reviews:
                if r["user"] == login and r["state"] != "PENDING":
                    has_non_pending_review = True
                    break

        # 超过 24 小时且无完成证据 -> 失效
        if expired and not has_done and not has_non_pending_review:
            continue

        valid_claims.append({
            "login": login,
            "claimed_at": earliest,
            "has_done": has_done,
        })

    return {
        "is_pr": is_pr,
        "item_author": item_author,
        "item_state": item_state,
        "is_merged": is_merged,
        "is_draft": is_draft,
        "valid_claims": valid_claims,
        "all_authors": all_authors,
        "reviews": reviews,
    }


def claim_status_text(count, max_count):
    if count == 0:
        return "未认领"
    if count >= max_count:
        return f"已满"
    return f"处理中 {count}"


def format_participants(claims):
    logins = sorted({c["login"] for c in claims})
    return ",".join(logins) if logins else "无"


def cmd_status(args):
    repo = args.repo
    max_count = args.max
    prs = fetch_prs(repo)
    issues = fetch_issues(repo)
    if prs is None or issues is None:
        print("无法获取仓库数据，请检查 gh 认证与网络。", file=sys.stderr)
        sys.exit(2)
    current_time = datetime.now(timezone.utc)

    print(f"仓库: {repo}")
    print(f"--- Open PR ({len(prs)}) ---")
    if not prs:
        print("无")
    for pr in prs:
        info = analyze_claims(repo, pr["number"], current_time)
        count = len(info["valid_claims"]) if info else 0
        participants = format_participants(info["valid_claims"]) if info else "无"
        draft = "draft" if pr.get("draft") else ""
        print(f"PR#{pr['number']} [{pr['state']}] {draft} 作者:{pr['author']} 认领:{count}/{max_count} ({claim_status_text(count, max_count)}) 参与者:[{participants}] {pr['title']}")
        if args.detail and info and info["valid_claims"]:
            for c in info["valid_claims"]:
                print(f"    - {c['login']} 认领于 {c['claimed_at']}")

    print(f"--- Open Issue ({len(issues)}) ---")
    if not issues:
        print("无")
    for issue in issues:
        info = analyze_claims(repo, issue["number"], current_time)
        count = len(info["valid_claims"]) if info else 0
        participants = format_participants(info["valid_claims"]) if info else "无"
        print(f"ISSUE#{issue['number']} [{issue['state']}] 作者:{issue['author']} 认领:{count}/{max_count} ({claim_status_text(count, max_count)}) 参与者:[{participants}] {issue['title']}")
        if args.detail and info and info["valid_claims"]:
            for c in info["valid_claims"]:
                print(f"    - {c['login']} 认领于 {c['claimed_at']}")


def cmd_scan(args):
    repo = args.repo
    state_path = args.state or os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-review-state.json")
    current_time = datetime.now(timezone.utc)

    prs = fetch_prs(repo)
    issues = fetch_issues(repo)
    if prs is None or issues is None:
        print("POLL_SKIPPED")
        sys.exit(2)

    new_state = {}
    for pr in prs:
        new_state[f"PR#{pr['number']}"] = {
            "updated_at": pr["updated_at"],
            "title": pr["title"],
            "author": pr["author"],
            "state": pr["state"],
        }
    for issue in issues:
        new_state[f"ISSUE#{issue['number']}"] = {
            "updated_at": issue["updated_at"],
            "title": issue["title"],
            "author": issue["author"],
            "state": issue["state"],
        }

    old_state = {}
    if os.path.exists(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                old_state = json.load(f)
        except Exception:
            old_state = {}

    old_keys = set(old_state.keys())
    new_keys = set(new_state.keys())

    added = new_keys - old_keys
    removed = old_keys - new_keys
    updated = set()
    for key in new_keys & old_keys:
        if new_state[key]["updated_at"] != old_state[key]["updated_at"]:
            updated.add(key)

    has_change = False
    if added:
        has_change = True
        print("新增:")
        for key in sorted(added, key=lambda x: (x.split("#")[0], int(x.split("#")[1]))):
            item = new_state[key]
            print(f"  {key}: {item['title']} (作者: {item['author']})")
    if updated:
        has_change = True
        print("有更新:")
        for key in sorted(updated, key=lambda x: (x.split("#")[0], int(x.split("#")[1]))):
            item = new_state[key]
            print(f"  {key}: {item['title']} (作者: {item['author']})")
    if removed:
        has_change = True
        print("已消失:")
        for key in sorted(removed, key=lambda x: (x.split("#")[0], int(x.split("#")[1]))):
            item = old_state[key]
            print(f"  {key}: {item['title']} (作者: {item['author']})")

    try:
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(new_state, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"写入状态文件失败: {e}", file=sys.stderr)
        sys.exit(3)

    if not has_change:
        # stdout 为空
        return


def cmd_claim(args):
    repo = args.repo
    number = args.number
    user = args.user
    max_count = args.max
    current_time = datetime.now(timezone.utc)

    if not user:
        print("错误: --user 参数为必填", file=sys.stderr)
        sys.exit(1)

    # 判断条目类型
    info = analyze_claims(repo, number, current_time)
    if info is None:
        print(f"条目不存在: #{number}")
        sys.exit(1)

    # a. 已关闭/已合并
    if info["item_state"] != "open" or info["is_merged"]:
        print(f"拒绝认领: 条目 #{number} 已关闭或已合并")
        sys.exit(1)

    # b. PR 且 draft
    if info["is_pr"] and info["is_draft"]:
        print(f"拒绝认领: PR #{number} 为 draft")
        sys.exit(1)

    # c. 有效认领数 >= max（重要关联豁免：--related 声明理由后不受满员限制）
    valid_count = len(info["valid_claims"])
    if valid_count >= max_count and not args.related:
        print(f"拒绝认领: 已满员 {valid_count}/{max_count}（如与自身/使用者有重要关联，可用 --related <理由> 豁免）")
        sys.exit(1)

    # d. 自己已认领过（未 withdraw/未完成）
    user_info = info["all_authors"].get(user, {"claims": [], "withdraws": [], "dones": []})
    has_claim = bool(user_info["claims"])
    has_withdraw = bool(user_info["withdraws"])
    has_done = bool(user_info["dones"])

    # PR 场景下检查非 PENDING review 作为完成证据
    has_non_pending_review = False
    if info["is_pr"]:
        for r in info["reviews"]:
            if r["user"] == user and r["state"] != "PENDING":
                has_non_pending_review = True
                break

    if has_claim and not has_withdraw and not has_done and not has_non_pending_review:
        print(f"拒绝认领: 你已对 #{number} 进行过有效认领")
        sys.exit(1)

    # e. 自己是条目作者
    if user == info["item_author"]:
        print(f"拒绝认领: 你是条目 #{number} 的作者")
        sys.exit(1)

    # 发认领评论（重要关联豁免时注明理由，协议 §2.4）
    body = f"[AGENT-REVIEW] 认领 #{number} 审查（agent: {user}）\n\n24 小时内提交审核结论，遵守仓库 AGENT-REVIEW.md 协议。"
    if args.related:
        body += f"\n重要关联：{args.related}"
    result = run_gh([f"repos/{repo}/issues/{number}/comments", "-X", "POST", "-f", f"body={body}", "--jq", "{id: .id, html_url: .html_url}"], check=False)
    if result is None:
        print("认领评论发送失败", file=sys.stderr)
        sys.exit(1)

    comment_id = result.get("id")

    # 发完立即重新计数，检查是否超过 max
    new_info = analyze_claims(repo, number, current_time)
    new_count = len(new_info["valid_claims"]) if new_info else valid_count
    if new_count > max_count:
        print(f"警告: 认领后有效认领数 {new_count} 超过上限 {max_count}，可能因并发竞争，建议 withdraw。")

    print(f"认领成功: #{number} 评论 id={comment_id}")


def cmd_withdraw(args):
    repo = args.repo
    number = args.number
    user = args.user

    if not user:
        print("错误: --user 参数为必填", file=sys.stderr)
        sys.exit(1)

    current_time = datetime.now(timezone.utc)
    info = analyze_claims(repo, number, current_time)
    if info is None:
        print(f"条目不存在: #{number}")
        sys.exit(1)

    # 检查自己是否已有有效认领
    user_claims = info["all_authors"].get(user, {}).get("claims", [])
    user_withdraws = info["all_authors"].get(user, {}).get("withdraws", [])

    # 已 withdraw 过或从未认领 -> 无需退出
    if not user_claims or user_withdraws:
        print(f"无需退出: 你在 #{number} 没有有效的认领")
        sys.exit(0)

    # 发送退出评论
    body = f"[AGENT-REVIEW-WITHDRAW] 退出 #{number} 认领（agent: {user}）"
    result = run_gh([f"repos/{repo}/issues/{number}/comments", "-X", "POST", "-f", f"body={body}", "--jq", "{id: .id, html_url: .html_url}"], check=False)
    if result is None:
        print("退出评论发送失败", file=sys.stderr)
        sys.exit(1)

    print(f"退出成功: #{number} 评论 id={result.get('id')}")


def cmd_mine(args):
    repo = args.repo
    number = args.number
    user = args.user

    if not user:
        print("错误: --user 参数为必填", file=sys.stderr)
        sys.exit(1)

    current_time = datetime.now(timezone.utc)
    info = analyze_claims(repo, number, current_time)
    if info is None:
        print(f"条目不存在: #{number}")
        sys.exit(1)

    user_info = info["all_authors"].get(user, {"claims": [], "withdraws": [], "dones": []})
    has_withdraw = bool(user_info["withdraws"])
    has_done = bool(user_info["dones"])

    has_non_pending_review = False
    if info["is_pr"]:
        for r in info["reviews"]:
            if r["user"] == user and r["state"] != "PENDING":
                has_non_pending_review = True
                break

    # 优先级: 已退出 > 已完成 > 已认领
    if has_withdraw:
        print("已退出")
        return

    if has_done or has_non_pending_review:
        print("已完成")
        return

    # 查找有效认领
    for claim in info["valid_claims"]:
        if claim["login"] == user:
            print(f"已认领({claim['claimed_at']})")
            return

    print("未认领")


def main():
    _configure_stdout()
    parser = argparse.ArgumentParser(
        prog="agent-review.py",
        description="vrchat-assistant 仓库协作审核参考脚本（REST-only）",
    )
    parser.add_argument("--repo", default=REPO_DEFAULT, help="目标仓库，格式 owner/repo")

    subparsers = parser.add_subparsers(dest="command", required=True)

    p_status = subparsers.add_parser("status", help="列出 open PR 和 issue 的认领状态")
    p_status.add_argument("--max", type=int, default=MAX_DEFAULT, help="认领上限，默认 3")
    p_status.add_argument("--detail", action="store_true", help="显示认领者详情")
    p_status.set_defaults(func=cmd_status)

    p_scan = subparsers.add_parser("scan", help="监测 PR/issue 变化")
    p_scan.add_argument("--state", help="状态文件路径")
    p_scan.set_defaults(func=cmd_scan)

    p_claim = subparsers.add_parser("claim", help="认领审查条目")
    p_claim.add_argument("number", type=int, help="PR/Issue 编号")
    p_claim.add_argument("--user", default=os.environ.get("GITHUB_USER", ""), help="当前 agent 的 GitHub login")
    p_claim.add_argument("--max", type=int, default=MAX_DEFAULT, help="认领上限，默认 3")
    p_claim.add_argument("--related", default="", help="重要关联理由（与自身/背后使用者有重要关联时填写，可绕过满员限制，协议 §2.4）")
    p_claim.set_defaults(func=cmd_claim)

    p_withdraw = subparsers.add_parser("withdraw", help="退出认领")
    p_withdraw.add_argument("number", type=int, help="PR/Issue 编号")
    p_withdraw.add_argument("--user", default=os.environ.get("GITHUB_USER", ""), help="当前 agent 的 GitHub login")
    p_withdraw.set_defaults(func=cmd_withdraw)

    p_mine = subparsers.add_parser("mine", help="查询自己在某条目上的状态")
    p_mine.add_argument("number", type=int, help="PR/Issue 编号")
    p_mine.add_argument("--user", default=os.environ.get("GITHUB_USER", ""), help="当前 agent 的 GitHub login")
    p_mine.set_defaults(func=cmd_mine)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
