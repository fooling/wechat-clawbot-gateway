#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/wechat-gateway"
SERVICE_USER="wechat"

echo "=== WeChat Gateway Installer ==="

# Create system user if not exists
if ! id "$SERVICE_USER" &>/dev/null; then
  echo "Creating user $SERVICE_USER..."
  sudo useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# Create install directory
sudo mkdir -p "$INSTALL_DIR"

# Copy built files
echo "Copying files to $INSTALL_DIR..."
sudo cp -r dist/ "$INSTALL_DIR/"
sudo cp package.json package-lock.json "$INSTALL_DIR/"
sudo cp config.example.yaml "$INSTALL_DIR/config.yaml"

# Install production dependencies
echo "Installing dependencies..."
cd "$INSTALL_DIR"
sudo npm install --omit=dev

# Set permissions
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
sudo chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true

# Install systemd service
echo "Installing systemd service..."
sudo cp deploy/wechat-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit $INSTALL_DIR/config.yaml"
echo "  2. Create $INSTALL_DIR/.env with API keys"
echo "  3. First run with TUI to scan QR code:"
echo "     sudo -u $SERVICE_USER node $INSTALL_DIR/dist/index.js --tui"
echo "  4. Then enable the service:"
echo "     sudo systemctl enable --now wechat-gateway"
