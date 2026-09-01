import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from thoth_control_plane.acquisition.browser import (
    HeadlessBrowserError,
    ScraplingHeadlessBrowser,
    active_scrapling_session_count,
    check_scrapling_capability,
    extract_browser_snapshot,
)
from thoth_control_plane.acquisition.models import AcquisitionReason

POST_URL = "https://www.tiktok.com/@creator/video/1234567890"


class _Selection:
    def __init__(self, values: list[str]) -> None:
        self._values = values

    def getall(self) -> list[str]:
        return self._values

    def get(self) -> str | None:
        return self._values[0] if self._values else None


def _response(
    url: str,
    *,
    og_title: str | None = "caption",
    author: str | None = "creator",
    video_sources: list[str] | None = None,
    captured_xhr: list[object] | None = None,
):
    values = {
        'meta[property="og:title"]::attr(content)': [og_title] if og_title else [],
        'meta[name="author"]::attr(content)': [author] if author else [],
        "video::attr(src)": video_sources
        if video_sources is not None
        else ["https://video.example/a.mp4"],
    }

    class FakeResponse:
        pass

    FakeResponse.url = url
    FakeResponse.captured_xhr = captured_xhr or []
    FakeResponse.css = lambda self, selector: _Selection(values.get(selector, []))
    return FakeResponse()


def _session_returning(response_or_exc):
    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return None

        async def fetch(self, url: str, **kwargs):
            if isinstance(response_or_exc, BaseException):
                raise response_or_exc
            return response_or_exc

    return lambda **kwargs: FakeSession()


def test_fixture_is_reduced_to_sanitized_candidates() -> None:
    fixture = json.loads(
        (
            Path(__file__).resolve().parent.parent / "fixtures" / "tiktok" / "headless_post.json"
        ).read_text(encoding="utf-8")
    )
    snapshot = extract_browser_snapshot(**fixture)
    assert snapshot.post_candidates[0].owner_handle == "creator"
    assert snapshot.post_candidates[0].post_id == "1234567890"
    assert len(snapshot.media_candidates) == 1
    dumped = snapshot.model_dump_json()
    assert "fixture-secret" not in dumped
    assert "itemInfo" not in dumped


def _xhr_item(unique_id: str, post_id: str = "1234567890") -> list[dict]:
    return [
        {
            "status": 200,
            "body": {
                "itemInfo": {
                    "itemStruct": {
                        "id": post_id,
                        "desc": "caption",
                        "author": {"uniqueId": unique_id},
                    }
                }
            },
        }
    ]


@pytest.mark.parametrize(
    "meta_author",
    ["someone-else", None, "@creator", "CREATOR", " creator "],
    ids=["wrong", "missing", "at-prefixed", "different-case", "whitespace"],
)
def test_xhr_unique_id_wins_over_a_wrong_or_missing_meta_author(meta_author: str | None) -> None:
    snapshot = extract_browser_snapshot(
        final_url=POST_URL,
        og_title="caption",
        author=meta_author,
        video_sources=["https://video.example/a.mp4"],
        captured_xhr=_xhr_item("creator"),
    )
    assert snapshot.post_candidates[0].owner_handle == "creator"


def _xhr_item_with_desc(desc: object, post_id: str = "1234567890") -> list[dict]:
    item = _xhr_item("creator", post_id)
    item[0]["body"]["itemInfo"]["itemStruct"]["desc"] = desc
    return item


def test_authoritative_empty_caption_is_not_replaced_by_the_page_title() -> None:
    # TikTok emits "<display name> on TikTok" as og:title for a caption-less
    # post. An empty `desc` from the matching item struct is an answer, not a
    # missing signal, so the page title must never be promoted to a caption.
    snapshot = extract_browser_snapshot(
        final_url=POST_URL,
        og_title="Ripael on TikTok",
        author="creator",
        video_sources=["https://video.example/a.mp4"],
        captured_xhr=_xhr_item_with_desc(""),
    )
    assert snapshot.post_candidates[0].caption == ""


def test_authoritative_caption_wins_over_the_page_title() -> None:
    snapshot = extract_browser_snapshot(
        final_url=POST_URL,
        og_title="Ripael on TikTok",
        author="creator",
        video_sources=["https://video.example/a.mp4"],
        captured_xhr=_xhr_item_with_desc("the real caption"),
    )
    assert snapshot.post_candidates[0].caption == "the real caption"


@pytest.mark.parametrize(
    "captured_xhr",
    [[], _xhr_item_with_desc("", post_id="9999999999"), _xhr_item_with_desc(None)],
    ids=["no-xhr", "post-id-mismatch", "non-string-desc"],
)
def test_page_title_never_stands_in_for_a_missing_caption(
    captured_xhr: list[dict],
) -> None:
    snapshot = extract_browser_snapshot(
        final_url=POST_URL,
        og_title="Ripael on TikTok",
        author="creator",
        video_sources=["https://video.example/a.mp4"],
        captured_xhr=captured_xhr,
    )
    assert snapshot.post_candidates[0].caption == ""


def test_xhr_unique_id_mismatch_downgrades_even_if_meta_author_matches() -> None:
    snapshot = extract_browser_snapshot(
        final_url=POST_URL,
        og_title="caption",
        author="creator",
        video_sources=["https://video.example/a.mp4"],
        captured_xhr=_xhr_item("someone-else"),
    )
    assert snapshot.post_candidates == []


def test_missing_xhr_signal_falls_back_to_a_mismatching_meta_author() -> None:
    snapshot = extract_browser_snapshot(
        final_url=POST_URL,
        og_title="caption",
        author="someone-else",
        video_sources=["https://video.example/a.mp4"],
        captured_xhr=[],
    )
    assert snapshot.post_candidates == []


