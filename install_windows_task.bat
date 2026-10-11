@echo off
chcp 65001 >nul
:: ============================================
::  安装 Windows 计划任务 — 美股监控每分钟触发
::  需要以管理员身份运行！
:: ============================================

echo ╔══════════════════════════════════════════╗
echo ║  安装 Windows 计划任务                    ║
echo ║  美股监控每分钟执行一次                   ║
echo ║  需要管理员权限！                         ║
echo ╚══════════════════════════════════════════╝
echo.

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 请以管理员身份运行此脚本！
    echo 右键此文件 -> "以管理员身份运行"
    pause
    exit /b 1
)

set PYTHON=C:\Users\cwz20\.workbuddy\binaries\python\versions\3.14.3\python.exe
set SCRIPT=%~dp0backend\us_market_monitor.py
set TASK_NAME=USMarketMonitor

echo 创建计划任务: %TASK_NAME%
echo   执行程序: %PYTHON%
echo   执行脚本: %SCRIPT%
echo   触发间隔: 每1分钟
echo.

:: 删除旧任务（如果存在）
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: 创建新任务 — 每1分钟执行一次
schtasks /create ^
    /tn "%TASK_NAME%" ^
    /tr "\"%PYTHON%\" \"%SCRIPT%\" --once" ^
    /sc minute ^
    /mo 1 ^
    /ru SYSTEM ^
    /rl HIGHEST ^
    /f

if %errorlevel% equ 0 (
    echo.
    echo ✅ 计划任务安装成功！
    echo    任务名: %TASK_NAME%
    echo    频率: 每1分钟
    echo.
    echo 查看/管理: 运行 taskschd.msc 打开任务计划程序
) else (
    echo.
    echo ❌ 安装失败，请检查权限
)

pause
