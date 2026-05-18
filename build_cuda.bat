@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set PATH=%PATH%;C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;C:\Program Files\LLVM\bin;C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2\bin
set LIBCLANG_PATH=C:\Program Files\LLVM\bin
set CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2
set CMAKE_GENERATOR=Ninja
cd /d "C:\Users\mfr\Documents\MyTools\CLIPPER"
cargo build --release --features cuda
