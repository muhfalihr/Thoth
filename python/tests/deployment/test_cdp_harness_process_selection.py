"""Execute the harness's actual process-selection snippet against a fake procfs."""

import io
import re
from pathlib import Path
from unittest.mock import patch


def test_lifecycle_probe_signals_browser_not_renderer_or_zygote():
    script = (Path(__file__).resolve().parents[3] / "docker/test-cdp-offline.sh").read_text()
    snippet = re.search(r'python -c "(.*?)" >/dev/null \|\| fail chromium_signalled', script, re.S)
    assert snippet is not None
    commands = {
        "/proc/91/cmdline": b"/ms-playwright/chrome\x00--type=renderer\x00",
        "/proc/92/cmdline": b"/ms-playwright/chrome\x00--type=zygote\x00",
        "/proc/90/cmdline": b"/ms-playwright/chrome\x00--headless=new\x00",
    }
    with (
        patch("os.listdir", return_value=["91", "92", "90"]),
        patch("signal.SIGKILL", 9, create=True),
        patch("builtins.open", side_effect=lambda name, mode: io.BytesIO(commands[name])),
        patch("os.kill") as kill,
    ):
        exec(compile(snippet.group(1), "harness-browser-selection", "exec"), {})
    kill.assert_called_once_with(90, 9)
