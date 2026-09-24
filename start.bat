@echo off
chcp 65001 >nul
echo ==========================================
echo DeepSeek Harness - Start
echo ==========================================
echo.

cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies using China mirror...
    call npm install --registry=https://registry.npmmirror.com
    echo.
)

echo Starting application...
echo.

call npm start

if errorlevel 1 (
    echo.
    echo [ERROR] Application failed to start.
    echo Please check the error message above.
)

echo.
pause
