/**
 * MQTT bridge for AlphaESS battery controller.
 *
 * Publishes battery state to MQTT with Home Assistant auto-discovery,
 * and accepts control commands via MQTT topics.
 */

import * as mqtt from 'mqtt';
import { AlphaESSApi, PowerData, EnergyData, ChargeConfig, DischargeConfig } from './alphaess-api';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface MqttConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOPIC_PREFIX = 'alphaess_battery';
const DISCOVERY_PREFIX = 'homeassistant';
const AVAILABILITY_TOPIC = `${TOPIC_PREFIX}/availability`;

const DEVICE_INFO = {
  identifiers: ['alphaess_battery'],
  name: 'AlphaESS Battery',
  manufacturer: 'AlphaESS',
  model: 'SMILE5',
};

type BatteryMode = 'Charge' | 'Discharge' | 'Auto';

interface ScheduleEntry {
  hour: number;
  minute: number;
  action: () => Promise<void>;
  label: string;
}

// ---------------------------------------------------------------------------
// MqttBridge
// ---------------------------------------------------------------------------

export class MqttBridge {
  private client: mqtt.MqttClient | null = null;
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private lastError: string = '';
  private currentMode: BatteryMode = 'Auto';
  private lastScheduleRun: string = ''; // "HH:MM" of last executed schedule entry

  private readonly schedule: ScheduleEntry[] = [
    {
      hour: 11, minute: 0,
      action: () => this.api.forceCharge(180, 100),
      label: 'Start charge (11:00)',
    },
    {
      hour: 14, minute: 0,
      action: () => this.api.selfConsumption(),
      label: 'Stop charge (14:00)',
    },
  ];

