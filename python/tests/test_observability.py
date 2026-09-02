"""Tests for provider log redaction installed at worker startup."""

from __future__ import annotations

import io
import logging
import sys

import pytest

from thoth_control_plane.observability import (
    REDACTED_PROVIDER_MESSAGE,
    ScraplingRedactionFilter,
    configure_provider_logging,
)


class _ListHandler(logging.Handler):
    """Test handler that records every record that reaches it, verbatim."""

    def __init__(self, records: list[logging.LogRecord]) -> None:
        super().__init__()
        self._records = records

    def emit(self, record: logging.LogRecord) -> None:
        self._records.append(record)


@pytest.fixture(autouse=True)
def _reset_logging_state():
    """Prevent this module's logger/handler mutations from leaking into other tests."""
    scrapling_logger = logging.getLogger("scrapling")
    child_logger = logging.getLogger("scrapling.fetchers")
    root_logger = logging.getLogger()

    original_scrapling_handlers = list(scrapling_logger.handlers)
    original_scrapling_filters = list(scrapling_logger.filters)
    original_scrapling_level = scrapling_logger.level
    original_scrapling_propagate = scrapling_logger.propagate
    original_scrapling_add_handler = scrapling_logger.__dict__.get("addHandler")

    original_child_handlers = list(child_logger.handlers)
    original_child_filters = list(child_logger.filters)
    original_child_level = child_logger.level
    original_child_propagate = child_logger.propagate

    original_root_handlers = list(root_logger.handlers)
    original_root_handler_filters = {
        handler: list(handler.filters) for handler in root_logger.handlers
    }
    original_root_add_handler = root_logger.__dict__.get("addHandler")
    original_last_resort_filters = (
        list(logging.lastResort.filters) if logging.lastResort is not None else []
    )

    yield

    scrapling_logger.handlers[:] = original_scrapling_handlers
    scrapling_logger.filters[:] = original_scrapling_filters
    scrapling_logger.setLevel(original_scrapling_level)
    scrapling_logger.propagate = original_scrapling_propagate
    if original_scrapling_add_handler is None:
        scrapling_logger.__dict__.pop("addHandler", None)
    else:
        scrapling_logger.__dict__["addHandler"] = original_scrapling_add_handler

    child_logger.handlers[:] = original_child_handlers
    child_logger.filters[:] = original_child_filters
    child_logger.setLevel(original_child_level)
    child_logger.propagate = original_child_propagate

    root_logger.handlers[:] = original_root_handlers
    for handler in root_logger.handlers:
        handler.filters[:] = original_root_handler_filters.get(handler, [])
    if original_root_add_handler is None:
        root_logger.__dict__.pop("addHandler", None)
    else:
        root_logger.__dict__["addHandler"] = original_root_add_handler
    if logging.lastResort is not None:
        logging.lastResort.filters[:] = original_last_resort_filters


def test_scrapling_info_is_dropped_and_error_is_fully_redacted() -> None:
    records: list[logging.LogRecord] = []
    handler = _ListHandler(records)
    logger = logging.getLogger("scrapling")
    logger.handlers[:] = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)

    configure_provider_logging()
    logger.info("signed https://cdn.test/video?token=secret")
    try:
        raise RuntimeError("provider token=secret")
    except RuntimeError:
        logger.exception("failed %s", "https://cdn.test/x?token=secret", stack_info=True)

    assert len(records) == 1
    record = records[0]
    assert record.getMessage() == "scrapling provider event redacted"
    assert record.args == ()
    assert record.exc_info is None
    assert record.exc_text is None
    assert record.stack_info is None


def test_scrapling_debug_is_dropped() -> None:
    records: list[logging.LogRecord] = []
    handler = _ListHandler(records)
    logger = logging.getLogger("scrapling")
    logger.handlers[:] = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)

    configure_provider_logging()
    logger.debug("cookie jar dump token=secret")

    assert records == []


