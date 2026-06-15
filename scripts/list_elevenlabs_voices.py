#!/usr/bin/env python3
"""List all available ElevenLabs voices in your account.

Usage:
    python scripts/list_elevenlabs_voices.py

Requires: THOTH_ELEVENLABS_API_KEY in .env or environment.
"""

import sys
import os
import json
from pathlib import Path

# Load .env manually (no dotenv dependency needed)
env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

api_key = os.environ.get("THOTH_ELEVENLABS_API_KEY", "")
if not api_key:
    print("ERROR: THOTH_ELEVENLABS_API_KEY not set in .env")
    sys.exit(1)

try:
    import urllib.request
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/voices",
        headers={"xi-api-key": api_key},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())
except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)

voices = data.get("voices", [])
if not voices:
    print("No voices found.")
    sys.exit(0)

# Print formatted table
print(f"\n{'Voice Name':<35} {'Voice ID':<30} {'Category':<15} {'Labels'}")
print("-" * 100)
for v in sorted(voices, key=lambda x: x.get("name", "")):
    name     = v.get("name", "?")[:34]
    vid      = v.get("voice_id", "?")
    category = v.get("category", "?")[:14]
    labels   = ", ".join(
        f"{k}={val}" for k, val in (v.get("labels") or {}).items()
        if k in ("language", "accent", "gender", "age", "use_case")
    )[:50]
    print(f"{name:<35} {vid:<30} {category:<15} {labels}")

print(f"\nTotal: {len(voices)} voice(s)")
print("\nTips untuk konten Indonesia:")
print("  - Pilih voice dengan label 'language=Indonesian' jika ada")
print("  - Atau gunakan model 'eleven_multilingual_v2' dengan voice apapun")
print("  - Voice Energetic/Conversational cocok untuk reaction content")
print("\nSet di config.toml:")
print("  [reaction.tts]")
print("  provider = \"elevenlabs\"")
print("  elevenlabs_voice_id = \"<paste Voice ID di sini>\"")
print("  elevenlabs_model = \"eleven_multilingual_v2\"")
