#!/usr/bin/env node
"use strict";

const { FramedProtocol, MSG, hexBytes, decodeTelemetrySummary } = require("./robot_interface");
require('dotenv').config({ path: '../.env' });

let socketNamespace = null;
let monitorInstance = null;

function setSocketNamespace(namespace) {
  socketNamespace = namespace;
  if (monitorInstance) {
    monitorInstance.setSocketNamespace(namespace);
  }
}

class SerialMonitor {
  #port;
  #baudrate;
  #raw;
  #seq;
  #protocol;
  #telemetryCount;
  #telemetryFirstTime;
  #telemetryLastTime;
  #serial;
  #reconnectTimer;
  #reconnectDelayMs;
  #isStopping;
  #socketNamespace;
  constructor(port, baudrate, raw) {
    this.#port = port;
    this.#baudrate = baudrate;
    this.#raw = raw;
    this.#seq = 0;
    this.#protocol = new FramedProtocol();
    this.#telemetryCount = 0;
    this.#telemetryFirstTime = null;
    this.#telemetryLastTime = null;
    this.#serial = null;
    this.#reconnectTimer = null;
    this.#reconnectDelayMs = 2000;
    this.#isStopping = false;
    this.#socketNamespace = socketNamespace;
  }

  nextSeq() {
    return this.#protocol.nextSeq();
  }

  send(msgType, payload) {
    const seq = this.nextSeq();
    const frame = this.#protocol.buildFrame(msgType, seq, payload);
    this.#serial.write(frame);
    const name = this.#protocol.getTypeName(msgType);
    console.log(`[TX] ${name} seq=${seq} payload=${hexBytes(payload)}`);
  }

  setSocketNamespace(namespace) {
    this.#socketNamespace = namespace;
  }

  emitRobotMessage(frame) {
    if (!this.#socketNamespace) return;

    const telemetry = frame.msgType === MSG.TELEMETRY ? decodeTelemetrySummary(frame.payload) : null;

    const payload = {
      msgType: frame.msgType,
      msgName: this.#protocol.getTypeName(frame.msgType),
      seq: frame.seq,
      decoded: this.#protocol.decodeFrame(frame),
      rawPayload: frame.payload.toString("hex"),
      telemetry,
    };

    this.#socketNamespace.emit("robot_msg", payload);
  }

  clearReconnectTimer() {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.#isStopping || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.open().catch((err) => {
        console.error(`[SERIAL] Reconnect failed: ${err.message}`);
        this.scheduleReconnect();
      });
    }, this.#reconnectDelayMs);
  }

  attachSerialHandlers() {
    if (!this.#serial) return;

    this.#serial.on("data", (data) => {
      if (this.#raw) {
        console.log(`[RAW] ${hexBytes(data, 128)}`);
      }
      for (const frame of this.#protocol.feed(data)) {
        if (frame.msgType === MSG.TELEMETRY) {
          const now = process.hrtime.bigint();
          if (this.#telemetryFirstTime === null) this.#telemetryFirstTime = now;
          this.#telemetryLastTime = now;
          this.#telemetryCount += 1;
        }
        // const decoded = this.#protocol.decodeFrame(frame);
        // console.log(decoded);
        this.emitRobotMessage(frame);
      }
    });

    this.#serial.on("error", (err) => {
      console.error(`[SERIAL] Connection error: ${err.message}`);
      this.scheduleReconnect();
    });

    this.#serial.on("close", () => {
      if (!this.#isStopping) {
        console.warn("[SERIAL] Port closed; attempting to reconnect...");
        this.scheduleReconnect();
      }
    });
  }

  async open() {
    if (this.#isStopping) return;

    this.clearReconnectTimer();

    if (!this.#port) {
      console.error("[SERIAL] No serial port configured. Set USB_PORT to a valid COM/tty device.");
      // this.scheduleReconnect();
      return;
    }

    let SerialPort;
    try {
      ({ SerialPort } = require("serialport"));
    } catch {
      console.error("[SERIAL] Missing npm package 'serialport'. Install it with: npm install serialport");
      this.scheduleReconnect();
      return;
    }

    try {
      this.#serial = new SerialPort({
        path: this.#port,
        baudRate: this.#baudrate,
        autoOpen: this.#raw,
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`[SERIAL] Failed to initialize serial port ${this.#port}: ${message}`);
      this.#serial = null;
      this.scheduleReconnect();
      return;
    }

    this.attachSerialHandlers();

    try {
      await new Promise((resolve, reject) => {
        this.#serial.open((err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      // console.error(`[SERIAL] Failed to connect to ${this.#port} @ ${this.#baudrate}: ${err}`);
      this.#serial = null;
      this.scheduleReconnect();
      return;
    }

    this.#serial.set({ dtr: true, rts: true }, () => { });
    console.log(`[SERIAL] Connected to ${this.#port} @ ${this.#baudrate}`);
  }

  close() {
    this.#isStopping = true;
    this.clearReconnectTimer();
    if (this.#serial && this.#serial.isOpen) {
      this.#serial.close();
    }
  }

  telemetryRateReport() {
    if (this.#telemetryCount === 0) {
      return "[STATS] Telemetry frames=0 rate=0.00 Hz";
    }
    if (this.#telemetryCount === 1 || this.#telemetryFirstTime === this.#telemetryLastTime) {
      return "[STATS] Telemetry frames=1 rate=n/a";
    }
    const durationSec = Number(this.#telemetryLastTime - this.#telemetryFirstTime) / 1e9;
    const rate = (this.#telemetryCount - 1) / durationSec;
    const periodMs = 1000 / rate;
    return (
      `[STATS] Telemetry frames=${this.#telemetryCount} ` +
      `duration=${durationSec.toFixed(2)}s rate=${rate.toFixed(2)} Hz period=${periodMs.toFixed(1)} ms`
    );
  }
}

function initMonitor(options = {}) {
  if (monitorInstance) return monitorInstance;

  const port = options.port ?? process.env.USB_PORT;
  const baudrate = Number(options.baudrate ?? process.env.USB_BAUDRATE);
  const raw = Boolean(options.raw);

  monitorInstance = new SerialMonitor(port, baudrate, raw);
  if (options.socketNamespace) {
    monitorInstance.setSocketNamespace(options.socketNamespace);
  }

  monitorInstance.open().catch((err) => {
    console.error(`[SERIAL] ${err.message}`);
  });

  return monitorInstance;
}

async function main() {
  const monitor = initMonitor();
  await monitor.open();

  console.log("[SERIAL] Listening. Press Ctrl+C to stop.");
  process.on("SIGINT", () => {
    console.log("\n[SERIAL] Stopped");
    monitor.close();
    console.log(monitor.telemetryRateReport());
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[SERIAL] ${err.message}`);
  });
}

module.exports = {
  SerialMonitor,
  initMonitor,
  setSocketNamespace,
};
