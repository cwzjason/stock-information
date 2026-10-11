@echo off
chcp 65001 >nul
title 美股实时监控 - US Market Monitor

echo.
echo ╔══════════════════════════════════════╗
echo ║  美股实时消息监控 - 定时推送服务      ║
echo ╚══════════════════════════════════════╝
echo.

set PYTHON=C:\Users\cwz20\.workbuddy\binaries\python\versions\3.14.3\python.exe
set SCRIPT=%~dp0backend\us_market_monitor.py

echo [%date% %time%] 启动中...
echo   轮询间隔: 3分钟
echo   推送通道: 企业微信
echo   按 Ctrl+C 停止
echo.

%PYTHON% "%SCRIPT%" --scheduler --interval 180

pause
