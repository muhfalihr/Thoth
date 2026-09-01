import asyncio
import json
import time
from pathlib import Path, PurePosixPath

import httpx
import pytest
from pydantic import SecretStr

from thoth_control_plane.acquisition.adapters.tikwm import (
    TikWmError,
    TikWmRateGate,
    TikWmResolver,
    parse_tikwm_payload,
)
from thoth_control_plane.acquisition.browser import HeadlessBrowserError
from thoth_control_plane.acquisition.materializer import MediaMaterializationError
from thoth_control_plane.acquisition.models import (
    AcquisitionReason,
    BrowserSnapshot,
    MaterializedMedia,
    ResolvedMedia,
    TikTokPost,
)
from thoth_control_plane.acquisition.service import TikTokAcquisitionService

TIKWM_FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent / "fixtures" / "tiktok" / "tikwm_success.json"
)
SOURCE_URL = "https://www.tiktok.com/@creator/video/1234567890"


class FakeBrowser:
    def __init__(self, snapshot: BrowserSnapshot | BaseException) -> None:
        self.snapshot = snapshot
        self.calls: list[str] = []

    async def fetch(self, url: str) -> BrowserSnapshot:
        self.calls.append("headless")
        if isinstance(self.snapshot, BaseException):
            raise self.snapshot
        return self.snapshot

    async def close(self) -> None:
        self.calls.append("close")


class FakeResolver:
    def __init__(self, resolution=None) -> None:
        self.resolution = resolution
        self.calls: list[str] = []

    async def resolve(self, source_url: str):
        self.calls.append("tikwm")
        if isinstance(self.resolution, BaseException):
            raise self.resolution
        return self.resolution

    @classmethod
    def from_payload(cls, payload: object) -> "FakeResolver":
        return cls(parse_tikwm_payload(payload))


class FakeMaterializer:
    def __init__(self, fail_for: frozenset[str] = frozenset()) -> None:
        self.calls: list[str] = []
        self._fail_for = fail_for

    async def materialize(self, candidate, destination, relative_location, strategy):
        del candidate, destination
        self.calls.append(str(strategy))
        if str(strategy) in self._fail_for:
            raise MediaMaterializationError()
        return MaterializedMedia(
            media_id="media_1",
            location=PurePosixPath(relative_location),
            bytes=10_100,
            checksum="sha256:" + "a" * 64,
            acquisition_strategy=strategy,
        )


def complete_snapshot() -> BrowserSnapshot:
    return BrowserSnapshot(
        final_url=SOURCE_URL,
        post_candidates=[
            TikTokPost(post_id="1234567890", owner_handle="creator", caption="caption")
        ],
        media_candidates=[
            ResolvedMedia(
                ephemeral_url=SecretStr("https://video.example/a.mp4"),
                media_type="video/mp4",
            )
        ],
    )


def tikwm_fixture_payload() -> dict:
    return json.loads(TIKWM_FIXTURE_PATH.read_text(encoding="utf-8"))


# Module-level services for the pre-provider and post-strategy failure-attempt
# contract tests below: neither test cares about their exact composition
# beyond the specific failure path each is meant to exercise.
service = TikTokAcquisitionService(
    FakeBrowser(complete_snapshot()), FakeResolver(), FakeMaterializer()
)

failing_cdn_service = TikTokAcquisitionService(
    FakeBrowser(HeadlessBrowserError(AcquisitionReason.HEADLESS_BLOCKED)),
    FakeResolver(TikWmError("cdn_unavailable")),
    FakeMaterializer(),
)


