#!/usr/bin/env bash
# ============================================================
#  美股监控 · VPS 一键部署（Ubuntu / Debian）
#
#  用法（在 VPS 上执行）：
#    git clone <你的仓库地址> /opt/us-monitor
#    cd /opt/us-monitor
#    bash deploy/setup_vps.sh "<企业微信webhook>" "<SUPABASE_URL>" "<SUPABASE_KEY>"
#
#  后两个参数可留空（留空则用本地 dedup_cache.json 去重）
#  轮询间隔默认 60 秒，可用 INTERVAL=30 bash deploy/setup_vps.sh ... 覆盖
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/us-monitor}"
WEBHOOK="${1:-}"
SUPA_URL="${2:-}"
SUPA_KEY="${3:-}"
INTERVAL="${INTERVAL:-60}"

if [ ! -f "$APP_DIR/backend/us_market_monitor.py" ]; then
  echo "[ERROR] 找不到 $APP_DIR/backend/us_market_monitor.py，请先 clone 仓库到 $APP_DIR"
  exit 1
fi
if [ -z "$WEBHOOK" ]; then
  echo "[ERROR] 第一个参数是企业微信 webhook 地址，不能为空"
  exit 1
fi

echo "==> 安装依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip curl

echo "==> 创建虚拟环境"
cd "$APP_DIR"
python3 -m venv venv
./venv/bin/pip install -q --upgrade pip
./venv/bin/pip install -q -r requirements.txt

echo "==> 写入密钥"
cat > "$APP_DIR/backend/.env" <<EOF
WECOM_WEBHOOK_URL=$WEBHOOK
SUPABASE_URL=$SUPA_URL
SUPABASE_KEY=$SUPA_KEY
EOF
chmod 600 "$APP_DIR/backend/.env"

echo "==> 设置时区"
timedatectl set-timezone Asia/Shanghai || true

echo "==> 注册 systemd 服务（崩溃自动重启）"
cat > /etc/systemd/system/us-market-monitor.service <<EOF
[Unit]
Description=US Market Monitor (WeCom push)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=TZ=Asia/Shanghai
Environment=MONITOR_TZ=Asia/Shanghai
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP_DIR/venv/bin/python $APP_DIR/backend/us_market_monitor.py --simple --interval $INTERVAL
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now us-market-monitor
sleep 3
systemctl status us-market-monitor --no-pager || true

echo ""
echo "部署完成。常用命令："
echo "  查看状态 : systemctl status us-market-monitor"
echo "  实时日志 : journalctl -u us-market-monitor -f"
echo "  重启     : systemctl restart us-market-monitor"
echo "  停止     : systemctl stop us-market-monitor"
