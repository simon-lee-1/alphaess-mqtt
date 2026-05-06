/**
 * AlphaESS Open API client.
 *
 * Handles HMAC-SHA512 authentication and provides methods for
 * reading system status and controlling charge/discharge configuration.
 */

import * as crypto from 'crypto';

const API_BASE = 'https://openapi.alphaess.com/api';

export interface AlphaESSConfig {
  appId: string;
  appSecret: string;
  serialNumber: string;
}

export interface PowerData {
  /** Battery state of charge (0-100) */
  soc: number;
  /** Battery power in watts (positive = charging, negative = discharging) */
  batteryPower: number;
  /** Grid power in watts (positive = importing, negative = exporting) */
  gridPower: number;
  /** PV generation in watts */
  pvPower: number;
  /** Load consumption in watts */
  loadPower: number;
}

export interface ChargeConfig {
  gridCharge: boolean;
  batHighCap: number;
  timeChaf1: string;
  timeChae1: string;
  timeChaf2: string;
  timeChae2: string;
}

export interface DischargeConfig {
  ctrDis: boolean;
  batUseCap: number;
  timeDisf1: string;
  timeDise1: string;
  timeDisf2: string;
  timeDise2: string;
}

export interface SystemInfo {
  sysSn: string;
  popv: number;
  minv: string;
  poinv: number;
  cobat: number;
  [key: string]: unknown;
}

interface ApiResponse<T> {
  code: number;
  msg: string;
  data: T;
}

export class AlphaESSApi {
  constructor(private readonly config: AlphaESSConfig) {}

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  private getHeaders(): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sign = crypto
      .createHash('sha512')
      .update(this.config.appId + this.config.appSecret + timestamp)
      .digest('hex');