def test_scrapling_warning_is_redacted_not_dropped() -> None:
    records: list[logging.LogRecord] = []
    handler = _ListHandler(records)
    logger = logging.getLogger("scrapling")
    logger.handlers[:] = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)

    configure_provider_logging()
    logger.warning("signed https://cdn.test/video?token=secret")

    assert len(records) == 1
    assert records[0].getMessage() == REDACTED_PROVIDER_MESSAGE


def test_provider_logging_configuration_is_idempotent() -> None:
    configure_provider_logging()
    configure_provider_logging()
    logger = logging.getLogger("scrapling")
    assert sum(isinstance(item, ScraplingRedactionFilter) for item in logger.filters) == 1


def test_configure_provider_logging_does_not_raise_on_broken_handler() -> None:
    class _BrokenHandler(logging.Handler):
        @property
        def filters(self):  # type: ignore[override]
            raise RuntimeError("boom")

        @filters.setter
        def filters(self, value):  # pragma: no cover - never reached
            pass

    logger = logging.getLogger("scrapling")
    logger.handlers[:] = [_BrokenHandler()]

    configure_provider_logging()  # must not raise


def test_scrapling_child_logger_handler_attached_after_configure_is_redacted() -> None:
    """Mirrors the REAL production ordering, not a convenient one.

    In production, `configure_provider_logging()` runs first at worker
    startup; `scrapling` is only imported later, lazily, inside
    `check_scrapling_capability()` — and scrapling's own `setup_logger()`
    attaches ITS OWN `StreamHandler` to the `scrapling` logger at that point,
    long after configuration already ran. A filter installed only on
    handlers that existed at configure time cannot see a handler created
    later. Coverage for this must come from something that intercepts
    handler attachment itself, not from having scanned `logger.handlers` at
    a lucky moment.

    Exercises both hostile vectors named by the security review: the secret
    embedded directly in the message string, and the secret carried only in
    `args`.
    """
    scrapling_logger = logging.getLogger("scrapling")
    scrapling_logger.handlers[:] = []
    scrapling_logger.propagate = False
    scrapling_logger.setLevel(logging.NOTSET)

    configure_provider_logging()  # runs BEFORE scrapling is ever imported

    records: list[logging.LogRecord] = []
    handler = _ListHandler(records)
    scrapling_logger.addHandler(handler)  # simulates scrapling.core.utils.setup_logger()

    child_logger = logging.getLogger("scrapling.fetchers")
    child_logger.handlers[:] = []
    child_logger.propagate = True
    child_logger.setLevel(logging.DEBUG)

    child_logger.info("dropped info token=SUPER_SECRET_TOKEN")
    child_logger.warning("signed url token=SUPER_SECRET_TOKEN")
    child_logger.warning("signed url %s", "token=SUPER_SECRET_TOKEN")

    assert len(records) == 2  # the INFO record must have been dropped, not just the two WARNINGs
    for record in records:
        assert record.name == "scrapling.fetchers"
        assert record.getMessage() == REDACTED_PROVIDER_MESSAGE
        assert "SUPER_SECRET_TOKEN" not in record.getMessage()
        assert record.args == ()


def test_scrapling_child_logger_falls_through_to_last_resort_redacted(monkeypatch) -> None:
    """With zero handlers anywhere in the chain, logging falls back to `logging.lastResort`,
    which by default has no filters and prints the raw record straight to stderr. That
    fallback path must be closed too, independent of any handler ever being attached.
    """
    scrapling_logger = logging.getLogger("scrapling")
    scrapling_logger.handlers[:] = []
    scrapling_logger.propagate = True
    scrapling_logger.setLevel(logging.NOTSET)

    root_logger = logging.getLogger()
    monkeypatch.setattr(root_logger, "handlers", [])  # no handler anywhere in the chain

    child_logger = logging.getLogger("scrapling.fetchers")
    child_logger.handlers[:] = []
    child_logger.propagate = True
    child_logger.setLevel(logging.DEBUG)

    configure_provider_logging()

    stream = io.StringIO()
    monkeypatch.setattr(sys, "stderr", stream)  # _StderrHandler.stream reads sys.stderr live

    child_logger.warning("signed url token=SUPER_SECRET_TOKEN")

    output = stream.getvalue()
    assert "SUPER_SECRET_TOKEN" not in output
    assert REDACTED_PROVIDER_MESSAGE in output


