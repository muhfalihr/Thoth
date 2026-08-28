import pytest

from thoth_control_plane import CONTRACT_VERSION
from thoth_control_plane.config import Settings


def test_package_exposes_the_v1_contract_version() -> None:
    assert CONTRACT_VERSION == 1


def test_settings_require_a_complete_legacy_gateway_pair() -> None:
    with pytest.raises(ValueError, match="legacy gateway"):
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_LEGACY_API_BASE_URL="http://legacy.test",
        )
