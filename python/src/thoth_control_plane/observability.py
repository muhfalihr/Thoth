"""Worker-startup logging safety for the optional Scrapling provider stack.

Scrapling (and the Patchright browser it drives) logs signed CDN URLs, cookies,
and other provider-identifying detail at INFO level via the standard library
`logging` module. The control plane's own reports, Temporal history, and
events are already sanitized — this module exists solely to keep that
third-party library's stdout from ever reaching a configured handler unfiltered.

`configure_provider_logging()` must run before any capability probe or fetch
touches the `scrapling` namespace, must never raise (a broken logging
configuration must not prevent the worker from starting), and must be safe to
call more than once.
"""

from __future__ import annotations

import logging

REDACTED_PROVIDER_MESSAGE = "scrapling provider event redacted"

_GUARD_MARKER = "_scrapling_redaction_guard"


class ScraplingRedactionFilter(logging.Filter):
    """Drop DEBUG/INFO and redact WARNING/ERROR records in the `scrapling` namespace."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not record.name.startswith("scrapling"):
            return True
        if record.levelno < logging.WARNING:
            return False
        record.msg = REDACTED_PROVIDER_MESSAGE
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True


def _add_filter_once(target: logging.Filterer) -> None:
    if not any(isinstance(item, ScraplingRedactionFilter) for item in target.filters):
        target.addFilter(ScraplingRedactionFilter())


def _guard_future_handlers(logger: logging.Logger) -> None:
    """Attach the filter to every handler this logger will ever own.

    Applied to two logger objects, for two different late-arrival stories:

    - the `scrapling` logger, because Scrapling attaches its own
      `StreamHandler` to that exact logger at import time — lazily, inside
      `check_scrapling_capability()`, long after this module has already run
      at worker startup;
    - the **root** logger, because a record propagating up from a child such
      as `scrapling.fetchers` is never shown the `scrapling` Logger's own
      filters, so a root handler installed later (`logging.basicConfig()`,
      structured logging, a log shipper) would otherwise receive it raw.

    A one-time scan of `logger.handlers` at configure time cannot see a
    handler that does not exist yet, so instead this wraps `addHandler` on
    that one logger instance: whichever handler object is added, whenever
    that happens, gets the filter attached the moment it is added. The wrapper
    is set on the instance, not on `logging.Logger`, so no unrelated logger is
    affected; and the filter itself returns non-`scrapling` records untouched,
    so guarding the root handler chain does not alter application logging.
    """
    if getattr(logger.addHandler, _GUARD_MARKER, False):
        return
    original_add_handler = logger.addHandler

    def _guarded_add_handler(handler: logging.Handler) -> None:
        _add_filter_once(handler)
        original_add_handler(handler)

    setattr(_guarded_add_handler, _GUARD_MARKER, True)
    logger.addHandler = _guarded_add_handler


def configure_provider_logging() -> None:
    """Install the Scrapling redaction filter on every handler that could see it.

    Filters attached to a `Logger` object are only consulted for records
    originated on that exact logger — they are NOT consulted when a record
    merely propagates up from a child logger (e.g. `scrapling.fetchers`).
    Handler-level filters, by contrast, run for every record that reaches
    that handler regardless of which logger emitted it. So this installs the
    filter on:

    - the `scrapling` logger itself (covers exact-name records before they
      even reach a handler);
    - every handler already attached to the `scrapling` logger and to the
      root logger (covers records propagating up from child loggers such as
      `scrapling.fetchers`, given the handlers that exist right now);
    - via `_guard_future_handlers`, any handler added to the root logger
      *after* this function has already run (the same propagation path, for
      handlers that do not exist yet);
    - `logging.lastResort`, the stdlib's own fallback handler used when a
      record's propagation chain has no handler at all (covers child-logger
      WARNING/ERROR records in the "no handlers configured anywhere" state,
      which would otherwise print raw to stderr);
    - and, via `_guard_future_handlers`, any handler `scrapling` attaches to
      its own logger *after* this function has already run.

    Never raises: an unusual or broken logging configuration must not stop
    worker startup. Idempotent: safe to call more than once without
    installing duplicate filters or double-handling a record.
    """
    try:
        logger = logging.getLogger("scrapling")
        root_logger = logging.getLogger()
        logger.setLevel(logging.WARNING)

        targets: list[logging.Filterer] = [
            logger,
            *logger.handlers,
            *root_logger.handlers,
        ]
        if logging.lastResort is not None:
            targets.append(logging.lastResort)
        for target in targets:
            _add_filter_once(target)

        _guard_future_handlers(logger)
        _guard_future_handlers(root_logger)
    except Exception:
        return