  constructor(
    private readonly api: AlphaESSApi,
    private readonly mqttConfig: MqttConfig,
    private readonly pollIntervalMs: number = 60_000,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    const { host, port, username, password } = this.mqttConfig;
    const brokerUrl = `mqtt://${host}:${port}`;

    console.log(`[MQTT] Connecting to ${brokerUrl} as user "${username}"`);

    this.client = mqtt.connect(brokerUrl, {
      username,
      password,
      clientId: `alphaess_battery_${Date.now()}`,
      clean: true,
      reconnectPeriod: 5_000,
      connectTimeout: 30_000,
      will: {
        topic: AVAILABILITY_TOPIC,
        payload: Buffer.from('offline'),
        qos: 1,
        retain: true,
      },
    });

    this.client.on('connect', () => {
      console.log('[MQTT] Connected');
      this.publishAvailability('online');
      this.publishDiscovery();
      this.subscribeCommandTopics();
      this.startStatePolling();
      this.startScheduler();
    });

    this.client.on('reconnect', () => {
      console.log('[MQTT] Reconnecting...');
    });

    this.client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
    });

    this.client.on('message', (topic, payload) => {
      this.handleMessage(topic, payload.toString());
    });
  }

  stop(): void {
    if (this.stateTimer) {
      clearInterval(this.stateTimer);
      this.stateTimer = null;
    }
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (this.client) {
      this.publishAvailability('offline');
      this.client.end();
      this.client = null;
    }
  }

  // -------------------------------------------------------------------------
  // HA Auto-Discovery
  // -------------------------------------------------------------------------

  private publishDiscovery(): void {
    if (!this.client) return;

    const availability = {
      topic: AVAILABILITY_TOPIC,
      payload_available: 'online',
      payload_not_available: 'offline',
    };

    // Select: battery mode (Charge / Discharge / Auto)
    this.publishDiscoveryConfig('select', 'alphaess_battery_mode', {
      name: 'Battery Mode',
      unique_id: 'alphaess_battery_mode',
      command_topic: `${TOPIC_PREFIX}/mode/set`,
      state_topic: `${TOPIC_PREFIX}/mode/state`,
      options: ['Charge', 'Discharge', 'Auto'],
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:battery-sync',
    });

    // Number: charge duration (minutes)
    this.publishDiscoveryConfig('number', 'alphaess_battery_duration', {
      name: 'Mode Duration',
      unique_id: 'alphaess_battery_duration',
      command_topic: `${TOPIC_PREFIX}/duration/set`,
      state_topic: `${TOPIC_PREFIX}/duration/state`,
      min: 15,
      max: 480,
      step: 15,
      unit_of_measurement: 'min',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:timer-outline',
    });

    // Number: target SOC
    this.publishDiscoveryConfig('number', 'alphaess_battery_target_soc', {
      name: 'Target SOC',
      unique_id: 'alphaess_battery_target_soc',
      command_topic: `${TOPIC_PREFIX}/target_soc/set`,
      state_topic: `${TOPIC_PREFIX}/target_soc/state`,
      min: 10,
      max: 100,
      step: 5,
      unit_of_measurement: '%',
      device_class: 'battery',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:battery-arrow-up',
    });

    // Sensor: SOC
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_soc', {
      name: 'State of Charge',
      unique_id: 'alphaess_battery_soc',
      state_topic: `${TOPIC_PREFIX}/soc/state`,
      unit_of_measurement: '%',
      device_class: 'battery',
      state_class: 'measurement',
      device: DEVICE_INFO,
      availability,
    });

    // Sensor: battery power
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_power', {
      name: 'Battery Power',
      unique_id: 'alphaess_battery_power',
      state_topic: `${TOPIC_PREFIX}/battery_power/state`,
      unit_of_measurement: 'W',
      device_class: 'power',
      state_class: 'measurement',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:battery-charging',
    });

    // Sensor: grid power
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_grid_power', {
      name: 'Grid Power',
      unique_id: 'alphaess_battery_grid_power',
      state_topic: `${TOPIC_PREFIX}/grid_power/state`,
      unit_of_measurement: 'W',
      device_class: 'power',
      state_class: 'measurement',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:transmission-tower',
    });

    // Sensor: PV power
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_pv_power', {
      name: 'PV Power',
      unique_id: 'alphaess_battery_pv_power',
      state_topic: `${TOPIC_PREFIX}/pv_power/state`,
      unit_of_measurement: 'W',
      device_class: 'power',
      state_class: 'measurement',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:solar-power',
    });

    // Sensor: load power
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_load_power', {
      name: 'Load Power',
      unique_id: 'alphaess_battery_load_power',
      state_topic: `${TOPIC_PREFIX}/load_power/state`,
      unit_of_measurement: 'W',
      device_class: 'power',
      state_class: 'measurement',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:home-lightning-bolt',
    });

    // Sensor: current mode
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_current_mode', {
      name: 'Current Mode',
      unique_id: 'alphaess_battery_current_mode',
      state_topic: `${TOPIC_PREFIX}/mode/state`,
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:battery-arrow-up',
    });

    // Sensor: last error
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_last_error', {
      name: 'Last Error',
      unique_id: 'alphaess_battery_last_error',
      state_topic: `${TOPIC_PREFIX}/last_error/state`,
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:alert-circle-outline',
    });

    // Sensor: charge config (JSON attributes)
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_charge_config', {
      name: 'Charge Config',
      unique_id: 'alphaess_battery_charge_config',
      state_topic: `${TOPIC_PREFIX}/charge_config/state`,
      json_attributes_topic: `${TOPIC_PREFIX}/charge_config/attributes`,
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:battery-plus',
    });

    // Sensor: discharge config (JSON attributes)
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_discharge_config', {
      name: 'Discharge Config',
      unique_id: 'alphaess_battery_discharge_config',
      state_topic: `${TOPIC_PREFIX}/discharge_config/state`,
      json_attributes_topic: `${TOPIC_PREFIX}/discharge_config/attributes`,
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:battery-minus',
    });

    // Energy sensors (kWh, total_increasing) — for HA Energy Dashboard
    this.publishDiscoveryConfig('sensor', 'alphaess_battery_daily_pv', {
      name: 'Daily PV Generation',
      unique_id: 'alphaess_battery_daily_pv',
      state_topic: `${TOPIC_PREFIX}/daily_pv/state`,
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'total_increasing',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:solar-power-variant',
    });

    this.publishDiscoveryConfig('sensor', 'alphaess_battery_daily_grid_import', {
      name: 'Daily Grid Import',
      unique_id: 'alphaess_battery_daily_grid_import',
      state_topic: `${TOPIC_PREFIX}/daily_grid_import/state`,
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'total_increasing',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:transmission-tower-import',
    });

    this.publishDiscoveryConfig('sensor', 'alphaess_battery_daily_grid_export', {
      name: 'Daily Grid Export',
      unique_id: 'alphaess_battery_daily_grid_export',
      state_topic: `${TOPIC_PREFIX}/daily_grid_export/state`,
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'total_increasing',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:transmission-tower-export',
    });

    this.publishDiscoveryConfig('sensor', 'alphaess_battery_daily_charge', {
      name: 'Daily Battery Charge',
      unique_id: 'alphaess_battery_daily_charge',
      state_topic: `${TOPIC_PREFIX}/daily_charge/state`,
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'total_increasing',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:battery-charging',
    });

    this.publishDiscoveryConfig('sensor', 'alphaess_battery_daily_discharge', {
      name: 'Daily Battery Discharge',
      unique_id: 'alphaess_battery_daily_discharge',
      state_topic: `${TOPIC_PREFIX}/daily_discharge/state`,
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'total_increasing',
      device: DEVICE_INFO,
      availability,
      icon: 'mdi:battery-arrow-down',
    });

    console.log('[MQTT] Discovery configs published');
  }

  private publishDiscoveryConfig(
    component: string,
    objectId: string,
    config: Record<string, unknown>,
  ): void {
    const topic = `${DISCOVERY_PREFIX}/${component}/${objectId}/config`;
    this.client!.publish(topic, JSON.stringify(config), { qos: 1, retain: true });
  }

  // -------------------------------------------------------------------------
  // Command handling
  // -------------------------------------------------------------------------

  private subscribeCommandTopics(): void {
    if (!this.client) return;

    const topics = [
      `${TOPIC_PREFIX}/mode/set`,
      `${TOPIC_PREFIX}/duration/set`,
      `${TOPIC_PREFIX}/target_soc/set`,
    ];

    this.client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        console.error('[MQTT] Subscribe error:', err.message);
      } else {
        console.log('[MQTT] Subscribed to command topics');
      }
    });
  }

  private duration: number = 60;
  private targetSoc: number = 100;

  private handleMessage(topic: string, payload: string): void {
    if (topic === `${TOPIC_PREFIX}/mode/set`) {
      this.handleSetMode(payload as BatteryMode);
    } else if (topic === `${TOPIC_PREFIX}/duration/set`) {
      this.duration = parseInt(payload, 10) || 60;
      this.publish(`${TOPIC_PREFIX}/duration/state`, String(this.duration));
      console.log(`[MQTT] Duration set to ${this.duration} min`);
    } else if (topic === `${TOPIC_PREFIX}/target_soc/set`) {
      this.targetSoc = parseInt(payload, 10) || 100;
      this.publish(`${TOPIC_PREFIX}/target_soc/state`, String(this.targetSoc));
      console.log(`[MQTT] Target SOC set to ${this.targetSoc}%`);
    }
  }

  private async handleSetMode(mode: BatteryMode): Promise<void> {
    if (!['Charge', 'Discharge', 'Auto'].includes(mode)) {
      console.warn(`[MQTT] Unknown mode: "${mode}"`);
      this.setLastError(`Unknown mode: ${mode}`);
      return;
    }

    console.log(`[MQTT] Mode command: ${mode} (duration=${this.duration}min, targetSoc=${this.targetSoc}%)`);

    try {
      switch (mode) {
        case 'Charge':
          await this.api.forceCharge(this.duration, this.targetSoc);
          break;
        case 'Discharge':
          await this.api.forceDischarge(this.duration, 100 - this.targetSoc);
          break;
        case 'Auto':
          await this.api.selfConsumption();
          break;
      }

      this.currentMode = mode;
      this.publish(`${TOPIC_PREFIX}/mode/state`, mode);
      this.setLastError('');
      console.log(`[MQTT] Mode set to ${mode} successfully`);

      // Refresh config state after change
      setTimeout(() => this.publishConfigState(), 5_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MQTT] Mode change failed:`, msg);
      this.setLastError(msg);
    }
  }

  // -------------------------------------------------------------------------
  // State publishing
  // -------------------------------------------------------------------------

  private startStatePolling(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);

    // Publish immediately
    this.publishState();
    this.publishConfigState();

    // Publish initial settings
    this.publish(`${TOPIC_PREFIX}/duration/state`, String(this.duration));
    this.publish(`${TOPIC_PREFIX}/target_soc/state`, String(this.targetSoc));

    this.stateTimer = setInterval(() => {
      this.publishState();
    }, this.pollIntervalMs);
  }

  private async publishState(): Promise<void> {
    if (!this.client) return;

    try {
      const power = await this.api.getPowerData();

      this.publish(`${TOPIC_PREFIX}/soc/state`, String(Math.round(power.soc)));
      this.publish(`${TOPIC_PREFIX}/battery_power/state`, String(Math.round(power.batteryPower)));
      this.publish(`${TOPIC_PREFIX}/grid_power/state`, String(Math.round(power.gridPower)));
      this.publish(`${TOPIC_PREFIX}/pv_power/state`, String(Math.round(power.pvPower)));
      this.publish(`${TOPIC_PREFIX}/load_power/state`, String(Math.round(power.loadPower)));

      // Derive mode from config state
      this.publish(`${TOPIC_PREFIX}/mode/state`, this.currentMode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[MQTT] Failed to get power data:', msg);
      this.setLastError(msg);
    }

    // Energy data (daily kWh) — less frequent, OK to poll every cycle
    try {
      const energy = await this.api.getDailyEnergy();
      this.publish(`${TOPIC_PREFIX}/daily_pv/state`, String(energy.pvGeneration));
      this.publish(`${TOPIC_PREFIX}/daily_grid_import/state`, String(energy.gridImport));
      this.publish(`${TOPIC_PREFIX}/daily_grid_export/state`, String(energy.gridExport));
      this.publish(`${TOPIC_PREFIX}/daily_charge/state`, String(energy.batteryCharge));
      this.publish(`${TOPIC_PREFIX}/daily_discharge/state`, String(energy.batteryDischarge));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[MQTT] Failed to get energy data:', msg);
    }
  }

  private async publishConfigState(): Promise<void> {
    if (!this.client) return;

    try {
      const charge = await this.api.getChargeConfig();
      const discharge = await this.api.getDischargeConfig();

      // Determine actual mode from config
      if (charge.gridCharge && charge.timeChaf1 !== '00:00') {
        this.currentMode = 'Charge';
      } else if (discharge.ctrDis && discharge.timeDisf1 !== '00:00') {
        this.currentMode = 'Discharge';
      } else {
        this.currentMode = 'Auto';
      }

      this.publish(`${TOPIC_PREFIX}/mode/state`, this.currentMode);
      this.publish(`${TOPIC_PREFIX}/charge_config/state`, charge.gridCharge ? 'Enabled' : 'Disabled');
      this.publish(`${TOPIC_PREFIX}/charge_config/attributes`, JSON.stringify(charge));
      this.publish(`${TOPIC_PREFIX}/discharge_config/state`, discharge.ctrDis ? 'Enabled' : 'Disabled');
      this.publish(`${TOPIC_PREFIX}/discharge_config/attributes`, JSON.stringify(discharge));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[MQTT] Failed to get config:', msg);
    }
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  private startScheduler(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = setInterval(() => this.checkSchedule(), 30_000);
    // Run immediately too
    this.checkSchedule();
    console.log('[MQTT] Scheduler started — entries:', this.schedule.map(s => s.label).join(', '));
  }

  private async checkSchedule(): Promise<void> {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const entry of this.schedule) {
      const entryTime = `${String(entry.hour).padStart(2, '0')}:${String(entry.minute).padStart(2, '0')}`;
      if (hhmm === entryTime && this.lastScheduleRun !== entryTime) {
        this.lastScheduleRun = entryTime;
        console.log(`[SCHEDULER] Triggering: ${entry.label}`);
        try {
          await entry.action();
          console.log(`[SCHEDULER] ${entry.label} — success`);
          // Update mode state
          if (entry.label.includes('Start charge')) {
            this.currentMode = 'Charge';
          } else {
            this.currentMode = 'Auto';
          }
          this.publish(`${TOPIC_PREFIX}/mode/state`, this.currentMode);
          this.setLastError('');
          // Refresh config after change
          setTimeout(() => this.publishConfigState(), 5_000);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[SCHEDULER] ${entry.label} — FAILED:`, msg);
          this.setLastError(`Scheduler: ${entry.label} failed — ${msg}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private publish(topic: string, payload: string): void {
    this.client?.publish(topic, payload, { qos: 0, retain: true });
  }

  private setLastError(error: string): void {
    if (error) {
      const timestamp = new Date().toISOString();
      this.lastError = `[${timestamp}] ${error}`;
    } else {
      this.lastError = '';
    }
    this.publish(`${TOPIC_PREFIX}/last_error/state`, this.lastError);
  }

  private publishAvailability(status: 'online' | 'offline'): void {
    if (!this.client) return;
    this.client.publish(AVAILABILITY_TOPIC, status, { qos: 1, retain: true });
  }
}
