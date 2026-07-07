#!/usr/bin/env bash
# Script build CUDA fleksibel untuk Linux/macOS

# 1. Pindah ke direktori script ini berada (fleksibel path)
cd "$(dirname "$0")" || exit 1
echo "[INFO] Path saat ini: $(pwd)"

# 2. Deteksi OS
OS="$(uname -s)"
echo "[INFO] OS Terdeteksi: $OS"

if [ "$OS" = "Darwin" ]; then
    echo "[WARN] macOS terdeteksi. Dukungan CUDA di macOS sangat terbatas."
fi

# 3. Cek apakah nvcc (CUDA) tersedia di PATH, atau set dari path instalasi default
if ! command -v nvcc &> /dev/null; then
    if [ -d "/usr/local/cuda" ]; then
        export CUDA_PATH="/usr/local/cuda"
        export PATH="$CUDA_PATH/bin:$PATH"
        export LD_LIBRARY_PATH="$CUDA_PATH/lib64:$LD_LIBRARY_PATH"
        echo "[INFO] Menggunakan fallback CUDA path: /usr/local/cuda"
    else
        echo "[ERROR] 'nvcc' tidak ditemukan di PATH dan /usr/local/cuda tidak ada. Pastikan CUDA Toolkit terinstall."
        exit 1
    fi
else
    echo "[INFO] CUDA (nvcc) terdeteksi di PATH: $(which nvcc)"
fi

# 4. Jalankan Cargo Build
echo ""
echo "[INFO] Memulai proses build Cargo dengan fitur CUDA..."
cargo build --release --features cuda
