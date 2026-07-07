@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  Thoth SadTalker Setup — Local GPU Talking Avatar (Phase 6)
REM
REM  Prasyarat:
REM    - Anaconda / Miniconda terinstall
REM    - NVIDIA GPU + CUDA tersedia (project sudah setup CUDA 13.2)
REM    - Git terinstall
REM
REM  Jalankan sekali dari root folder Thoth:
REM    scripts\setup_sadtalker.bat
REM ─────────────────────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

set SADTALKER_DIR=tools\SadTalker
set CONDA_ENV=thoth-sadtalker

echo ============================================================
echo  Thoth SadTalker Setup
echo ============================================================

REM ── Step 1: Clone SadTalker ──────────────────────────────────────────────────
echo.
echo [1/5] Mengclone SadTalker ke %SADTALKER_DIR%...
if exist "%SADTALKER_DIR%\.git" (
    echo   Sudah ada. Melakukan git pull...
    git -C "%SADTALKER_DIR%" pull --quiet
) else (
    mkdir tools 2>nul
    git clone https://github.com/OpenTalker/SadTalker.git "%SADTALKER_DIR%" --depth 1
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: git clone gagal.
        exit /b 1
    )
)

REM ── Step 2: Buat conda environment ──────────────────────────────────────────
echo.
echo [2/5] Membuat conda env "%CONDA_ENV%" (Python 3.8)...
call conda create -n %CONDA_ENV% python=3.8 -y 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo   Env mungkin sudah ada. Melanjutkan...
)

REM ── Step 3: Install PyTorch + dependencies ───────────────────────────────────
echo.
echo [3/5] Menginstall PyTorch (CUDA) + SadTalker requirements...
call conda run -n %CONDA_ENV% pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
if %ERRORLEVEL% NEQ 0 (
    echo   CUDA torch gagal, coba CPU version...
    call conda run -n %CONDA_ENV% pip install torch torchvision torchaudio
)

call conda run -n %CONDA_ENV% pip install -r "%SADTALKER_DIR%\requirements.txt"
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: beberapa requirements gagal install. Coba lanjutkan...
)

REM Install tambahan yang dibutuhkan
call conda run -n %CONDA_ENV% pip install mutagen face-alignment

REM ── Step 4: Download pretrained models ─────────────────────────────────────
echo.
echo [4/5] Mengdownload pretrained models SadTalker (~300MB)...
echo   Ini akan butuh beberapa menit tergantung koneksi...

REM SadTalker menyediakan script download otomatis
if exist "%SADTALKER_DIR%\scripts\download_models.sh" (
    echo   Menggunakan scripts\download_models.sh...
    REM Windows: gunakan curl + 7-zip atau download manual
    call conda run -n %CONDA_ENV% bash "%SADTALKER_DIR%\scripts\download_models.sh" 2>nul
) else (
    echo   Mendownload model via Python...
    call conda run -n %CONDA_ENV% python -c ^
        "from scripts.download_facerender_weights import main; main()" ^
        --prefix="%SADTALKER_DIR%" 2>nul
)

REM Fallback: download langsung ke checkpoints folder
if not exist "%SADTALKER_DIR%\checkpoints\SadTalker_V0.0.2_256_winnet.pth" (
    echo   Mendownload model SadTalker 256...
    mkdir "%SADTALKER_DIR%\checkpoints" 2>nul
    curl -L "https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc/SadTalker_V0.0.2_256_winnet.pth" ^
         -o "%SADTALKER_DIR%\checkpoints\SadTalker_V0.0.2_256_winnet.pth"
    curl -L "https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc/SadTalker_V0.0.2_512.safetensors" ^
         -o "%SADTALKER_DIR%\checkpoints\SadTalker_V0.0.2_512.safetensors"
)

REM ── Step 5: Verifikasi ──────────────────────────────────────────────────────
echo.
echo [5/5] Verifikasi...
call conda run -n %CONDA_ENV% python -c "import torch; print('PyTorch:', torch.__version__, '| CUDA:', torch.cuda.is_available())"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: verifikasi Python/PyTorch gagal.
    exit /b 1
)

echo.
echo ═══════════════════════════════════════════════════════════════
echo  Setup SadTalker selesai!
echo.
echo  Aktifkan di config.toml:
echo    [reaction.avatar]
echo    mode           = "sad_talker"
echo    image_path     = "assets/avatar.png"  ^<-- taruh foto wajah di sini
echo    sadtalker_dir  = "tools/SadTalker"
echo    sadtalker_env  = "thoth-sadtalker"
echo    sadtalker_size = 256   ^  256=cepat  512=kualitas tinggi
echo ═══════════════════════════════════════════════════════════════
endlocal
