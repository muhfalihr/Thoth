import pytest

from thoth_control_plane.acquisition.adapters.tiktok import (
    TikTokUrlError,
    canonicalize_tiktok_post_url,
    validate_tiktok_entry_url,
)


@pytest.mark.parametrize(
    "url",
    [
        "https://www.tiktok.com/@creator/video/1234567890",
        "https://m.tiktok.com/@creator/video/1234567890?share=1",
        "https://vm.tiktok.com/ZM123abc/",
        "https://vt.tiktok.com/ZM456def/",
    ],
)
def test_entry_validation_accepts_supported_public_tiktok_urls(url: str) -> None:
    assert validate_tiktok_entry_url(url).host.endswith("tiktok.com")


@pytest.mark.parametrize(
    "url",
    [
        "http://www.tiktok.com/@creator/video/1234567890",
        "https://user:password@www.tiktok.com/@creator/video/1234567890",
        "https://www.tiktok.com:8443/@creator/video/1234567890",
        "https://evil.example/@creator/video/1234567890",
        "https://www.tiktok.com/@creator",
        "https://www.tiktok.com:abc/@creator/video/1234567890",
        "https://[::1/@creator/video/1234567890",
    ],
)
def test_entry_validation_rejects_unsafe_or_non_post_urls(url: str) -> None:
    with pytest.raises(TikTokUrlError):
        validate_tiktok_entry_url(url)


def test_canonicalization_strips_query_and_fragment() -> None:
    identity = canonicalize_tiktok_post_url(
        "https://www.tiktok.com/@creator/video/1234567890?share=1#comments"
    )
    assert str(identity.canonical_url) == ("https://www.tiktok.com/@creator/video/1234567890")
    assert identity.post_id == "1234567890"
    assert identity.owner_handle == "creator"


def test_short_link_must_resolve_to_a_canonical_tiktok_post() -> None:
    validate_tiktok_entry_url("https://vm.tiktok.com/ZM123abc/")
    with pytest.raises(TikTokUrlError):
        canonicalize_tiktok_post_url("https://vm.tiktok.com/ZM123abc/")
    with pytest.raises(TikTokUrlError):
        canonicalize_tiktok_post_url("https://example.com/@creator/video/1234567890")
