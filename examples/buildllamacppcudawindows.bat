:: Example build script for llama.cpp on windows with CUDA
:: and autosync towards a target directory after build
@echo off
setlocal enabledelayedexpansion

set "SOURCE_BIN=C:\path\to\llama.cpp\build\bin"
set "TARGET_BIN=C:\path\to\target\bin"

cd /d "%~dp0..\.."

echo === Configuring build with CMake (Ninja + CUDA) ===

cmake -G Ninja -B build -DGGML_CCACHE=OFF -DGGML_CUDA=ON -DGGML_CUDA_NCCL=OFF -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DGGML_BACKEND_DL=OFF -DBUILD_SHARED_LIBS=OFF

if %ERRORLEVEL% neq 0 (
    echo Error: CMake configuration failed.
    exit /b %ERRORLEVEL%
)

echo === Building project ===

cmake --build build --config Release --target llama-app -j 6
if %ERRORLEVEL% neq 0 (
    echo Error: Build failed.
    exit /b %ERRORLEVEL%
)

echo.
echo ===========================================================
echo                ROBOCOPY SIMULATION (DRY RUN)
echo ===========================================================
:: The /L flag makes this a simulation
robocopy "%SOURCE_BIN%" "%TARGET_BIN%" /MIR /R:1 /W:2 /XF *.exp *.lib *.pdb /L

echo.
echo Simulation complete. Review the list above.
echo.
choice /M "Do you want to proceed with the ACTUAL sync to target?"
if %ERRORLEVEL% neq 1 (
    echo Sync cancelled by user.
    exit /b 0
)

echo === Mirroring binaries to target directory ===
:: Removed /L for the real run
robocopy "%SOURCE_BIN%" "%TARGET_BIN%" /MIR /R:1 /W:2 /NFL /NDL /XF *.exp *.lib *.pdb

:: Robocopy exit codes 0-7 are success/no-change/extra-files
if %ERRORLEVEL% GEQ 8 (
    echo Error: Robocopy failed with exit code %ERRORLEVEL%.
    exit /b %ERRORLEVEL%
)

echo === Build and sync completed successfully ===
pause