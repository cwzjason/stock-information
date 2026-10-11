@echo off
chcp 65001 >nul

echo ╔══════════════════════════════════════════╗
echo ║  卸载 Windows 计划任务                    ║
echo ╚══════════════════════════════════════════╝
echo.

schtasks /delete /tn "USMarketMonitor" /f

if %errorlevel% equ 0 (
    echo ✅ 计划任务已卸载
) else (
    echo ❌ 卸载失败或任务不存在
)

pause