def test_filter_clears_every_hostile_vector_directly() -> None:
    """Unit-test the filter object itself against a record with every dangerous field set."""
    record = logging.LogRecord(
        name="scrapling.fetchers",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg="signed %s",
        args=("https://cdn.test/video?token=secret",),
        exc_info=(RuntimeError, RuntimeError("provider token=secret"), None),
    )
    record.exc_text = "Traceback (most recent call last):\n  token=secret"
    record.stack_info = "Stack (most recent call last):\n  token=secret"

    result = ScraplingRedactionFilter().filter(record)

    assert result is True
    assert record.getMessage() == REDACTED_PROVIDER_MESSAGE
    assert record.args == ()
    assert record.exc_info is None
    assert record.exc_text is None
    assert record.stack_info is None


def test_filter_leaves_non_scrapling_records_untouched() -> None:
    record = logging.LogRecord(
        name="thoth_control_plane.worker",
        level=logging.DEBUG,
        pathname=__file__,
        lineno=1,
        msg="ordinary debug message",
        args=(),
        exc_info=None,
    )

    result = ScraplingRedactionFilter().filter(record)

    assert result is True
    assert record.getMessage() == "ordinary debug message"


def _quiet_scrapling_chain() -> logging.Logger:
    """Leave `scrapling` handler-less and propagating, so only root handlers can see records."""
    scrapling_logger = logging.getLogger("scrapling")
    scrapling_logger.handlers[:] = []
    scrapling_logger.propagate = True
    scrapling_logger.setLevel(logging.NOTSET)

    child_logger = logging.getLogger("scrapling.fetchers")
    child_logger.handlers[:] = []
    child_logger.propagate = True
    child_logger.setLevel(logging.DEBUG)
    return child_logger


def test_root_handler_attached_after_configure_redacts_propagated_child_records() -> None:
    """A root handler installed AFTER configure time must still never see a raw record.

    Filters on the `scrapling` Logger object are not consulted for records that
    merely propagate up from `scrapling.fetchers`, so the only thing standing
    between such a record and a late-added root handler (a `logging.basicConfig()`
    call, a structured-logging setup, a log shipper) is the handler's own filters.
    """
    root_logger = logging.getLogger()
    root_logger.handlers[:] = []
    child_logger = _quiet_scrapling_chain()

    configure_provider_logging()

    records: list[logging.LogRecord] = []
    root_logger.addHandler(_ListHandler(records))  # AFTER configure

    child_logger.debug("cookie jar dump token=SUPER_SECRET_TOKEN")
    child_logger.info("fetched https://cdn.test/x?sig=SUPER_SECRET_TOKEN")
    child_logger.warning("blocked %s", "https://cdn.test/y?token=SUPER_SECRET_TOKEN")
    try:
        raise RuntimeError("exception text with C:/private/path SUPER_SECRET_TOKEN")
    except RuntimeError:
        child_logger.error(
            "boom %s", "https://cdn.test/z?k=SUPER_SECRET_TOKEN", exc_info=True, stack_info=True
        )

    assert len(records) == 2  # DEBUG and INFO dropped; WARNING and ERROR redacted
    for record in records:
        assert record.getMessage() == REDACTED_PROVIDER_MESSAGE
        assert record.args == ()
        assert record.exc_info is None
        assert record.exc_text is None
        assert record.stack_info is None


def test_root_handler_present_before_configure_receives_redacted_warning() -> None:
    """The configure-time root handler scan is load-bearing on its own."""
    root_logger = logging.getLogger()
    records: list[logging.LogRecord] = []
    root_logger.handlers[:] = [_ListHandler(records)]  # BEFORE configure
    child_logger = _quiet_scrapling_chain()

    configure_provider_logging()

    child_logger.warning("signed url %s", "token=SUPER_SECRET_TOKEN")

    assert len(records) == 1
    assert records[0].getMessage() == REDACTED_PROVIDER_MESSAGE
    assert records[0].args == ()
