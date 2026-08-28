"""Single source of truth for every AI provider REST root used by the Python helper scripts.

Python twin of `crates/thoth-core/src/endpoints.rs` and `scout/lib/env.ts`: the three layers read
the SAME `THOTH_*_BASE_URL` variables, so pointing Thoth at a gateway or a moved endpoint is one
edit to the environment rather than a hunt for literals across Rust, TypeScript and Python.

Usage from a script one directory down (`scripts/<area>/<script>.py`):

    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from lib.endpoints import novita_chat_completions
"""

from __future__ import annotations

import os

# Defaults only — every one of these is overridable by the variable named beside it.
DEFAULTS = {
    "THOTH_GROQ_BASE_URL": "https://api.groq.com/openai/v1",
    "THOTH_OPENAI_BASE_URL": "https://api.openai.com/v1",
    "THOTH_CLAUDE_BASE_URL": "https://api.anthropic.com/v1",
    "THOTH_GEMINI_BASE_URL": "https://generativelanguage.googleapis.com/v1beta",
    "THOTH_NOVITA_BASE_URL": "https://api.novita.ai/openai",
    # Novita's own (non-OpenAI-compatible) API: image generation, merge-face.
    "THOTH_NOVITA_API_BASE_URL": "https://api.novita.ai",
    "THOTH_OPENROUTER_BASE_URL": "https://openrouter.ai/api",
    "THOTH_ELEVENLABS_BASE_URL": "https://api.elevenlabs.io/v1",
}


def base_url(variable: str) -> str:
    """Root for `variable`, trailing slashes stripped so callers can join with a leading slash."""
    value = (os.environ.get(variable) or "").strip()
    return (value or DEFAULTS[variable]).rstrip("/")


def groq() -> str:
    return base_url("THOTH_GROQ_BASE_URL")


def groq_audio_transcriptions() -> str:
    return f"{groq()}/audio/transcriptions"


def novita() -> str:
    return base_url("THOTH_NOVITA_BASE_URL")


def novita_chat_completions() -> str:
    return f"{novita()}/chat/completions"


def novita_api() -> str:
    return base_url("THOTH_NOVITA_API_BASE_URL")


def openrouter() -> str:
    return base_url("THOTH_OPENROUTER_BASE_URL")


def openrouter_chat_completions() -> str:
    return f"{openrouter()}/v1/chat/completions"


def elevenlabs() -> str:
    return base_url("THOTH_ELEVENLABS_BASE_URL")


def elevenlabs_voices() -> str:
    return f"{elevenlabs()}/voices"


if __name__ == "__main__":
    # Smallest runnable check: defaults apply, an override redirects every path built from the root,
    # and a blank value is treated as unset rather than collapsing the URL to "/chat/completions".
    assert novita_chat_completions() == f"{DEFAULTS['THOTH_NOVITA_BASE_URL']}/chat/completions"
    os.environ["THOTH_NOVITA_BASE_URL"] = "https://gateway.test/novita/"
    assert novita_chat_completions() == "https://gateway.test/novita/chat/completions"
    os.environ["THOTH_NOVITA_BASE_URL"] = "   "
    assert novita() == DEFAULTS["THOTH_NOVITA_BASE_URL"]
    del os.environ["THOTH_NOVITA_BASE_URL"]
    print("endpoints.py OK")
