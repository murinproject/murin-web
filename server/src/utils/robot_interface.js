"use strict";

const SOF = 0xaa;
const ESCAPE = 0x1b;
const ESCAPE_XOR = 0x20;

const MSG = Object.freeze({
  HEARTBEAT: 0x00,
  CMD_MOTOR: 0x01,
  CMD_SERVO: 0x02,
  TELEMETRY: 0x03,
  CMD_CONFIG: 0x10,
  ACK: 0x7e,
  NACK: 0x7f,
});

const CFG_TELEM_ENABLE = 1;
const CFG_TELEM_RATE_MS = 2;
const CFG_TELEM_MASK = 3;
const CFG_TELEM_TIMEOUT_MS = 4;

const TYPE_NAMES = new Map([
  [MSG.HEARTBEAT, "HEARTBEAT"],
  [MSG.CMD_MOTOR, "CMD_MOTOR"],
  [MSG.CMD_SERVO, "CMD_SERVO"],
  [MSG.TELEMETRY, "TELEMETRY"],
  [MSG.CMD_CONFIG, "CMD_CONFIG"],
  [MSG.ACK, "ACK"],
  [MSG.NACK, "NACK"],
]);

const ERR_NAMES = new Map([
  [0x00, "OK"],
  [0x01, "ERR_CRC"],
  [0x02, "ERR_LEN"],
  [0x03, "ERR_TYPE"],
  [0x04, "ERR_CFG"],
  [0x05, "ERR_RANGE"],
]);

const CONFIG_KEY_NAMES = new Map([
  [CFG_TELEM_ENABLE, "TELEM_ENABLE"],
  [CFG_TELEM_RATE_MS, "TELEM_RATE_MS"],
  [CFG_TELEM_MASK, "TELEM_MASK"],
  [CFG_TELEM_TIMEOUT_MS, "TELEM_TIMEOUT_MS"],
]);

