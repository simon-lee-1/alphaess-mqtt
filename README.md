# AlphaESS Battery Controller

Lightweight service that connects to the AlphaESS Open API and exposes battery monitoring and charge configuration via MQTT with Home Assistant auto-discovery.

## Important Limitation

**The AlphaESS Open API cannot reliably force grid charging or discharging.** The `updateChargeConfigInfo` endpoint only sets a *permission window* — it tells the inverter "you may charge from grid during this time" but does NOT command it to actually do so. The inverter may or may not charge depending on its internal state.

When you press "Force Charge" in the AlphaESS/GloBird app, the command goes through a proprietary TCP channel (cloud → WiFi dongle → Modbus RS485 → inverter dispatch registers). This dispatch mechanism is not exposed via the Open API.

**To reliably control charge/discharge**, you need direct Modbus access to the inverter's dispatch registers (0x0880-0x0888) via either:
- USB-to-RS485 adapter connected to the inverter's CAN/RS485 RJ45 port
- Modbus TCP on port 502 (if Ethernet port is accessible)

See [Alpha2MQTT](https://github.com/dxoverdy/Alpha2MQTT) for a proven Modbus implementation.

**What this service CAN do reliably:**
- Monitor real-time power data (SOC, battery/grid/PV/load watts)
- Monitor daily energy totals
- Set charge/discharge permission windows (may or may not be honoured by inverter)
- Stop a charge that's already running (setting `gridCharge=false` does reliably stop it)

## Features

- **MQTT + HA auto-discovery** — entities appear automatically in Home Assistant
- **Real-time monitoring** — SOC, battery/grid/PV/load power, updated every 60s
- **Daily energy sensors** — PV generation, grid import/export, battery charge/discharge (kWh, total_increasing for HA Energy Dashboard)
- **Charge config control** — set permission windows via MQTT commands
- **Built-in scheduler** — daily charge window at 11:00, close at 14:00
- **Configurable duration and target SOC** — set from HA UI
- **Fetch timeout** — 30s timeout on all API calls prevents process hangs
- **Error reporting** — last error sensor with timestamps

> **Note:** Charge/discharge commands set the API permission flags but may not trigger actual grid charging. The scheduler ensures the permission window is open during off-peak hours, but actual charging may require additional dispatch via Modbus or the manufacturer app.

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

The AlphaESS Open API doesn't have explicit "force charge now" commands. The service sets configuration flags that define *when* charging is permitted:

- **Charge**: Sets `gridCharge=1` with a time window — inverter *may* charge from grid
- **Auto**: Clears `gridCharge` flag — self-consumption (charges from PV, discharges to serve load)
- **Preserve**: Sets `ctrDis=1` — battery holds SOC, won't discharge to serve load

Time windows are rounded to 15-minute intervals (API requirement).

### API Flag Behaviour

| gridCharge | ctrDis | Result |
|---|---|---|
| `false` | `false` | **Auto** — self-consumption, battery charges from PV and discharges to serve load |
| `true` | `false` | **Charge window open** — inverter is *permitted* to charge from grid (not guaranteed) |
| `false` | `true` | **Preserve** — battery holds SOC, won't discharge to serve load (grid covers all demand) |
| `true` | `true` | Charge window open + Preserve |

### Built-in Scheduler

The service includes a daily scheduler that runs independently of HA automations:

- **11:00** — `forceCharge(180, 100)` — opens grid charge permission window
- **14:00** — `selfConsumption()` — explicitly closes the window (`gridCharge=false`)

Closing the window at 14:00 **does** reliably stop an active charge. Opening the window at 11:00 does NOT reliably start one — the inverter may ignore it.

The scheduler checks every 30 seconds and uses a dedup guard to prevent re-execution within the same minute.

### What's needed for reliable dispatch

The actual "force charge now" command writes to Modbus dispatch registers on the inverter (0x0880-0x0888) via RS485. The SMILE5 has an RJ45 CAN/RS485 port on the bottom communications panel (separate from WiFi dongle):

| RJ45 Pin | Signal | Wire (T-568B) |
|----------|--------|---------------|
| 3 | GND/COM | Green-White |
| 4 | RS485 B- | Blue |
| 5 | RS485 A+ | Blue-White |

Slave address: 0x55, baud: 9600. See Alpha2MQTT for the register map.

## Requirements

- Node.js 18+
- MQTT broker (e.g. Mosquitto via Home Assistant)
- AlphaESS Open API credentials
- Compatible inverter (tested on SMILE5)

## License

MIT
