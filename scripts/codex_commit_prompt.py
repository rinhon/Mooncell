"""Ask about committing code changed during a Codex turn; never stage or commit."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
QUESTION = "是否提交本轮修改的代码？"
CODE_SUFFIXES = {
    ".bat", ".c", ".cc", ".cmd", ".cpp", ".cs", ".css", ".go", ".h",
    ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsx", ".less",
    ".mjs", ".cjs", ".ps1", ".psm1", ".py", ".pyi", ".rb", ".rs",
    ".sass", ".scss", ".sh", ".sql", ".svelte", ".toml", ".ts", ".tsx",
    ".vue", ".xml", ".yaml", ".yml",
}
CODE_NAMES = {"dockerfile", "makefile", "justfile", ".gitignore", ".dockerignore"}


def git(root: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", "--no-optional-locks", "-C", str(root), *args],
        check=True, capture_output=True, timeout=10,
    ).stdout


def is_code(path: str) -> bool:
    file = Path(path)
    return file.suffix.lower() in CODE_SUFFIXES or file.name.lower() in CODE_NAMES


def snapshot(root: Path) -> dict:
    """Fingerprint Git-visible pending code, including staged and untracked files."""
    records = iter(git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").split(b"\0"))
    paths = set()
    for record in records:
        if not record:
            continue
        paths.add(record[3:].decode("utf-8", errors="surrogateescape"))
        if b"R" in record[:2] or b"C" in record[:2]:
            paths.add(next(records).decode("utf-8", errors="surrogateescape"))

    index = {}
    for record in git(root, "ls-files", "--stage", "-z").split(b"\0"):
        if record:
            entry, path = record.split(b"\t", 1)
            index.setdefault(path.decode("utf-8", errors="surrogateescape"), []).append(entry.decode("ascii"))

    result = {}
    for path in sorted(paths):
        if not is_code(path):
            continue
        file = root / path
        if file.is_symlink():
            digest = hashlib.sha256(str(file.readlink()).encode("utf-8")).hexdigest()
        elif file.is_file():
            with file.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
        else:
            digest = None
        result[path] = {"worktree": digest, "index": index.get(path, [])}
    return result


def handle_event(payload: dict, root: Path = ROOT, state_dir: Path | None = None) -> dict:
    event = payload.get("hook_event_name")
    if event not in {"UserPromptSubmit", "Stop"}:
        return {}
    session_id, turn_id = payload.get("session_id"), payload.get("turn_id")
    if not session_id or not turn_id:
        return {}
    # Never reuse a baseline in another repository or an unrelated working tree.
    if Path(git(Path(payload["cwd"]), "rev-parse", "--show-toplevel").decode().strip()).resolve() != root.resolve():
        return {}
    state_dir = state_dir or root / ".cache" / "codex-commit-prompt"
    state_file = state_dir / (hashlib.sha256(session_id.encode()).hexdigest() + ".json")

    if event == "UserPromptSubmit":
        state_dir.mkdir(parents=True, exist_ok=True)
        state = {"turn_id": turn_id, "files": snapshot(root), "prompted": False}
        state_file.write_text(json.dumps(state, ensure_ascii=True), encoding="utf-8")
        return {"hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": (
                "本项目已启用提交提醒。若本轮修改了代码且仍有未提交改动，"
                f"请在完成工作后的最终回复中询问用户：{QUESTION}"
                "用户明确同意后才提交，并且只提交本轮改动；不要混入轮次开始前已有的修改。"
                "没有本轮代码改动、已经提交，或用户已明确拒绝本轮提交时，不必询问。"
                "提交提醒 Hook 不代表用户授权提交。"
            ),
        }}

    if payload.get("stop_hook_active") or not state_file.exists():
        return {}
    state = json.loads(state_file.read_text(encoding="utf-8"))
    if state.get("turn_id") != turn_id or state.get("prompted"):
        return {}
    # Ignore historical dirty files that were untouched or became clean this turn.
    current = snapshot(root)
    changed = [path for path, value in current.items() if state["files"].get(path) != value]
    if not changed:
        return {}
    last_message = payload.get("last_assistant_message") or ""
    if QUESTION.rstrip("？") in last_message:
        return {}
    state["prompted"] = True
    state_file.write_text(json.dumps(state, ensure_ascii=True), encoding="utf-8")
    return {
        "decision": "block",
        "reason": (
            "本轮检测到新增的未提交代码改动。请结合本轮对话核对改动归属；"
            "若用户尚未明确拒绝或授权本轮提交，请向用户发出一次提交询问："
            f"{QUESTION}然后等待用户回复。不要自动暂存、提交或推送。"
            "如用户已拒绝、已授权提交并已完成，或这些改动来自其他并行工作，请直接结束。"
        ),
    }


def main() -> None:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        output = handle_event(payload)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        output = {"systemMessage": "提交提醒 Hook 执行失败，本轮无法自动核对代码改动，请手动检查。"}
    print(json.dumps(output, ensure_ascii=True))


if __name__ == "__main__":
    main()
