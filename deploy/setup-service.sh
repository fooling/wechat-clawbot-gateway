#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="wechat-gateway"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(which node)"
CURRENT_USER="$(whoami)"

# Build first
echo "Building..."
npm run build --prefix "$WORK_DIR"

# Generate service file for current directory and user
echo "Installing systemd service..."
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=WeChat Channel Gateway
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${WORK_DIR}
ExecStart=${NODE_BIN} ${WORK_DIR}/dist/index.js
Restart=always
RestartSec=10
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

echo ""
echo "Done! Service installed at ${SERVICE_FILE}"
echo ""
echo "Commands:"
echo "  sudo systemctl start ${SERVICE_NAME}     # 启动"
echo "  sudo systemctl stop ${SERVICE_NAME}      # 停止"
echo "  sudo systemctl restart ${SERVICE_NAME}   # 重启"
echo "  journalctl -u ${SERVICE_NAME} -f         # 查看日志"
echo ""
echo "Note: Make sure you have run 'npm run dev' first to scan QR code."
