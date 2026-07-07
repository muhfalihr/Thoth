@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  Thoth News Environment Setup
REM  Membuat conda environment "thoth-news" dengan Playwright + Chromium.
REM
REM  Prasyarat:
REM    - Anaconda / Miniconda sudah terinstall dan ada di PATH
REM      Download: https://docs.conda.io/en/latest/miniconda.html
REM
REM  Jalankan sekali:
REM    scripts\setup_thoth_news.bat
REM ─────────────────────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

echo [1/4] Membuat conda environment "thoth-news" (Python 3.11)...
call conda env create -f environment.yml
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo   Env mungkin sudah ada. Coba update:
    call conda env update -f environment.yml --prune
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: gagal membuat/update conda env.
        exit /b 1
    )
)

echo.
echo [2/4] Menginstall packages Python (Playwright + Edge TTS + mutagen)...
call conda run -n thoth-news pip install playwright edge-tts mutagen
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: pip install playwright gagal.
    exit /b 1
)

echo.
echo [3/4] Download Chromium untuk Playwright...
call conda run -n thoth-news python -m playwright install chromium
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: playwright install chromium gagal.
    exit /b 1
)

echo.
echo [4/4] Verifikasi...
call conda run -n thoth-news python -c "from playwright.sync_api import sync_playwright; print('Playwright OK')"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: verifikasi playwright gagal.
    exit /b 1
)

echo.
echo ═══════════════════════════════════════════════════════════════
echo  Setup selesai! Conda env "thoth-news" siap dipakai.
echo.
echo  Aktifkan di config.toml:
echo    [news]
echo    enabled     = true
echo    conda_env   = "thoth-news"
echo    provider    = "playwright"
echo ═══════════════════════════════════════════════════════════════
endlocal