@pytest.mark.parametrize(
    "meta_author",
    ["creator", "@creator", "CREATOR", " creator "],
    ids=["exact", "at-prefixed", "different-case", "whitespace"],
)
def test_missing_xhr_signal_falls_back_to_a_matching_meta_author_normalized(
    meta_author: str,
) -> None:
    snapshot = extract_browser_snapshot(
        final_url=POST_URL,
        og_title="caption",
        author=meta_author,
        video_sources=["https://video.example/a.mp4"],
        captured_xhr=[],
    )
    assert snapshot.post_candidates[0].owner_handle == "creator"


@pytest.mark.asyncio
async def test_production_adapter_uses_headless_network_capture_then_closes() -> None:
    calls: list[tuple[str, object]] = []

    class FakeResponse:
        url = "https://www.tiktok.com/@creator/video/1234567890"
        captured_xhr: list[object] = []  # noqa: RUF012

        def css(self, selector: str):
            calls.append(("css", selector))
            values = {
                'meta[property="og:title"]::attr(content)': ["caption"],
                'meta[name="author"]::attr(content)': ["creator"],
                "video::attr(src)": ["https://video.example/a.mp4"],
            }

            class Selection:
                def getall(self) -> list[str]:
                    return values.get(selector, [])

                def get(self) -> str | None:
                    selected = values.get(selector, [])
                    return selected[0] if selected else None

            return Selection()

    class FakeSession:
        async def __aenter__(self):
            calls.append(("enter", True))
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            calls.append(("exit", exc_type))

        async def fetch(self, url: str, **kwargs):
            calls.append(("fetch", kwargs))
            return FakeResponse()

    browser = ScraplingHeadlessBrowser(session_factory=lambda **kwargs: FakeSession())
    snapshot = await browser.fetch("https://www.tiktok.com/@creator/video/1234567890")
    await browser.close()
    fetch_kwargs = next(value for name, value in calls if name == "fetch")
    assert fetch_kwargs["network_idle"] is True
    assert fetch_kwargs["timeout"] == 45_000
    assert any(name == "exit" for name, _ in calls)
    assert snapshot.media_candidates
    assert active_scrapling_session_count() == 0


@pytest.mark.asyncio
async def test_timeout_during_fetch_is_classified_and_closes() -> None:
    browser = ScraplingHeadlessBrowser(session_factory=_session_returning(TimeoutError("boom")))
    with pytest.raises(HeadlessBrowserError) as exc_info:
        await browser.fetch(POST_URL)
    assert exc_info.value.reason == AcquisitionReason.HEADLESS_TIMEOUT
    assert active_scrapling_session_count() == 0


@pytest.mark.asyncio
async def test_navigation_away_from_post_is_classified_as_blocked() -> None:
    response = _response("https://www.tiktok.com/login", video_sources=[])
    browser = ScraplingHeadlessBrowser(session_factory=_session_returning(response))
    with pytest.raises(HeadlessBrowserError) as exc_info:
        await browser.fetch(POST_URL)
    assert exc_info.value.reason == AcquisitionReason.HEADLESS_BLOCKED
    assert active_scrapling_session_count() == 0


@pytest.mark.asyncio
async def test_missing_media_candidates_is_classified_as_incomplete() -> None:
    response = _response(POST_URL, video_sources=[])
    browser = ScraplingHeadlessBrowser(session_factory=_session_returning(response))
    with pytest.raises(HeadlessBrowserError) as exc_info:
        await browser.fetch(POST_URL)
    assert exc_info.value.reason == AcquisitionReason.HEADLESS_INCOMPLETE
    assert active_scrapling_session_count() == 0


@pytest.mark.asyncio
async def test_missing_post_candidates_is_classified_as_incomplete() -> None:
    response = _response(POST_URL, og_title=None, author="someone-else")
    browser = ScraplingHeadlessBrowser(session_factory=_session_returning(response))
    with pytest.raises(HeadlessBrowserError) as exc_info:
        await browser.fetch(POST_URL)
    assert exc_info.value.reason == AcquisitionReason.HEADLESS_INCOMPLETE
    assert active_scrapling_session_count() == 0


@pytest.mark.asyncio
async def test_cancellation_during_fetch_still_closes_session() -> None:
    entered = asyncio.Event()
    exited = asyncio.Event()

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            exited.set()
            return None

        async def fetch(self, url: str, **kwargs):
            entered.set()
            await asyncio.sleep(3600)

    browser = ScraplingHeadlessBrowser(session_factory=lambda **kwargs: FakeSession())
    task = asyncio.create_task(browser.fetch(POST_URL))
    await asyncio.wait_for(entered.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert exited.is_set()
    assert active_scrapling_session_count() == 0


@pytest.mark.asyncio
async def test_close_is_idempotent() -> None:
    browser = ScraplingHeadlessBrowser(session_factory=_session_returning(_response(POST_URL)))
    await browser.fetch(POST_URL)
    await browser.close()
    await browser.close()
    assert active_scrapling_session_count() == 0


@pytest.mark.asyncio
async def test_capability_check_reports_unavailable_without_optional_extra(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Simulate the missing extra instead of reading ambient environment state:
    # a `None` entry makes the lazy `from patchright.async_api import ...`
    # raise ImportError whether or not the extra happens to be installed.
    monkeypatch.setitem(sys.modules, "patchright.async_api", None)
    capability = await check_scrapling_capability()
    assert capability.available is False
    assert capability.code == "acquisition_dependency_unavailable"


def test_importing_browser_module_does_not_import_scrapling_or_patchright() -> None:
    probe = (
        "import sys;"
        "import thoth_control_plane.acquisition.browser;"
        "assert 'scrapling' not in sys.modules;"
        "assert 'patchright' not in sys.modules"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
