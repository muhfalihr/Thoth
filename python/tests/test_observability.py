"""Tests for provider log redaction installed at worker startup."""

from __future__ import annotations

import logging

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

    original_child_handlers = list(child_logger.handlers)
    original_child_filters = list(child_logger.filters)
    original_child_level = child_logger.level
    original_child_propagate = child_logger.propagate

    original_root_handler_filters = {
        handler: list(handler.filters) for handler in root_logger.handlers
    }

    yield

    scrapling_logger.handlers[:] = original_scrapling_handlers
    scrapling_logger.filters[:] = original_scrapling_filters
    scrapling_logger.setLevel(original_scrapling_level)
    scrapling_logger.propagate = original_scrapling_propagate

    child_logger.handlers[:] = original_child_handlers
    child_logger.filters[:] = original_child_filters
    child_logger.setLevel(original_child_level)
    child_logger.propagate = original_child_propagate

    for handler in root_logger.handlers:
        handler.filters[:] = original_root_handler_filters.get(handler, [])


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


def test_scrapling_child_logger_records_propagate_through_redaction() -> None:
    """Child loggers must be covered even though the filter targets 'scrapling' by name.

    A logging.Filter attached directly to a Logger object is only consulted by
    Logger.handle() for records originated *on that exact logger*; it is not
    consulted for records that merely propagate up from a child logger. What
    *does* run for every propagating record is each Handler's own filter list.
    So coverage for child loggers like 'scrapling.fetchers' depends on the
    filter being installed on the Handler objects the record eventually
    reaches (here: the 'scrapling' logger's own handler), not merely on the
    'scrapling' Logger object itself.
    """
    records: list[logging.LogRecord] = []
    handler = _ListHandler(records)
    scrapling_logger = logging.getLogger("scrapling")
    scrapling_logger.handlers[:] = [handler]
    scrapling_logger.propagate = False
    scrapling_logger.setLevel(logging.DEBUG)

    child_logger = logging.getLogger("scrapling.fetchers")
    child_logger.handlers[:] = []
    child_logger.propagate = True
    child_logger.setLevel(logging.DEBUG)

    configure_provider_logging()

    child_logger.info("child signed https://cdn.test/video?token=secret")
    child_logger.error("child failed https://cdn.test/video?token=secret")

    assert len(records) == 1
    assert records[0].name == "scrapling.fetchers"
    assert records[0].getMessage() == REDACTED_PROVIDER_MESSAGE


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
