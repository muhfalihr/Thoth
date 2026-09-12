# syntax=docker/dockerfile:1.7

FROM ghcr.io/astral-sh/uv:0.10.8 AS uv-tools
FROM oven/bun:1.3.14 AS bun-tools

FROM python:3.12-slim-bookworm AS runtime

COPY --from=uv-tools /uv /uvx /usr/local/bin/
COPY --from=bun-tools /usr/local/bin/bun /usr/local/bin/bun

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON=/usr/local/bin/python3.12 \
    UV_PYTHON_DOWNLOADS=never \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    THOTH_CONTROL_PLANE_ARTIFACT_ROOT=/var/lib/thoth/artifacts \
    THOTH_FFMPEG=/usr/bin/ffmpeg \
    THOTH_FFPROBE=/usr/bin/ffprobe \
    GALLERY_DL=/opt/thoth/python/.venv/bin/gallery-dl \
    YTDLP=/opt/thoth/python/.venv/bin/yt-dlp \
    PATH=/opt/thoth/python/.venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 thoth \
    && useradd --uid 10001 --gid 10001 --create-home \
        --home-dir /home/thoth --shell /usr/sbin/nologin thoth \
    && mkdir -p /opt/thoth/bin /opt/thoth/python /opt/thoth/scout \
        /var/lib/thoth/artifacts /var/lib/thoth/browser-profile \
        /var/lib/thoth/parity-profile /ms-playwright \
    && chown -R thoth:thoth /opt/thoth /var/lib/thoth /home/thoth /ms-playwright

WORKDIR /opt/thoth

COPY --chmod=0755 --chown=thoth:thoth docker/start-legacy-cdp /opt/thoth/bin/start-legacy-cdp
COPY --chmod=0755 --chown=thoth:thoth docker/start-parity-reference \
    /opt/thoth/bin/start-parity-reference

COPY --chown=thoth:thoth python/pyproject.toml python/uv.lock /opt/thoth/python/
RUN cd /opt/thoth/python \
    && uv sync --frozen --no-dev --extra acquisition --extra scout-runtime --no-install-project

COPY --chown=thoth:thoth python/src/ /opt/thoth/python/src/
COPY --chown=thoth:thoth python/migrations/ /opt/thoth/python/migrations/
RUN cd /opt/thoth/python \
    && uv sync --frozen --no-dev --extra acquisition --extra scout-runtime

COPY --chown=thoth:thoth scout/package.json scout/bun.lock /opt/thoth/scout/
RUN bun --cwd=/opt/thoth/scout install --frozen-lockfile --production
COPY --chown=thoth:thoth scout/ /opt/thoth/scout/

RUN /opt/thoth/python/.venv/bin/scrapling install \
    && chown -R thoth:thoth /home/thoth /ms-playwright /opt/thoth/python/.venv

RUN /opt/thoth/python/.venv/bin/python -c \
        "import scrapling, thoth_control_plane" \
    && /opt/thoth/python/.venv/bin/python -c \
        "import sys; assert sys.version_info[:2] == (3, 12), sys.version" \
    && /opt/thoth/python/.venv/bin/python -c \
        "import thoth_control_plane as m; assert m.__file__.startswith('/opt/thoth/python/src/'), m.__file__" \
    && bun --version \
    && test -f /opt/thoth/scout/cli.ts

EXPOSE 8000 18800

USER thoth

RUN test -w /var/lib/thoth/artifacts \
    && test -w /var/lib/thoth/browser-profile \
    && test -r /opt/thoth/scout/cli.ts \
    && test -x /opt/thoth/python/.venv/bin/python \
    && test -x /usr/bin/ffmpeg \
    && test -x /usr/bin/ffprobe \
    && test -x "$GALLERY_DL" \
    && test -x "$YTDLP" \
    && test "$("$GALLERY_DL" --version)" = "1.32.11" \
    && test "$("$YTDLP" --version)" = "2026.08.19" \
    && /usr/bin/ffmpeg -version >/dev/null 2>&1 \
    && /usr/bin/ffprobe -version >/dev/null 2>&1 \
    && cdp_check_log="$(mktemp)" \
    && trap 'rm -f "$cdp_check_log"' 0 \
    && if ! /opt/thoth/bin/start-legacy-cdp --check >"$cdp_check_log" 2>&1; then \
        cat "$cdp_check_log" >&2; \
        exit 1; \
    fi \
    && if ! test ! -s "$cdp_check_log"; then \
        cat "$cdp_check_log" >&2; \
        exit 1; \
    fi

# The parity reference has neither its tmpfs profile nor a mounted sample at build
# time, so its check runs against throwaway directories. It starts no browser, and it
# also proves the launcher refuses an argument shape it does not recognise.
RUN test -w /var/lib/thoth/parity-profile \
    && test -r /opt/thoth/scout/runtime/parity_reference.ts \
    && parity_root="$(mktemp -d)" \
    && parity_check_log="$(mktemp)" \
    && trap 'rm -rf "$parity_root" "$parity_check_log"' 0 \
    && mkdir -p "$parity_root/profile" "$parity_root/output" \
    && if ! THOTH_PARITY_CHECK_PROFILE_DIR="$parity_root/profile" \
        THOTH_PARITY_CHECK_OUTPUT_DIR="$parity_root/output" \
        /opt/thoth/bin/start-parity-reference --check >"$parity_check_log" 2>&1; then \
        cat "$parity_check_log" >&2; \
        exit 1; \
    fi \
    && if ! test ! -s "$parity_check_log"; then \
        cat "$parity_check_log" >&2; \
        exit 1; \
    fi \
    && if /opt/thoth/bin/start-parity-reference --unsupported >/dev/null 2>&1; then \
        echo "parity launcher accepted an unsupported argument" >&2; \
        exit 1; \
    fi

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/thoth/python/.venv/bin/python", "-m", "thoth_control_plane.worker"]