    return {
      'appId': this.config.appId,
      'timeStamp': timestamp,
      'sign': sign,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${API_BASE}${path}`;
    const headers = this.getHeaders();

    const options: RequestInit = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`AlphaESS API ${response.status}: ${response.statusText}`);
    }

    const json = await response.json() as ApiResponse<T>;
    if (json.code !== 200) {
      throw new Error(`AlphaESS API error ${json.code}: ${json.msg}`);
    }

    return json.data;
  }

  // ---------------------------------------------------------------------------
  // Read operations
  // ---------------------------------------------------------------------------

  async getSystemList(): Promise<SystemInfo[]> {
    return this.request<SystemInfo[]>('GET', '/getEssList');
  }

  async getPowerData(): Promise<PowerData> {
    const data = await this.request<any>(
      'GET',
      `/getLastPowerData?sysSn=${this.config.serialNumber}`,
    );

    return {
      soc: data.soc ?? 0,
      batteryPower: data.pbat ?? 0,
      gridPower: data.pgrid ?? 0,
      pvPower: data.ppv ?? 0,
      loadPower: data.pload ?? 0,
    };
  }

  async getChargeConfig(): Promise<ChargeConfig> {
    const data = await this.request<any>(
      'GET',
      `/getChargeConfigInfo?sysSn=${this.config.serialNumber}`,
    );

    return {
      gridCharge: data.gridCharge === 1,
      batHighCap: data.batHighCap ?? 100,
      timeChaf1: data.timeChaf1 ?? '00:00',
      timeChae1: data.timeChae1 ?? '00:00',
      timeChaf2: data.timeChaf2 ?? '00:00',
      timeChae2: data.timeChae2 ?? '00:00',
    };
  }

  async getDischargeConfig(): Promise<DischargeConfig> {
    const data = await this.request<any>(
      'GET',
      `/getDisChargeConfigInfo?sysSn=${this.config.serialNumber}`,
    );

    return {
      ctrDis: data.ctrDis === 1,
      batUseCap: data.batUseCap ?? 10,
      timeDisf1: data.timeDisf1 ?? '00:00',
      timeDise1: data.timeDise1 ?? '00:00',
      timeDisf2: data.timeDisf2 ?? '00:00',
      timeDise2: data.timeDise2 ?? '00:00',
    };
  }

  // ---------------------------------------------------------------------------
  // Write operations
  // ---------------------------------------------------------------------------

  async setChargeConfig(config: {
    gridCharge: boolean;
    batHighCap?: number;
    timeChaf1: string;
    timeChae1: string;
    timeChaf2?: string;
    timeChae2?: string;
  }): Promise<void> {
    await this.request('POST', '/updateChargeConfigInfo', {
      sysSn: this.config.serialNumber,
      gridCharge: config.gridCharge ? 1 : 0,
      batHighCap: config.batHighCap ?? 100,
      timeChaf1: config.timeChaf1,
      timeChae1: config.timeChae1,
      timeChaf2: config.timeChaf2 ?? '00:00',
      timeChae2: config.timeChae2 ?? '00:00',
    });
  }

  async setDischargeConfig(config: {
    ctrDis: boolean;
    batUseCap?: number;
    timeDisf1: string;
    timeDise1: string;
    timeDisf2?: string;
    timeDise2?: string;
  }): Promise<void> {
    await this.request('POST', '/updateDisChargeConfigInfo', {
      sysSn: this.config.serialNumber,
      ctrDis: config.ctrDis ? 1 : 0,
      batUseCap: config.batUseCap ?? 10,
      timeDisf1: config.timeDisf1,
      timeDise1: config.timeDise1,
      timeDisf2: config.timeDisf2 ?? '00:00',
      timeDise2: config.timeDise2 ?? '00:00',
    });
  }

  // ---------------------------------------------------------------------------
  // High-level battery control
  // ---------------------------------------------------------------------------

  /**
   * Force charge from grid immediately for the given duration.
   * Sets a charge window from now until now + durationMinutes.
   */
  async forceCharge(durationMinutes: number, targetSoc: number = 100): Promise<void> {
    const { start, end } = this.timeWindow(durationMinutes);
    await this.setChargeConfig({
      gridCharge: true,
      batHighCap: targetSoc,
      timeChaf1: start,
      timeChae1: end,
    });
  }

  /**
   * Force discharge (export to grid) immediately for the given duration.
   * Sets a discharge window from now until now + durationMinutes.
   */
  async forceDischarge(durationMinutes: number, minSoc: number = 10): Promise<void> {
    const { start, end } = this.timeWindow(durationMinutes);
    await this.setDischargeConfig({
      ctrDis: true,
      batUseCap: minSoc,
      timeDisf1: start,
      timeDise1: end,
    });
  }

  /**
   * Return to self-consumption mode (no forced charge/discharge).
   */
  async selfConsumption(): Promise<void> {
    await this.setChargeConfig({
      gridCharge: false,
      timeChaf1: '00:00',
      timeChae1: '00:00',
    });
    await this.setDischargeConfig({
      ctrDis: false,
      timeDisf1: '00:00',
      timeDise1: '00:00',
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Round time to nearest 15-minute interval (AlphaESS requirement) */
  private roundTo15(minutes: number): number {
    return Math.ceil(minutes / 15) * 15;
  }

  /** Get a time window from now for the given duration (rounded to 15 min) */
  private timeWindow(durationMinutes: number): { start: string; end: string } {
    const now = new Date();
    // Round start down to current 15-min slot
    const startMinutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = `${String(now.getHours()).padStart(2, '0')}:${String(startMinutes).padStart(2, '0')}`;

    const endDate = new Date(now.getTime() + this.roundTo15(durationMinutes) * 60_000);
    // If end crosses midnight, cap at 23:45
    if (endDate.getDate() !== now.getDate()) {
      return { start, end: '23:45' };
    }
    const end = `${String(endDate.getHours()).padStart(2, '0')}:${String(Math.floor(endDate.getMinutes() / 15) * 15).padStart(2, '0')}`;

    return { start, end };
  }
}
