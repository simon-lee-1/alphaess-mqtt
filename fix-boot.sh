#!/bin/bash
# Fix all MQTT services to survive host reboot with ecryptfs-encrypted home.
# Copies runtime files to /opt (always mounted) and updates systemd units.
# Converts BedJet from user service to system service.

set -e

echo "=== AlphaESS Controller ==="
SRC=/home/simon/alphaess-controller
DST=/opt/alphaess-controller
sudo mkdir -p "$DST"
sudo cp -a "$SRC/dist" "$SRC/.env" "$SRC/package.json" "$SRC/node_modules" "$DST/"
sudo chown -R simon:simon "$DST"
sudo sed -i "s|WorkingDirectory=.*|WorkingDirectory=$DST|" /etc/systemd/system/alphaess-controller.service
sudo sed -i "s|EnvironmentFile=.*|EnvironmentFile=$DST/.env|" /etc/systemd/system/alphaess-controller.service
echo "  Copied to $DST"

echo ""
echo "=== Powerpal BLE Gateway ==="
SRC=/home/simon/headless-powerpal
DST=/opt/powerpal-ble-gateway
sudo mkdir -p "$DST"
sudo cp -a "$SRC/powerpal_ble_gateway.py" "$SRC/.env.ble" "$DST/"
# Copy any other runtime dependencies
[ -f "$SRC/requirements.txt" ] && sudo cp "$SRC/requirements.txt" "$DST/"
[ -d "$SRC/powerpal.db" ] || [ -f "$SRC/powerpal.db" ] && sudo cp "$SRC/powerpal.db" "$DST/" 2>/dev/null || true
sudo chown -R simon:simon "$DST"
sudo sed -i "s|ExecStart=.*|ExecStart=/usr/bin/python3 $DST/powerpal_ble_gateway.py|" /etc/systemd/system/powerpal-ble-gateway.service
sudo sed -i "s|WorkingDirectory=.*|WorkingDirectory=$DST|" /etc/systemd/system/powerpal-ble-gateway.service
sudo sed -i "s|EnvironmentFile=.*|EnvironmentFile=$DST/.env.ble|" /etc/systemd/system/powerpal-ble-gateway.service
echo "  Copied to $DST"

echo ""
echo "=== BedJet Bridge ==="
SRC=/home/simon/home-assistant-bot
DST=/opt/bedjet-bridge
sudo mkdir -p "$DST"
sudo cp -a "$SRC/bedjet_bridge.py" "$DST/"
# Copy any other python files it imports
find "$SRC" -maxdepth 1 -name "*.py" -exec sudo cp {} "$DST/" \;
[ -f "$SRC/requirements.txt" ] && sudo cp "$SRC/requirements.txt" "$DST/"
[ -f "$SRC/.env" ] && sudo cp "$SRC/.env" "$DST/"
sudo chown -R simon:simon "$DST"

# Disable user service, create system service
systemctl --user stop bedjet-bridge.service 2>/dev/null || true
systemctl --user disable bedjet-bridge.service 2>/dev/null || true

sudo tee /etc/systemd/system/bedjet-bridge.service > /dev/null << 'EOF'
[Unit]
Description=BedJet V3 BLE-to-MQTT Bridge
After=bluetooth.target dbus.service
Wants=bluetooth.target

[Service]
Type=simple
User=simon
Group=simon
WorkingDirectory=/opt/bedjet-bridge
ExecStart=/usr/bin/python3 /opt/bedjet-bridge/bedjet_bridge.py
Restart=always
RestartSec=10
SupplementaryGroups=bluetooth

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable bedjet-bridge.service
echo "  Copied to $DST, converted to system service"

echo ""
echo "=== Reloading systemd ==="
sudo systemctl daemon-reload
sudo systemctl restart alphaess-controller
sudo systemctl restart powerpal-ble-gateway
sudo systemctl restart bedjet-bridge

sleep 3
echo ""
echo "=== Status ==="
systemctl is-active alphaess-controller && echo "  alphaess-controller: OK" || echo "  alphaess-controller: FAILED"
systemctl is-active powerpal-ble-gateway && echo "  powerpal-ble-gateway: OK" || echo "  powerpal-ble-gateway: FAILED"
systemctl is-active bedjet-bridge && echo "  bedjet-bridge: OK" || echo "  bedjet-bridge: FAILED"

echo ""
echo "Done. All services now run from /opt (outside ecryptfs)."
echo "NOTE: After code changes, re-copy the relevant files to /opt."
