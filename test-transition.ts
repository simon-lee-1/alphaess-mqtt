/**
 * Test: does changing battery mode cause a grid import spike?
 * Polls every 10s, triggers Auto→Discharge→Auto, logs grid power throughout.
 */

import * as crypto from 'crypto';

const APP_ID = process.env.ALPHAESS_APP_ID || 'alpha2aedd90e2f98b141';
const APP_SECRET = process.env.ALPHAESS_APP_SECRET || '9ee080e1c611440a8136352c254e0161';
const SERIAL = process.env.ALPHAESS_SERIAL || 'AL7011025084555';
const API_BASE = 'https://openapi.alphaess.com/api';

function getHeaders(): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = crypto.createHash('sha512').update(APP_ID + APP_SECRET + timestamp).digest('hex');
  return { appId: APP_ID, timeStamp: timestamp, sign, 'Content-Type': 'application/json' };
}

async function getPower(): Promise<{ soc: number; grid: number; bat: number; load: number } | null> {
  try {
    const res = await fetch(`${API_BASE}/getLastPowerData?sysSn=${SERIAL}`, { headers: getHeaders() });
    const json = await res.json() as any;
    if (json.code !== 200) return null;
    return { soc: json.data.soc, grid: json.data.pgrid, bat: json.data.pbat, load: json.data.pload };
  } catch { return null; }
}

async function setDischarge(enabled: boolean): Promise<boolean> {
  const body = {
    sysSn: SERIAL,
    ctrDis: enabled ? 1 : 0,
    batUseCap: 40,
    timeDisf1: enabled ? '00:00' : '00:00',
    timeDise1: enabled ? '23:59' : '00:00',
    timeDisf2: '00:00',
    timeDise2: '00:00',
  };
  try {
    const res = await fetch(`${API_BASE}/updateDisChargeConfigInfo`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify(body),
    });
    const json = await res.json() as any;
    return json.code === 200;
  } catch { return false; }
}

async function setCharge(enabled: boolean): Promise<boolean> {
  const body = {
    sysSn: SERIAL,
    gridCharge: enabled ? 1 : 0,
    batHighCap: 100,
    timeChaf1: '00:00',
    timeChae1: '00:00',
    timeChaf2: '00:00',
    timeChae2: '00:00',
  };
  try {
    const res = await fetch(`${API_BASE}/updateChargeConfigInfo`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify(body),
    });
    const json = await res.json() as any;
    return json.code === 200;
  } catch { return false; }
}

function ts() { return new Date().toLocaleTimeString('en-AU', { hour12: false }); }

async function main() {
  console.log('=== Mode Transition Test ===');
  console.log('Polling grid power every 10s. Will trigger mode changes.\n');
  console.log('Time        | Grid(W) | Bat(W) | Load(W) | SOC% | Event');
  console.log('------------|---------|--------|---------|------|------');

  let event = '';
  const readings: { t: number; grid: number }[] = [];

  // Poll function
  async function poll() {
    const d = await getPower();
    if (d) {
      readings.push({ t: Date.now(), grid: d.grid });
      console.log(`${ts()} | ${String(d.grid).padStart(7)} | ${String(d.bat).padStart(6)} | ${String(d.load).padStart(7)} | ${String(d.soc).padStart(4)} | ${event}`);
      event = '';
    }
  }

  // Phase 1: baseline (30s)
  event = 'BASELINE (current mode)';
  for (let i = 0; i < 3; i++) { await poll(); await sleep(10000); }

  // Phase 2: switch to Discharge
  event = '>>> SET DISCHARGE';
  const ok1 = await setDischarge(true);
  console.log(`${ts()} |         |        |         |      | Discharge API: ${ok1 ? 'OK' : 'FAILED'}`);

  // Phase 3: monitor transition (90s)
  for (let i = 0; i < 9; i++) { await poll(); await sleep(10000); }

  // Phase 4: switch back to Auto (disable discharge)
  event = '>>> SET AUTO';
  const ok2 = await setDischarge(false);
  console.log(`${ts()} |         |        |         |      | Auto API: ${ok2 ? 'OK' : 'FAILED'}`);

  // Phase 5: monitor transition back (90s)
  for (let i = 0; i < 9; i++) { await poll(); await sleep(10000); }

  // Summary
  console.log('\n=== Summary ===');
  const maxGrid = Math.max(...readings.map(r => r.grid));
  const avgGrid = readings.reduce((s, r) => s + r.grid, 0) / readings.length;
  console.log(`Max grid import: ${maxGrid}W`);
  console.log(`Avg grid import: ${avgGrid.toFixed(1)}W`);
  console.log(`Samples: ${readings.length}`);

  if (maxGrid > 50) {
    console.log('\n⚠ Mode transition DID cause import spike above 50W');
  } else if (maxGrid > 30) {
    console.log('\n⚠ Mode transition caused import spike above 30W (but below 50W)');
  } else {
    console.log('\n✓ No significant import spike during mode transitions');
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
main();
