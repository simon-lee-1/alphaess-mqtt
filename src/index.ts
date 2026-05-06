/**
 * AlphaESS Battery Controller
 *
 * Lightweight service that connects to the AlphaESS Open API and exposes
 * battery charge/discharge control via MQTT with Home Assistant auto-discovery.
 */

import { AlphaESSApi } from './alphaess-api';
import { MqttBridge } from './mqtt-bridge';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadConfig() {
  const appId = process.env['ALPHAESS_APP_ID'];
  const appSecret = process.env['ALPHAESS_APP_SECRET'];
  const serialNumber = process.env['ALPHAESS_SERIAL'];

  if (!appId || !appSecret) {
    console.error('Missing ALPHAESS_APP_ID or ALPHAESS_APP_SECRET');
    process.exit(1);
  }
  if (!serialNumber) {
    console.error('Missing ALPHAESS_SERIAL');
    process.exit(1);
  }

  return {
    alphaess: { appId, appSecret, serialNumber },
    mqtt: {
      host: process.env['MQTT_HOST'] ?? '192.168.122.12',
      port: parseInt(process.env['MQTT_PORT'] ?? '1883', 10),
      username: process.env['MQTT_USER'] ?? 'amber',
      password: process.env['MQTT_PASS'] ?? 'amber2026',
    },
    pollInterval: parseInt(process.env['POLL_INTERVAL'] ?? '60', 10) * 1000,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[AlphaESS] Starting battery controller...');

  const config = loadConfig();
  console.log(`[AlphaESS] Serial: ${config.alphaess.serialNumber}`);
  console.log(`[AlphaESS] MQTT: ${config.mqtt.host}:${config.mqtt.port}`);
  console.log(`[AlphaESS] Poll interval: ${config.pollInterval / 1000}s`);

  // Test API connectivity
  const api = new AlphaESSApi(config.alphaess);
  try {
    const power = await api.getPowerData();
    console.log(`[AlphaESS] API connected — SOC: ${power.soc}%, Battery: ${power.batteryPower}W, Grid: ${power.gridPower}W`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AlphaESS] API connection failed: ${msg}`);
    console.error('[AlphaESS] Check ALPHAESS_APP_ID, ALPHAESS_APP_SECRET, and ALPHAESS_SERIAL');
    process.exit(1);
  }

  // Start MQTT bridge
  const bridge = new MqttBridge(api, config.mqtt, config.pollInterval);
  bridge.start();

  // Graceful shutdown
  const shutdown = () => {
    console.log('[AlphaESS] Shutting down...');
    bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[AlphaESS] Fatal error:', err);
  process.exit(1);
});
