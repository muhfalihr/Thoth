"""FastAPI boundary for the versioned Thoth control-plane contract."""

from thoth_control_plane.api.app import create_app

__all__ = ["create_app"]
