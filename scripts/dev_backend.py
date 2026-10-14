"""在独立 Windows 控制台中重载 Uvicorn，避免 Ctrl+C 波及开发启动器。"""

import argparse
import ctypes
import logging
import os
import signal
import sys
from pathlib import Path

import uvicorn
from uvicorn._subprocess import get_subprocess
from uvicorn.supervisors import ChangeReload


class IsolatedConsoleReload(ChangeReload):
    def restart(self):
        if sys.platform != "win32":
            return super().restart()
        # CTRL_C_EVENT cannot reliably target a worker PID on Windows. This
        # launcher MUST have its own console, as provided by dev-process.ps1.
        # Broadcast only inside that isolated console; the reloader's existing
        # signal handler ignores its own restart event, while the worker exits
        # through Uvicorn's normal graceful shutdown/lifespan path.
        self.is_restarting = True
        os.kill(0, signal.CTRL_C_EVENT)
        sys.stdout.write(" ")
        sys.stdout.flush()
        self.process.join(timeout=15)
        if self.process.is_alive():
            logging.getLogger("uvicorn.error").warning(
                "Reload worker did not stop in 15 seconds; terminating it."
            )
            self.process.terminate()
            self.process.join()
        self.is_restarting = False
        self.process = get_subprocess(config=self.config, target=self.target, sockets=self.sockets)
        self.process.start()


def main():
    if sys.platform == "win32":
        processes = (ctypes.c_ulong * 16)()
        count = ctypes.windll.kernel32.GetConsoleProcessList(processes, len(processes))
        # A Windows virtualenv executable may retain a redirector process in this
        # console, so process count is not necessarily one. The launcher sets
        # this flag only in the explicitly isolated child's environment.
        if count == 0 or os.environ.get("MOONCELL_DEV_CONSOLE_ISOLATED") != "1":
            raise RuntimeError("Use scripts\\dev.ps1 to launch this service in its own console.")
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload-dir", default="app")
    parser.add_argument("--reload-delay", type=float, default=1)
    args = parser.parse_args()
    sys.path.insert(0, str(Path.cwd()))
    config = uvicorn.Config(
        "app.main:app", host=args.host, port=args.port, reload=True,
        reload_dirs=[args.reload_dir], reload_delay=args.reload_delay,
    )
    server = uvicorn.Server(config)
    sock = config.bind_socket()
    IsolatedConsoleReload(config, target=server.run, sockets=[sock]).run()


if __name__ == "__main__":
    main()
