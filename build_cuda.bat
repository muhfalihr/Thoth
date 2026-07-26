@echo off
setlocal enabledelayedexpansion

:: 1. Pindah ke direktori script ini berada (fleksibel path)
cd /d "%~dp0"
echo [INFO] Path saat ini: %CD%

:: 2. Deteksi OS (karena ini .bat, kita asumsikan Windows)
if /i not "%OS%"=="Windows_NT" (
    echo [ERROR] Script .bat ini dirancang khusus untuk Windows.
    echo Untuk Linux/MacOS, gunakan build_cuda.sh
    exit /b 1
)
echo [INFO] OS Terdeteksi: Windows

:: 3. Cari Visual Studio Path secara dinamis menggunakan vswhere
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [ERROR] vswhere.exe tidak ditemukan. Pastikan Visual Studio terinstall.
    exit /b 1
)

set "VS_PATH="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    set "VS_PATH=%%i"
)

if not defined VS_PATH (
    echo [ERROR] Visual Studio C++ Build Tools tidak ditemukan!
    exit /b 1
)
echo [INFO] Visual Studio Path: %VS_PATH%

:: Panggil environment variables Visual Studio
call "%VS_PATH%\VC\Auxiliary\Build\vcvars64.bat"

:: 4. Cari LLVM/Clang Path secara dinamis (biasanya di C:\Program Files\LLVM)
set "LLVM_BIN="
if exist "C:\Program Files\LLVM\bin\clang.exe" (
    set "LLVM_BIN=C:\Program Files\LLVM\bin"
)
if defined LLVM_BIN (
    set "PATH=%PATH%;%LLVM_BIN%"
    set "LIBCLANG_PATH=%LLVM_BIN%"
    echo [INFO] LLVM Path: %LLVM_BIN%
) else (
    echo [WARN] LLVM tidak ditemukan di lokasi default. Memastikan clang tersedia di PATH...
)

:: 5. Cari CUDA Path (memanfaatkan environment variable CUDA_PATH bawaan installer NVIDIA)
if not defined CUDA_PATH (
    :: Fallback jika CUDA_PATH tidak ada di env
    if exist "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2" (
        set "CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2"
    ) else (
        echo [ERROR] Environment variable CUDA_PATH tidak ditemukan! Pastikan CUDA Toolkit terinstall.
        exit /b 1
    )
)
echo [INFO] CUDA Path: %CUDA_PATH%
set "PATH=%PATH%;%CUDA_PATH%\bin"

:: 6. Tambahkan CMake dari VS untuk build Whisper/llama.cpp.
:: VS-bundled Ninja can deadlock after cl.exe leaves mspdbsrv.exe holding its
:: output pipe. NMake uses the same MSVC/CUDA toolchain without that deadlock.
set "PATH=%PATH%;%VS_PATH%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%VS_PATH%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja"
set "CMAKE_GENERATOR=NMake Makefiles"

:: 7. Jalankan Cargo Build
echo.
echo [INFO] Memulai proses build Cargo dengan fitur CUDA...
:: Workspace virtual: --features butuh target paket eksplisit. thoth (CLI/worker)
:: link CUDA/Whisper; thoth-server sengaja tanpa CUDA (default-features=false).
cargo build --release -p thoth --features cuda
if errorlevel 1 exit /b 1
cargo build --release -p thoth-server