@pytest.mark.asyncio
async def test_complete_headless_success_never_calls_tikwm(tmp_path) -> None:
    browser = FakeBrowser(complete_snapshot())
    resolver = FakeResolver()
    materializer = FakeMaterializer()
    result = await TikTokAcquisitionService(browser, resolver, materializer).inspect(
        workflow_id="wf_headless_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is not None
    assert [attempt.strategy for attempt in result.report.outcome.attempts] == [
        "scrapling_headless"
    ]
    assert browser.calls == ["headless", "close"]
    assert resolver.calls == []


@pytest.mark.asyncio
async def test_incomplete_headless_uses_tikwm_once_and_preserves_safe_metadata(tmp_path) -> None:
    browser = FakeBrowser(
        BrowserSnapshot(
            final_url=SOURCE_URL,
            post_candidates=[
                TikTokPost(post_id="1234567890", owner_handle="creator", caption="headless")
            ],
            media_candidates=[],
        )
    )
    resolver = FakeResolver.from_payload(tikwm_fixture_payload())
    result = await TikTokAcquisitionService(browser, resolver, FakeMaterializer()).inspect(
        workflow_id="wf_fallback_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is not None
    assert [attempt.strategy for attempt in result.report.outcome.attempts] == [
        "scrapling_headless",
        "tikwm_cdn",
    ]
    assert result.report.post.caption == "headless"
    assert resolver.calls == ["tikwm"]
    assert "fixture-secret" not in result.report.model_dump_json()


@pytest.mark.asyncio
async def test_invalid_url_returns_failure_without_calling_any_provider(tmp_path) -> None:
    browser = FakeBrowser(complete_snapshot())
    resolver = FakeResolver()
    materializer = FakeMaterializer()
    result = await TikTokAcquisitionService(browser, resolver, materializer).inspect(
        workflow_id="wf_invalid_001",
        source_url="https://evil.example/@creator/video/1234567890",
        artifact_root=tmp_path,
    )
    assert result.failure is not None
    assert result.failure.code == "invalid_tiktok_url"
    assert result.failure.retryable is False
    assert browser.calls == []
    assert resolver.calls == []


@pytest.mark.asyncio
async def test_short_url_returns_failure_without_calling_any_provider(tmp_path) -> None:
    browser = FakeBrowser(complete_snapshot())
    resolver = FakeResolver()
    materializer = FakeMaterializer()
    result = await TikTokAcquisitionService(browser, resolver, materializer).inspect(
        workflow_id="wf_invalid_002",
        source_url="not a url at all",
        artifact_root=tmp_path,
    )
    assert result.failure is not None
    assert result.failure.code == "invalid_tiktok_url"
    assert browser.calls == []
    assert resolver.calls == []


@pytest.mark.asyncio
async def test_invalid_url_failure_has_no_attempts(tmp_path: Path) -> None:
    result = await service.inspect(
        workflow_id="wf_invalid_url_001",
        source_url="https://example.test/not-tiktok",
        artifact_root=tmp_path,
    )
    assert result.failure is not None
    assert result.failure.attempts == []


@pytest.mark.asyncio
async def test_terminal_cdn_failure_retains_both_attempts(tmp_path: Path) -> None:
    result = await failing_cdn_service.inspect(
        workflow_id="wf_cdn_failure_001",
        source_url="https://www.tiktok.com/@creator/video/1234567890",
        artifact_root=tmp_path,
    )
    assert result.failure is not None
    assert [attempt.strategy.value for attempt in result.failure.attempts] == [
        "scrapling_headless",
        "tikwm_cdn",
    ]
    assert result.failure.attempts[-1].reason == AcquisitionReason.CDN_UNAVAILABLE


@pytest.mark.parametrize(
    "reason",
    [AcquisitionReason.HEADLESS_TIMEOUT, AcquisitionReason.HEADLESS_BLOCKED],
)
@pytest.mark.asyncio
async def test_headless_exception_falls_back_to_tikwm_exactly_once(
    tmp_path, reason: AcquisitionReason
) -> None:
    browser = FakeBrowser(HeadlessBrowserError(reason))
    resolver = FakeResolver.from_payload(tikwm_fixture_payload())
    result = await TikTokAcquisitionService(browser, resolver, FakeMaterializer()).inspect(
        workflow_id="wf_headless_error_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is not None
    attempts = result.report.outcome.attempts
    assert [attempt.strategy for attempt in attempts] == ["scrapling_headless", "tikwm_cdn"]
    assert attempts[0].reason == reason.value
    assert attempts[0].status == "failed"
    assert browser.calls == ["headless", "close"]
    assert resolver.calls == ["tikwm"]


@pytest.mark.asyncio
async def test_headless_snapshot_without_post_candidate_falls_back_and_uses_provider_caption(
    tmp_path,
) -> None:
    browser = FakeBrowser(
        BrowserSnapshot(
            final_url=SOURCE_URL,
            post_candidates=[],
            media_candidates=[
                ResolvedMedia(ephemeral_url=SecretStr("https://video.example/a.mp4"))
            ],
        )
    )
    resolver = FakeResolver.from_payload(tikwm_fixture_payload())
    result = await TikTokAcquisitionService(browser, resolver, FakeMaterializer()).inspect(
        workflow_id="wf_no_post_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is not None
    assert [attempt.strategy for attempt in result.report.outcome.attempts] == [
        "scrapling_headless",
        "tikwm_cdn",
    ]
    assert result.report.post.caption == "A public caption"
    assert result.report.post.post_id == "1234567890"
    assert result.report.post.owner_handle == "creator"
    assert resolver.calls == ["tikwm"]


@pytest.mark.asyncio
async def test_headless_materialization_failure_falls_back_to_tikwm_exactly_once(
    tmp_path,
) -> None:
    browser = FakeBrowser(complete_snapshot())
    resolver = FakeResolver.from_payload(tikwm_fixture_payload())
    materializer = FakeMaterializer(fail_for=frozenset({"scrapling_headless"}))
    result = await TikTokAcquisitionService(browser, resolver, materializer).inspect(
        workflow_id="wf_media_fail_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is not None
    attempts = result.report.outcome.attempts
    assert [attempt.strategy for attempt in attempts] == ["scrapling_headless", "tikwm_cdn"]
    assert attempts[0].reason == "media_validation_failed"
    assert attempts[0].status == "failed"
    assert materializer.calls == ["scrapling_headless", "tikwm_cdn"]
    assert resolver.calls == ["tikwm"]


@pytest.mark.asyncio
async def test_tikwm_rate_limited_after_headless_failure_returns_safe_failure(tmp_path) -> None:
    browser = FakeBrowser(HeadlessBrowserError(AcquisitionReason.HEADLESS_TIMEOUT))
    resolver = FakeResolver(TikWmError("cdn_rate_limited"))
    result = await TikTokAcquisitionService(browser, resolver, FakeMaterializer()).inspect(
        workflow_id="wf_rate_limited_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is None
    assert result.failure is not None
    assert result.failure.code == "cdn_rate_limited"
    assert result.failure.retryable is True
    assert browser.calls == ["headless", "close"]
    assert resolver.calls == ["tikwm"]


@pytest.mark.asyncio
async def test_invalid_tikwm_payload_after_headless_failure_returns_safe_failure(
    tmp_path,
) -> None:
    browser = FakeBrowser(HeadlessBrowserError(AcquisitionReason.HEADLESS_BLOCKED))
    resolver = FakeResolver(TikWmError("cdn_unavailable"))
    result = await TikTokAcquisitionService(browser, resolver, FakeMaterializer()).inspect(
        workflow_id="wf_invalid_payload_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is None
    assert result.failure is not None
    assert result.failure.code == "cdn_unavailable"
    assert result.failure.retryable is True
    assert browser.calls == ["headless", "close"]
    assert resolver.calls == ["tikwm"]


@pytest.mark.asyncio
async def test_both_strategies_failing_returns_last_safe_code_without_leaking_anything(
    tmp_path,
) -> None:
    browser = FakeBrowser(HeadlessBrowserError(AcquisitionReason.HEADLESS_TIMEOUT))
    resolver = FakeResolver(TikWmError("cdn_unavailable"))
    result = await TikTokAcquisitionService(browser, resolver, FakeMaterializer()).inspect(
        workflow_id="wf_both_fail_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is None
    assert result.failure is not None
    assert result.failure.code == "cdn_unavailable"
    assert result.failure.retryable is True
    dumped = result.model_dump_json()
    assert SOURCE_URL not in dumped
    assert "video.example" not in dumped
    assert browser.calls == ["headless", "close"]
    assert resolver.calls == ["tikwm"]


@pytest.mark.asyncio
async def test_tikwm_materialization_failure_returns_media_validation_failed(tmp_path) -> None:
    browser = FakeBrowser(HeadlessBrowserError(AcquisitionReason.HEADLESS_TIMEOUT))
    resolver = FakeResolver.from_payload(tikwm_fixture_payload())
    materializer = FakeMaterializer(fail_for=frozenset({"tikwm_cdn"}))
    result = await TikTokAcquisitionService(browser, resolver, materializer).inspect(
        workflow_id="wf_tikwm_media_fail_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is None
    assert result.failure is not None
    assert result.failure.code == "media_validation_failed"
    assert result.failure.retryable is True
    assert [attempt.strategy.value for attempt in result.failure.attempts] == [
        "scrapling_headless",
        "tikwm_cdn",
    ]
    assert result.failure.attempts[-1].reason == AcquisitionReason.MEDIA_VALIDATION_FAILED
    assert materializer.calls == ["tikwm_cdn"]
    assert resolver.calls == ["tikwm"]


@pytest.mark.asyncio
async def test_cancellation_during_headless_closes_browser_and_never_calls_tikwm(
    tmp_path,
) -> None:
    browser = FakeBrowser(asyncio.CancelledError())
    resolver = FakeResolver()
    materializer = FakeMaterializer()
    service = TikTokAcquisitionService(browser, resolver, materializer)
    with pytest.raises(asyncio.CancelledError):
        await service.inspect(
            workflow_id="wf_cancel_001",
            source_url=SOURCE_URL,
            artifact_root=tmp_path,
        )
    assert browser.calls == ["headless", "close"]
    assert resolver.calls == []
    assert materializer.calls == []


@pytest.mark.asyncio
async def test_cancellation_during_cleanup_still_closes_browser(tmp_path) -> None:
    close_started = asyncio.Event()
    close_finished = asyncio.Event()

    class SlowCloseBrowser(FakeBrowser):
        async def close(self) -> None:
            close_started.set()
            await asyncio.sleep(0.05)
            self.calls.append("close")
            close_finished.set()

    browser = SlowCloseBrowser(asyncio.CancelledError())
    resolver = FakeResolver()
    materializer = FakeMaterializer()
    service = TikTokAcquisitionService(browser, resolver, materializer)

    task = asyncio.ensure_future(
        service.inspect(
            workflow_id="wf_cancel_cleanup_001",
            source_url=SOURCE_URL,
            artifact_root=tmp_path,
        )
    )
    await close_started.wait()
    task.cancel()  # a SECOND cancellation, delivered while close() is in-flight
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.wait_for(close_finished.wait(), timeout=1.0)
    assert "close" in browser.calls
    assert resolver.calls == []


@pytest.mark.asyncio
async def test_media_written_to_reports_workflow_media_layout(tmp_path) -> None:
    browser = FakeBrowser(complete_snapshot())
    resolver = FakeResolver()
    materializer = FakeMaterializer()
    result = await TikTokAcquisitionService(browser, resolver, materializer).inspect(
        workflow_id="wf_layout_001",
        source_url=SOURCE_URL,
        artifact_root=tmp_path,
    )
    assert result.report is not None
    assert result.report.media[0].location == PurePosixPath(
        "reports/wf_layout_001/media/tiktok-1234567890.mp4"
    )


# --- Pure-function coverage of the tikwm adapter (no dedicated test file for
# this task; parse_tikwm_payload is module-public per Ruling F-6). ---


def test_parse_tikwm_payload_accepts_the_sanitized_fixture() -> None:
    resolution = parse_tikwm_payload(tikwm_fixture_payload())
    assert resolution.post.post_id == "1234567890"
    assert resolution.post.owner_handle == "creator"
    assert resolution.post.caption == "A public caption"
    assert (
        resolution.media.ephemeral_url.get_secret_value()
        == "https://www.tikwm.com/video/media.mp4?token=fixture-secret"
    )
    assert "fixture-secret" not in repr(resolution.media)


def test_parse_tikwm_payload_rejects_rate_limit_signal() -> None:
    payload = {"code": -1, "msg": "Frequently Requests, Please Try Again Later", "data": {}}
    with pytest.raises(TikWmError) as excinfo:
        parse_tikwm_payload(payload)
    assert excinfo.value.code == "cdn_rate_limited"
    assert "Frequently" not in str(excinfo.value)


def test_parse_tikwm_payload_rejects_rate_limit_language_even_without_code_signal() -> None:
    # `code` is deliberately not -1: this must be caught by the message-language
    # check alone, not the (separately tested) numeric-code check.
    payload = {"code": 10004, "msg": "Too many requests, please slow down", "data": {}}
    with pytest.raises(TikWmError) as excinfo:
        parse_tikwm_payload(payload)
    assert excinfo.value.code == "cdn_rate_limited"


def _valid_tikwm_payload(**data_overrides: object) -> dict:
    data: dict[str, object] = {
        "id": "1234567890",
        "author": {"unique_id": "creator"},
        "hdplay": "https://cdn.tikwm.com/video/media.mp4",
        "title": "caption",
        "duration": 12,
    }
    data.update(data_overrides)
    return {"code": 0, "msg": "success", "data": data}


def test_parse_tikwm_payload_falls_back_to_play_when_hdplay_absent() -> None:
    payload = _valid_tikwm_payload(hdplay="", play="https://cdn.tikwm.com/video/play.mp4")
    resolution = parse_tikwm_payload(payload)
    assert (
        resolution.media.ephemeral_url.get_secret_value() == "https://cdn.tikwm.com/video/play.mp4"
    )


def test_parse_tikwm_payload_falls_back_to_wmplay_when_hdplay_and_play_absent() -> None:
    payload = _valid_tikwm_payload(hdplay="", play="", wmplay="https://cdn.tikwm.com/video/wm.mp4")
    resolution = parse_tikwm_payload(payload)
    assert resolution.media.ephemeral_url.get_secret_value() == "https://cdn.tikwm.com/video/wm.mp4"


def test_parse_tikwm_payload_normalizes_a_relative_media_url() -> None:
    payload = _valid_tikwm_payload(hdplay="/download/video.mp4")
    resolution = parse_tikwm_payload(payload)
    assert (
        resolution.media.ephemeral_url.get_secret_value()
        == "https://www.tikwm.com/download/video.mp4"
    )


def test_parse_tikwm_payload_truncates_an_oversized_caption() -> None:
    payload = _valid_tikwm_payload(title="x" * 10_050)
    resolution = parse_tikwm_payload(payload)
    assert len(resolution.post.caption) == 10_000


@pytest.mark.parametrize(
    "payload",
    [
        "not a dict",
        None,
        [1, 2, 3],
        {"code": 1, "msg": "unexpected error", "data": {}},
        {"code": [], "msg": "unexpected error", "data": {}},
        {"code": 0, "msg": "success", "data": "not a dict"},
        {"code": 0, "msg": "success"},
        {"code": 0, "msg": "success", "data": {"id": "abc", "author": {"unique_id": "creator"}}},
        {"code": 0, "msg": "success", "data": {"id": "1234567890", "author": {}}},
        {"code": 0, "msg": "success", "data": {"id": "1234567890", "author": ["not", "a", "dict"]}},
        {
            "code": 0,
            "msg": "success",
            "data": {
                "id": "1234567890",
                "author": {"unique_id": "creator"},
                "hdplay": "",
                "play": "",
                "wmplay": "",
            },
        },
        {
            "code": 0,
            "msg": "success",
            "data": {
                "id": "1234567890",
                "author": {"unique_id": "creator"},
                "hdplay": "http://insecure.example/video.mp4",
            },
        },
        {
            "code": 0,
            "msg": "success",
            "data": {
                "id": "1234567890",
                "author": {"unique_id": "creator"},
                "hdplay": "https://cdn.tikwm.com/video/media.mp4",
                "duration": 10**400,
            },
        },
    ],
)
def test_parse_tikwm_payload_rejects_malformed_payloads(payload: object) -> None:
    with pytest.raises(TikWmError) as excinfo:
        parse_tikwm_payload(payload)
    assert excinfo.value.code == "cdn_unavailable"


@pytest.mark.asyncio
async def test_rate_gate_waits_out_the_remainder_of_one_second() -> None:
    clock_values = iter([0.0, 0.4, 0.4, 1.0])
    sleeps: list[float] = []

    def fake_clock() -> float:
        return next(clock_values)

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    gate = TikWmRateGate()
    await gate.wait(fake_clock, fake_sleep)
    await gate.wait(fake_clock, fake_sleep)
    assert sleeps == [0.6]


@pytest.mark.asyncio
async def test_rate_gate_does_not_wait_once_interval_has_elapsed() -> None:
    clock_values = iter([0.0, 2.0])
    sleeps: list[float] = []

    def fake_clock() -> float:
        return next(clock_values)

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    gate = TikWmRateGate()
    await gate.wait(fake_clock, fake_sleep)
    await gate.wait(fake_clock, fake_sleep)
    assert sleeps == []


@pytest.mark.asyncio
async def test_tikwm_resolver_resolves_via_http_with_sanitized_fixture(tmp_path) -> None:
    del tmp_path
    captured_params: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_params.update(dict(request.url.params))
        return httpx.Response(200, json=tikwm_fixture_payload(), request=request)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        resolver = TikWmResolver(
            client,
            clock=time.monotonic,
            sleep=asyncio.sleep,
            rate_gate=TikWmRateGate(min_interval_seconds=0.0),
        )
        resolution = await resolver.resolve(SOURCE_URL)
    assert resolution.post.post_id == "1234567890"
    assert captured_params["url"] == SOURCE_URL
    assert captured_params["hd"] == "1"


@pytest.mark.asyncio
async def test_tikwm_resolver_maps_transport_errors_to_cdn_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        resolver = TikWmResolver(client, rate_gate=TikWmRateGate(min_interval_seconds=0.0))
        with pytest.raises(TikWmError) as excinfo:
            await resolver.resolve(SOURCE_URL)
    assert excinfo.value.code == "cdn_unavailable"