function hex16(value) {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function hexBytes(data, maxLen = 32) {
  if (!data || data.length === 0) return "-";
  const shown = data.subarray(0, maxLen).toString("hex").match(/.{1,2}/g).join(" ");
  if (data.length > maxLen) {
    return `${shown} ... +${data.length - maxLen} bytes`;
  }
  return shown;
}

function maybeDecodeText(payload) {
  const text = payload.toString("utf8");
  if (Buffer.from(text, "utf8").compare(payload) !== 0) return null;
  const stripped = text.trim();
  if (!stripped) return null;
  if (stripped[0] === "{" || stripped[0] === "[") {
    try {
      return `json=${JSON.stringify(JSON.parse(stripped))}`;
    } catch {
      return `text=${JSON.stringify(stripped)}`;
    }
  }
  if ([...stripped].every((ch) => ch >= " " || /\s/.test(ch))) {
    return `text=${JSON.stringify(stripped)}`;
  }
  return null;
}

function decodeTelemetry(payload) {
  if (payload.length !== 26) {
    return `bad_len=${payload.length} raw=${hexBytes(payload)}`;
  }

  const valid = payload.readUInt8(0);
  const err = payload.readUInt8(1);
  const timestamp = payload.readUInt32LE(2);
  const voltage = payload.readFloatLE(6);
  const current = payload.readFloatLE(10);
  const power = payload.readFloatLE(14);
  const energy = payload.readFloatLE(18);
  const voltageRaw = payload.readUInt16LE(22);
  const currentRaw = payload.readUInt16LE(24);
  const status = valid ? "OK" : "NG";

  return (
    `${status} err=${err} ${timestamp}ms ` +
    `${voltage.toFixed(3)}V ${current.toFixed(3)}A ` +
    `${power.toFixed(3)}W ${energy.toFixed(3)}Wh `
  );
}

function decodeTelemetrySummary(payload) {
  if (!payload || payload.length !== 26) {
    return null;
  }

  const voltage = payload.readFloatLE(6);
  const current = payload.readFloatLE(10);
  const power = payload.readFloatLE(14);
  const energy = payload.readFloatLE(18);
  const valid = payload.readUInt8(0);

  return {
    valid,
    voltage: Number(voltage.toFixed(3)),
    current: Number(current.toFixed(3)),
    power: Number(power.toFixed(3)),
    energy: Number(energy.toFixed(3)),
  };
}

function crc16(data) {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function stuff(payload) {
  const out = [];
  for (const byte of payload) {
    if (byte === SOF || byte === ESCAPE) {
      out.push(ESCAPE, byte ^ ESCAPE_XOR);
    } else {
      out.push(byte);
    }
  }
  return Buffer.from(out);
}

function unstuff(payload) {
  const out = [];
  for (let i = 0; i < payload.length; i++) {
    let value = payload[i];
    if (value === ESCAPE && i + 1 < payload.length) {
      i += 1;
      value = payload[i] ^ ESCAPE_XOR;
    }
    out.push(value);
  }
  return Buffer.from(out);
}

class FramedProtocol {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.seq = 0;
  }

  nextSeq() {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return seq;
  }

  buildFrame(msgType, seq, payload = Buffer.alloc(0)) {
    const stuffed = stuff(payload);
    const header = Buffer.alloc(4);
    header.writeUInt8(msgType, 0);
    header.writeUInt8(seq, 1);
    header.writeUInt16LE(stuffed.length, 2);

    const crc = crc16(Buffer.concat([header, stuffed]));
    const frame = Buffer.alloc(1 + header.length + stuffed.length + 2);
    frame.writeUInt8(SOF, 0);
    header.copy(frame, 1);
    stuffed.copy(frame, 5);
    frame.writeUInt16LE(crc, 5 + stuffed.length);
    return frame;
  }

  encodeMotor(leftPwm, rightPwm) {
    const payload = Buffer.alloc(4);
    payload.writeInt16LE(leftPwm, 0);
    payload.writeInt16LE(rightPwm, 2);
    return payload;
  }

  encodeServo(channel, pulseUs) {
    const payload = Buffer.alloc(3);
    payload.writeUInt8(channel, 0);
    payload.writeUInt16LE(pulseUs, 1);
    return payload;
  }

  encodeConfig(key, value) {
    const payload = Buffer.alloc(5);
    payload.writeUInt8(key, 0);
    payload.writeInt32LE(value, 1);
    return payload;
  }

  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames = [];

    while (true) {
      const start = this.buffer.indexOf(SOF);
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) {
        this.buffer = this.buffer.subarray(start);
      }
      if (this.buffer.length < 7) break;

      const msgType = this.buffer.readUInt8(1);
      const seq = this.buffer.readUInt8(2);
      const length = this.buffer.readUInt16LE(3);
      const total = 1 + 1 + 1 + 2 + length + 2;
      if (this.buffer.length < total) break;

      const rawPayload = this.buffer.subarray(5, 5 + length);
      const rawCrc = this.buffer.readUInt16LE(5 + length);
      const computed = crc16(this.buffer.subarray(1, 5 + length));
      this.buffer = this.buffer.subarray(total);

      if (computed !== rawCrc) {
        console.log(`  [CRC FAIL] expected 0x${hex16(computed)} got 0x${hex16(rawCrc)}`);
        continue;
      }

      frames.push({ msgType, seq, payload: unstuff(rawPayload) });
    }

    return frames;
  }

  getTypeName(msgType) {
    return TYPE_NAMES.get(msgType) || `0x${msgType.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  decodeFrame({ msgType, seq, payload }) {
    const name = this.getTypeName(msgType);

    if (msgType === MSG.TELEMETRY) {
      return `[RX] ${name} seq=${seq} ${decodeTelemetry(payload)}`;
    }
    if (msgType === MSG.ACK) {
      const ackSeq = payload.length >= 1 ? payload.readUInt8(0) : "missing";
      return `[RX] ${name} seq=${seq} ack=${ackSeq} raw=${hexBytes(payload)}`;
    }
    if (msgType === MSG.NACK) {
      const nackSeq = payload.length >= 1 ? payload.readUInt8(0) : "missing";
      const err = payload.length >= 2 ? payload.readUInt8(1) : null;
      const errName = err === null ? "missing" : ERR_NAMES.get(err) || `0x${err.toString(16).toUpperCase().padStart(2, "0")}`;
      return `[RX] ${name} seq=${seq} nack=${nackSeq} err=${errName} raw=${hexBytes(payload)}`;
    }
    if (msgType === MSG.HEARTBEAT) {
      return `[RX] ${name} seq=${seq}`;
    }
    if (msgType === MSG.CMD_MOTOR && payload.length === 4) {
      return `[RX] ${name} seq=${seq} left=${payload.readInt16LE(0)} right=${payload.readInt16LE(2)}`;
    }
    if (msgType === MSG.CMD_SERVO && payload.length === 3) {
      return `[RX] ${name} seq=${seq} channel=${payload.readUInt8(0)} pulse=${payload.readUInt16LE(1)}`;
    }
    if (msgType === MSG.CMD_CONFIG && payload.length === 5) {
      const key = payload.readUInt8(0);
      const value = payload.readInt32LE(1);
      const keyName = CONFIG_KEY_NAMES.get(key) || `0x${key.toString(16).toUpperCase().padStart(2, "0")}`;
      return `[RX] ${name} seq=${seq} key=${keyName}(${key}) value=${value}`;
    }

    const decodedText = maybeDecodeText(payload);
    if (decodedText) {
      return `[RX] ${name} seq=${seq} len=${payload.length} ${decodedText}`;
    }
    return `[RX] ${name} seq=${seq} len=${payload.length} raw=${hexBytes(payload)}`;
  }
}

module.exports = {
  FramedProtocol,
  SOF,
  ESCAPE,
  ESCAPE_XOR,
  MSG,
  hexBytes,
  decodeTelemetry,
  decodeTelemetrySummary,
};
