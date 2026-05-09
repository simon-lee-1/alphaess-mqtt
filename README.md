# AlphaESS Battery Controller

Lightweight service that connects to the AlphaESS Open API and exposes battery charge control via MQTT with Home Assistant auto-discovery.

## Features

- **Battery mode control** — charge from grid, self-consumption (auto), or preserve SOC
- **MQTT + HA auto-discovery** — entities appear automatically in Home Assistant
- **Real-time monitoring** — SOC, battery/grid/PV/load power, updated every 60s
- **Daily energy sensors** — PV generation, grid import/export, battery charge/discharge (kWh, total_increasing for HA Energy Dashboard)
- **Built-in scheduler** — daily charge at 11:00, stop at 14:00 (configurable off-peak window)
- **Configurable duration and target SOC** — set from HA UI before triggering mode
- **Fetch timeout** — 30s timeout on all API calls prevents process hangs
- **Error reporting** — last error sensor with timestamps

> **Supported modes:** Charge (grid charge), Auto (self-consumption — battery charges from PV, discharges to serve load), and Preserve (hold SOC at current level). The AlphaESS API does not support forced discharge/export to grid.

## Home Assistant Entities

| Entity | Type | Description |
|--------|------|-------------|
| Battery Mode | select | Charge / Auto / Preserve |
| Mode Duration | number | Duration in minutes (15-480) |
| Target SOC | number | Target state of charge (10-100%) |
| State of Charge | sensor | Current battery % |
| Battery Power | sensor | Watts (+ charging, - discharging) |
| Grid Power | sensor | Watts (+ importing, - exporting) |
| PV Power | sensor | Solar generation watts |
| Load Power | sensor | House consumption watts |
| Current Mode | sensor | Active mode (derived from config) |
| Charge Config | sensor | Current charge schedule (JSON attrs) |
| Daily PV Generation | sensor | kWh (total_increasing) |
| Daily Grid Import | sensor | kWh (total_increasing) |
| Daily Grid Export | sensor | kWh (total_increasing) |
| Daily Battery Charge | sensor | kWh (total_increasing) |
| Daily Battery Discharge | sensor | kWh (total_increasing) |
| Last Error | sensor | Error reporting |

## Setup

### 1. Register for AlphaESS Open API

1. Create account at https://open.alphaess.com/
2. Get your **AppID** and **AppSecret**
3. Bind your inverter serial number (requires CheckCode from physical unit)

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Install and run

```bash
npm install
npm run build
npm start
```

### 4. Systemd service (optional)

```bash
sudo cp alphaess-controller.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now alphaess-controller
```

## How it works

The AlphaESS Open API doesn't have explicit "force charge now" commands. Instead, the service:

- **Charge**: Sets `gridCharge=1` with a time window from now to now + duration
- **Auto**: Clears `gridCharge` flag — self-consumption (charges from PV, serves household load from battery)
- **Preserve**: Sets a high `batHighCap` threshold to prevent discharge below current SOC

Time windows are rounded to 15-minute intervals (API requirement).

### API Flag Behaviour

| gridCharge | ctrDis | Result |
|---|---|---|
| `false` | `false` | **Auto** — self-consumption, battery charges from PV and discharges to serve load |
| `true` | `false` | **Charge** — battery charges from grid (within time window) |
| `false` | `true` | **Preserve** — battery holds SOC, won't discharge to serve load (grid covers all demand) |
| `true` | `true` | Charge + Preserve — charges from grid AND won't discharge (same effect as Charge while in window) |

### Built-in Scheduler

The service includes a daily scheduler that runs independently of HA automations:

- **11:00** — `forceCharge(180, 100)` — enables grid charging (off-peak window start)
- **14:00** — `selfConsumption()` — explicitly disables grid charging (off-peak window end)

This is necessary because the AlphaESS time window is only a *permission* window — the inverter does NOT automatically stop charging when the end time passes. An explicit `gridCharge=false` command is required.

The scheduler checks every 30 seconds and uses a dedup guard to prevent re-execution within the same minute.

## Requirements

- Node.js 18+
- MQTT broker (e.g. Mosquitto via Home Assistant)
- AlphaESS Open API credentials
- Compatible inverter (tested on SMILE5)

## License

MIT
