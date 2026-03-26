#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="wechat-gateway"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CONFIG_DIR="/etc/wechat-gateway"
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(which node)"
CURRENT_USER="$(whoami)"

# Build first
echo "Building..."
npm run build --prefix "$WORK_DIR"

# Install config to /etc/wechat-gateway/
echo "Installing config..."
sudo mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
  sudo cp "$WORK_DIR/config.example.yaml" "$CONFIG_DIR/config.yaml"
  sudo chown "$CURRENT_USER:$CURRENT_USER" "$CONFIG_DIR/config.yaml"
  echo "  Created $CONFIG_DIR/config.yaml (from config.example.yaml)"
else
  echo "  $CONFIG_DIR/config.yaml already exists, skipping"
fi

# Generate service file
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
echo "Done!"
echo ""
echo "Config: $CONFIG_DIR/config.yaml"
echo "  Edit it to enable channels, then restart the service."
echo ""
echo "Commands:"
echo "  sudo systemctl start ${SERVICE_NAME}     # 启动"
echo "  sudo systemctl stop ${SERVICE_NAME}      # 停止"
echo "  sudo systemctl restart ${SERVICE_NAME}   # 重启"
echo "  journalctl -u ${SERVICE_NAME} -f         # 查看日志"
