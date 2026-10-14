"""显式创建隐藏的独立控制台，兼容 Windows PowerShell 5 和 PowerShell 7。"""

import argparse
import base64
import json
import os
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--command", required=True)
    args = parser.parse_args()
    command = json.loads(base64.b64decode(args.command).decode("utf-8"))
    kwargs = {}
    if sys.platform == "win32":
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        kwargs = {"creationflags": subprocess.CREATE_NEW_CONSOLE, "startupinfo": startup}
        if Path(command[0]).suffix.lower() in {".cmd", ".bat"}:
            # cmd.exe uses different quote rules from the C runtime. Callers pass
            # a trusted executable path and fixed flags/numeric service ports.
            inner = f'"{command[0]}" ' + subprocess.list2cmdline(command[1:])
            shell = subprocess.list2cmdline([os.environ["COMSPEC"]])
            command = f'{shell} /d /s /c "{inner}"'
    child_env = os.environ.copy()
    child_env["MOONCELL_DEV_CONSOLE_ISOLATED"] = "1"
    child = subprocess.Popen(
        command, stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr,
        env=child_env, **kwargs,
    )
    try:
        return child.wait()
    except KeyboardInterrupt:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(child.pid), "/T", "/F"], check=False,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        else:
            child.terminate()
        child.wait()
        return 130


if __name__ == "__main__":
    sys.exit(main())
