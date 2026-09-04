"""Behavioural tests for the legacy CDP health probe shipped in Compose.

The probe is a Python one-liner embedded in `compose.stage1.local.yml`,
because the sidecar may only use interpreters already present in the pinned
image. Asserting on its text would only restate it, so these tests extract the
exact shipped source, point it at a local fake CDP endpoint, and execute it.
A login wall, a challenge page, or a look-alike host must fail the probe and
therefore block worker startup.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

COMPOSE_PATH = Path(__file__).resolve().parents[3] / "compose.stage1.local.yml"


def _cdp_probe_source() -> str:
    """Return the Python source the legacy-cdp health check actually runs."""
    block = re.search(
        r"(?ms)^  legacy-cdp:\n.*?^      test:\n(?P<probe>.*?)^      interval:",
        COMPOSE_PATH.read_text(encoding="utf-8"),
    )
    assert block is not None, "legacy-cdp health check not found"
    lines = [line.strip() for line in block.group("probe").splitlines()]
    folded = " ".join(line for line in lines if line and line not in ("- CMD-SHELL", "- >-"))
    return folded.split('"', 1)[1].rsplit('"', 1)[0]


def _handler_factory(targets: list[dict[str, str]], version_status: int) -> Callable[..., object]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/json/version":
                self._respond(version_status, b"{}")
            elif self.path == "/json":
                self._respond(200, json.dumps(targets).encode("utf-8"))
            else:
                self._respond(404, b"{}")

        def _respond(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            return

    return Handler


def _probe_exit_code(targets: list[dict[str, str]], version_status: int = 200) -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_factory(targets, version_status))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        source = _cdp_probe_source().replace("18800", str(server.server_address[1]))
        return subprocess.run([sys.executable, "-c", source], capture_output=True).returncode
    finally:
        server.shutdown()
        server.server_close()


def _page(url: str) -> dict[str, str]:
    return {"type": "page", "url": url, "title": "target"}


def test_probe_passes_on_a_real_tiktok_page_target() -> None:
    assert _probe_exit_code([_page("https://www.tiktok.com/@creator/video/1234567890")]) == 0


def test_probe_fails_when_the_devtools_version_endpoint_is_unhealthy() -> None:
    assert _probe_exit_code([_page("https://www.tiktok.com/@creator/video/1")], 500) != 0


def test_probe_fails_without_any_page_target() -> None:
    assert _probe_exit_code([]) != 0
    assert _probe_exit_code([{"type": "service_worker", "url": "https://www.tiktok.com/"}]) != 0


def test_probe_fails_on_an_authentication_wall() -> None:
    assert _probe_exit_code([_page("https://www.tiktok.com/login?redirect_url=%2Ffoo")]) != 0
    assert _probe_exit_code([_page("https://www.tiktok.com/signup")]) != 0


def test_probe_fails_on_a_challenge_or_captcha_page() -> None:
    assert _probe_exit_code([_page("https://www.tiktok.com/captcha/verify")]) != 0
    assert _probe_exit_code([_page("https://www.tiktok.com/?challenge=1")]) != 0
    assert _probe_exit_code([_page("https://www.tiktok.com/security-check")]) != 0


def test_probe_fails_on_a_look_alike_host() -> None:
    assert _probe_exit_code([_page("https://tiktok.com.evil.example/@creator/video/1")]) != 0
    assert _probe_exit_code([_page("https://eviltiktok.com/@creator/video/1")]) != 0


def test_probe_fails_on_an_insecure_scheme() -> None:
    assert _probe_exit_code([_page("http://www.tiktok.com/@creator/video/1")]) != 0
