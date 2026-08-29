"""Export the public control-plane contract in a reproducible form."""

from __future__ import annotations

import json
from pathlib import Path

from thoth_control_plane.api import create_app
from thoth_control_plane.config import Settings


def main() -> None:
    document = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="openapi-export")).openapi()
    destination = Path(__file__).resolve().parents[1] / "openapi.json"
    destination.write_text(
        json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
