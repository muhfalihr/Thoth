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


def configure_provider_logging() -> None:
    """Install the Scrapling redaction filter on every handler that could see it.

    Filters attached to a `Logger` object are only consulted for records
    originated on that exact logger — they are NOT consulted when a record
    merely propagates up from a child logger (e.g. `scrapling.fetchers`).
    Handler-level filters, by contrast, run for every record that reaches
    that handler regardless of which logger emitted it. So this installs the
    filter on the `scrapling` logger itself (covers exact-name records before
    they even reach a handler) AND on every handler already attached to the
    `scrapling` logger and to the root logger (covers records propagating up
    from child loggers such as `scrapling.fetchers`).

    Never raises: an unusual or broken logging configuration must not stop
    worker startup. Idempotent: safe to call more than once without
    installing duplicate filters or double-handling a record.
    """
    try:
        logger = logging.getLogger("scrapling")
        logger.setLevel(logging.WARNING)
        targets = [logger, *logger.handlers, *logging.getLogger().handlers]
        for target in targets:
            if not any(isinstance(item, ScraplingRedactionFilter) for item in target.filters):
                target.addFilter(ScraplingRedactionFilter())
    except Exception:
        return
