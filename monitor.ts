/**
 * 48-hour power monitoring script.
 * Polls AlphaESS every 5 minutes and logs to CSV.
 * Run: npx ts-node monitor.ts
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const APP_ID = process.env.ALPHAESS_APP_ID || 'alpha2aedd90e2f98b141';
const APP_SECRET = process.env.ALPHAESS_APP_SECRET || '9ee080e1c611440a8136352c254e0161';
const SERIAL = process.env.ALPHAESS_SERIAL || 'AL7011025084555';
const API_BASE = 'https://openapi.alphaess.com/api';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours
const LOG_FILE = path.join(__dirname, 'power_monitor.csv');

function getHeaders(): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = crypto.createHash('sha512').update(APP_ID + APP_SECRET + timestamp).digest('hex');
  return { appId: APP_ID, timeStamp: timestamp, sign, 'Content-Type': 'application/json' };
}

async function fetchPowerData(): Promise<{
  soc: number; batteryPower: number; gridPower: number; pvPower: number; loadPower: number;
} | null> {
  try {
    const res = await fetch(`${API_BASE}/getLastPowerData?sysSn=${SERIAL}`, { headers: getHeaders() });
    const json = await res.json() as any;
    if (json.code !== 200) throw new Error(`API error ${json.code}: ${json.msg}`);
    const d = json.data;
    return {
      soc: d.soc ?? 0,
      batteryPower: d.pbat ?? 0,
      gridPower: d.pgrid ?? 0,
      pvPower: d.ppv ?? 0,
      loadPower: d.pload ?? 0,
    };
  } catch (e: any) {
    console.error(`[${new Date().toISOString()}] Fetch error: ${e.message}`);
    return null;
  }
}

function initLog() {
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, 'timestamp,soc_pct,battery_w,grid_w,pv_w,load_w\n');
  }
}

function appendLog(data: { soc: number; batteryPower: number; gridPower: number; pvPower: number; loadPower: number }) {
  const ts = new Date().toISOString();
  const line = `${ts},${data.soc},${data.batteryPower},${data.gridPower},${data.pvPower},${data.loadPower}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

async function poll() {
  const data = await fetchPowerData();
  if (data) {
    appendLog(data);
    const ts = new Date().toLocaleTimeString('en-AU', { hour12: false });
    console.log(`[${ts}] SOC:${data.soc}% Load:${data.loadPower}W Grid:${data.gridPower}W PV:${data.pvPower}W Bat:${data.batteryPower}W`);
  }
}

async function main() {
  initLog();
  console.log(`Monitoring power every 5 min for 48h. Logging to ${LOG_FILE}`);
  console.log(`Started: ${new Date().toISOString()}`);

  await poll(); // immediate first poll

  const interval = setInterval(poll, POLL_INTERVAL_MS);

  setTimeout(() => {
    clearInterval(interval);
    console.log(`\nMonitoring complete. ${LOG_FILE} has your data.`);
    process.exit(0);
  }, DURATION_MS);
}

main();
