"""Exercise the hook against disposable real Git repositories."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from codex_commit_prompt import handle_event, QUESTION


class CommitPromptTests(unittest.TestCase):
    def setUp(self):
        cache = Path(__file__).resolve().parent.parent / ".cache" / "codex-hook-tests"
        cache.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=cache)
        assert Path(self.temp.name).resolve().is_relative_to(cache.resolve())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.state_dir = Path(self.temp.name) / "state"
        self.git("init", "-q")
        self.git("config", "user.name", "Hook Test")
        self.git("config", "user.email", "hook-test@example.invalid")
        self.write("app.py", "original\n")
        self.write("README.md", "docs\n")
        self.git("add", ".")
        self.git("commit", "-qm", "baseline")

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", str(self.root), *args], check=True,
            capture_output=True, timeout=10,
        ).stdout

    def write(self, path, content):
        (self.root / path).write_text(content, encoding="utf-8")

    def event(self, name, **extra):
        return handle_event({
            "session_id": "session-a", "turn_id": "turn-a",
            "cwd": str(self.root), "hook_event_name": name, **extra,
        }, self.root, self.state_dir)

    def test_read_only_and_historical_changes_do_not_prompt(self):
        self.write("app.py", "old uncommitted code\n")
        self.write("old.py", "old untracked code\n")
        context = self.event("UserPromptSubmit")
        self.assertIn(QUESTION, context["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.event("Stop"), {})

    def test_edit_existing_dirty_code_prompts_once(self):
        self.write("app.py", "old dirty\n")
        self.event("UserPromptSubmit")
        self.write("app.py", "new dirty\n")
        self.assertEqual(self.event("Stop")["decision"], "block")
        self.assertEqual(self.event("Stop"), {})

    def test_add_delete_stage_and_rename_code(self):
        for operation in ("add", "delete", "stage", "rename"):
            with self.subTest(operation=operation):
                self.git("reset", "--hard", "HEAD")
                added = self.root / "新增 文件.py"
                added.unlink(missing_ok=True)
                self.event("UserPromptSubmit")
                if operation == "add":
                    self.write(added.name, "new\n")
                elif operation == "delete":
                    (self.root / "app.py").unlink()
                elif operation == "stage":
                    self.write("app.py", "staged\n")
                    self.git("add", "app.py")
                else:
                    self.git("mv", "app.py", "renamed.py")
                self.assertEqual(self.event("Stop")["decision"], "block")

    def test_docs_and_reverted_changes_do_not_prompt(self):
        self.event("UserPromptSubmit")
        self.write("README.md", "changed docs\n")
        self.write("app.py", "temporary change\n")
        self.write("app.py", "original\n")
        self.assertEqual(self.event("Stop"), {})

    def test_committed_changes_do_not_prompt(self):
        self.event("UserPromptSubmit")
        self.write("app.py", "new\n")
        self.git("add", "app.py")
        self.git("commit", "-qm", "done")
        self.assertEqual(self.event("Stop"), {})

    def test_already_asked_and_continuation_do_not_prompt(self):
        self.event("UserPromptSubmit")
        self.write("app.py", "new\n")
        self.assertEqual(self.event("Stop", last_assistant_message=QUESTION), {})
        self.assertEqual(self.event("Stop", stop_hook_active=True), {})

    def test_missing_baseline_and_different_turn_do_not_prompt(self):
        self.assertEqual(self.event("Stop"), {})
        self.event("UserPromptSubmit")
        self.write("app.py", "new\n")
        self.assertEqual(self.event("Stop", turn_id="turn-b"), {})
        self.assertEqual(self.event("Stop", session_id="session-b"), {})

    def test_new_turn_replaces_baseline_and_state_has_no_content(self):
        self.event("UserPromptSubmit")
        self.write("app.py", "private source content\n")
        self.event("UserPromptSubmit", turn_id="turn-b")
        self.assertEqual(self.event("Stop", turn_id="turn-b"), {})
        state_text = next(self.state_dir.glob("*.json")).read_text(encoding="utf-8")
        self.assertNotIn("private source content", state_text)
        self.assertEqual(json.loads(state_text)["turn_id"], "turn-b")


if __name__ == "__main__":
    unittest.main()
