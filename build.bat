@echo off
chcp 65001 >nul
echo ==========================================
echo DeepSeek Harness - Build (Fast)
echo ==========================================
echo.

cd /d "%~dp0"

REM Use China mirrors for faster downloads
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

REM Skip code signing completely
set CSC_IDENTITY_AUTO_DISCOVERY=false

echo Building portable .exe...
call npm run build

if errorlevel 1 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)

echo.
echo Build complete! Output: dist\DeepSeek-Harness.exe
echo.

pause
