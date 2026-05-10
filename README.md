# AlphaESS Battery Controller

Lightweight service that connects to the AlphaESS Open API and exposes battery monitoring and charge configuration via MQTT with Home Assistant auto-discovery.

## Important Limitation

**The AlphaESS Open API cannot reliably force grid charging or discharging.** The `updateChargeConfigInfo` endpoint only sets a *permission window* — it tells the inverter "you may charge from grid during this time" but does NOT command it to actually do so. The inverter will not start charging from grid based on this flag alone.

Actual grid charge dispatch is triggered by the VPP (Virtual Power Plant) operator through a proprietary TCP channel (cloud → WiFi dongle → Modbus RS485 → inverter dispatch registers). Neither the AlphaESS app nor the Open API can trigger this — only the VPP dispatch system writes to the Modbus dispatch registers that command the inverter to charge.

**To reliably control charge/discharge yourself**, you need direct Modbus access to the inverter's dispatch registers (0x0880-0x0888) via either:
- USB-to-RS485 adapter connected to the inverter's CAN/RS485 RJ45 port
- Modbus TCP on port 502 (if Ethernet port is accessible)

See [Alpha2MQTT](https://github.com/dxoverdy/Alpha2MQTT) for a proven Modbus implementation.

**What this service CAN do reliably:**
- Monitor real-time power data (SOC, battery/grid/PV/load watts)
- Monitor daily energy totals
- Set charge/discharge permission windows (not sufficient to trigger charging on their own)
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
| `true` | `false` | **Charge window open** — inverter is *permitted* to charge from grid (requires VPP dispatch or Modbus to actually start) |
| `false` | `true` | **Preserve** — battery holds SOC, won't discharge to serve load (grid covers all demand) |
| `true` | `true` | Charge window open + Preserve |

### Built-in Scheduler

The service includes a daily scheduler that runs independently of HA automations:

- **11:00** — `forceCharge(180, 100)` — opens grid charge permission window
- **14:00** — `selfConsumption()` — explicitly closes the window (`gridCharge=false`)

Closing the window at 14:00 **does** reliably stop an active charge. Opening the window at 11:00 does NOT start charging — it only permits it. Actual charging is dispatched by the VPP operator or requires direct Modbus commands.

The scheduler checks every 30 seconds and uses a dedup guard to prevent re-execution within the same minute.

### What's needed for reliable dispatch

The actual "force charge now" command writes to Modbus dispatch registers on the inverter (0x0880-0x0888) via RS485. The SMILE5 has an RJ45 CAN/RS485 port on the bottom communications panel (separate from WiFi dongle):

| RJ45 Pin | Signal | Wire (T-568B) |
|----------|--------|---------------|
| 3 | GND/COM | Green-White |
| 4 | RS485 B- | Blue |
| 5 | RS485 A+ | Blue-White |

Slave address: 0x55, baud: 9600. See Alpha2MQTT for the register map.

## Exposed Sensors

### Real-time Power (from `getLastPowerData`, every 30s)

| Sensor | Entity ID | Unit | Description |
|--------|-----------|------|-------------|
| PV Power | `sensor.alphaess_battery_pv_power` | W | Total solar (all strings + CT) |
| PV1 Power | `sensor.alphaess_battery_pv1_power` | W | DC string 1 (AlphaESS panels) |
| PV Meter DC | `sensor.alphaess_battery_pv_meter_dc` | W | CT clamp (AC-coupled inverters e.g. Solis) |
| Battery Power | `sensor.alphaess_battery_battery_power` | W | +ve=charging, -ve=discharging |
| Grid Power | `sensor.alphaess_battery_grid_power` | W | +ve=importing, -ve=exporting |
| Load Power | `sensor.alphaess_battery_load_power` | W | Household consumption |
| SOC | `sensor.alphaess_battery_state_of_charge` | % | Battery state of charge |

### Daily Energy (from `getOneDateEnergyBySn`, every poll)

| Sensor | Entity ID | Unit | Description |
|--------|-----------|------|-------------|
| Daily PV | `sensor.alphaess_battery_daily_pv_generation` | kWh | Total solar generation today |
| Daily Grid Import | `sensor.alphaess_battery_daily_grid_import` | kWh | Energy imported from grid |
| Daily Grid Export | `sensor.alphaess_battery_daily_grid_export` | kWh | Energy exported to grid |
| Daily Battery Charge | `sensor.alphaess_battery_daily_battery_charge` | kWh | Total energy into battery |
| Daily Battery Discharge | `sensor.alphaess_battery_daily_battery_discharge` | kWh | Total energy from battery |
| Daily Grid Charge | `sensor.alphaess_battery_daily_grid_charge` | kWh | Grid-to-battery energy |

### Available but not exposed (add if needed)

From `getLastPowerData.ppvDetail`:
- `ppv2`, `ppv3`, `ppv4` — additional DC strings (0 if unused)

From `getLastPowerData`:
- `pev` — EV charger power (W)
- `pevDetail.ev1-4Power` — per-charger breakdown
- `prealL1/L2/L3` — real power per phase (W)
- `pgridDetail.pmeterL1/L2/L3` — grid meter per phase (W)

From `getOneDateEnergyBySn`:
- `eChargingPile` — EV charging energy (kWh)

## Requirements

- Node.js 18+
- MQTT broker (e.g. Mosquitto via Home Assistant)
- AlphaESS Open API credentials
- Compatible inverter (tested on SMILE5)

## License

MIT
