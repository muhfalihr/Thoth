"""Read-only adapters for external workflow systems."""

from thoth_control_plane.infrastructure.legacy_reader import LegacyJobReader

__all__ = ["LegacyJobReader"]
