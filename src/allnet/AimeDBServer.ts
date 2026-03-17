import * as crypto from 'crypto';
import * as net from 'net';

import {CONFIG} from '../utils/ArgConfig';
import {FindOrCreateCardProfile, FindProfileByAccessCode, FindProfileByFeliCa, RegisterFeliCa} from '../utils/EamuseIO';
import {Logger} from '../utils/Logger';

const AIMEDB_KEY = Buffer.from('Copyright(C)SEGA');

const CMD_FELICA_LOOKUP = 0x01;
const CMD_FELICA_REGISTER = 0x02;
const CMD_FELICA_RESP = 0x03;

const CMD_LOOKUP = 0x04;
const CMD_REGISTER = 0x05;
const CMD_LOOKUP_RESP = 0x06;

const CMD_STATUS_LOG = 0x07;
const CMD_STATUS_LOG_RESP = 0x08;

const CMD_AIME_LOG = 0x09;
const CMD_AIME_LOG_RESP = 0x0A;

const CMD_CAMPAIGN = 0x0B;
const CMD_CAMPAIGN_RESP = 0x0C;

const CMD_CAMPAIGN_CLEAR = 0x0D;
const CMD_CAMPAIGN_CLEAR_RESP = 0x0E;

const CMD_LOOKUP_EX = 0x0F;
const CMD_LOOKUP_EX_RESP = 0x10;

const CMD_FELICA_LOOKUP_EX = 0x11;
const CMD_FELICA_LOOKUP_EX_RESP = 0x12;

const CMD_AIME_LOG_EX = 0x13;
const CMD_AIME_LOG_EX_RESP = 0x14;

const CMD_HELLO = 0x64;
const CMD_HELLO_RESP = 0x65;
const CMD_GOODBYE = 0x66;

const STATUS_OK = 1;
const STATUS_BAN_SYS_USER = 4;
const STATUS_BAN_SYS = 5;
const STATUS_BAN_USER = 6;
const STATUS_LOCK_SYS_USER = 8;
const STATUS_LOCK_SYS = 9;
const STATUS_LOCK_USER = 10;

const HDR_MAGIC = 0;
const HDR_PROTO_VER = 2;
const HDR_CMD = 4;
const HDR_LENGTH = 6;
const HDR_STATUS = 8;
const HDR_GAME_ID = 10;
const HDR_STORE_ID = 16;
const HDR_KEYCHIP = 20;
const HDR_SIZE = 32;

const PROTO_VER_NEW_CAMPAIGN = 0x3030;

const DATA_START = HDR_SIZE;
const DEFAULT_PORT = 22345;

// Access codes in the aimedb packet are 10 raw bytes that represent the
// 20-digit decimal access code directly — byte 0x01 0x23 = digits "01" "23".
// Buffer.toString('hex') on those bytes gives us the 20-digit decimal string
// directly, which is exactly how we store it. No further conversion needed.
//
// For FeliCa responses we need to PUT the access code BACK as those same
// 10 bytes — so we encode the 20-char decimal string back to 10 bytes by
// treating each pair of decimal digits as a hex byte (which happens to give
// the right value because digits 0-9 map identically in hex).
function accessCodeToBytes(ac: string): Buffer {
  // ac is a 20-digit decimal string e.g. "01234567890123456789"
  // pack as 10 bytes: buf[0]=0x01, buf[1]=0x23, etc.
  return Buffer.from(ac.padStart(20, '0'), 'hex');
}

export class AimeDBServer {
  private server: net.Server;
  private port: number = DEFAULT_PORT;

  constructor() {
    this.server = net.createServer(s => this.handleConnection(s));
  }

  public getPort(): number {
    return this.port;
  }

  public start(port?: number) {
    if (port) this.port = port;
    this.server.listen(
        this.port, '0.0.0.0',
        () => Logger.info(`[AimeDB] Listening on 0.0.0.0:${this.port}`));
  }

  private decrypt(data: Buffer): Buffer {
    const d = crypto.createDecipheriv('aes-128-ecb', AIMEDB_KEY, null);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(data), d.final()]);
  }

  private encrypt(data: Buffer): Buffer {
    const padLen = (16 - (data.length % 16)) % 16;
    const padded =
        padLen > 0 ? Buffer.concat([data, Buffer.alloc(padLen, 0)]) : data;
    const e = crypto.createCipheriv('aes-128-ecb', AIMEDB_KEY, null);
    e.setAutoPadding(false);
    return Buffer.concat([e.update(padded), e.final()]);
  }

  private async handleConnection(socket: net.Socket) {
    let buf = Buffer.alloc(0);

    socket.on('data', async chunk => {
      buf = Buffer.concat([buf, chunk]);

      while (buf.length >= HDR_SIZE) {
        const hdr = this.decrypt(buf.slice(0, HDR_SIZE));
        const magic = hdr.readUInt16LE(HDR_MAGIC);

        if (magic !== 0xa13e) {
          buf = buf.slice(1);
          continue;
        }

        const pktLen = hdr.readUInt16LE(HDR_LENGTH);
        const padded = Math.ceil(pktLen / 16) * 16;

        if (buf.length < padded) break;

        const pkt = this.decrypt(buf.slice(0, padded));
        buf = buf.slice(padded);

        try {
          const resp = await this.dispatch(pkt);
          if (resp === null) {
            socket.end();
          } else if (resp) {
            const enc = this.encrypt(resp);
            Logger.info(`[AimeDB] Sending ${enc.length} bytes for cmd=0x${
                pkt.readUInt16LE(HDR_CMD).toString(16)} resp_cmd=0x${
                resp.readUInt16LE(HDR_CMD).toString(16)}`);
            socket.write(enc);
          }
        } catch (err) {
          Logger.error(`[AimeDB] Handler error cmd=0x${
              pkt.readUInt16LE(HDR_CMD).toString(
                  16)}: ${err.message}\n${err.stack}`);
        }
      }
    });

    socket.on('error', err => {
      if (!err.message.includes('ECONNRESET'))
        Logger.error(`[AimeDB] Socket error: ${err.message}`);
    });
  }

  private async dispatch(pkt: Buffer): Promise<Buffer|null|undefined> {
    const cmd = pkt.readUInt16LE(HDR_CMD);
    const gameId =
        pkt.toString('ascii', HDR_GAME_ID, HDR_GAME_ID + 6).replace(/\0/g, '');
    const keychip =
        pkt.toString('ascii', HDR_KEYCHIP, HDR_KEYCHIP + 12).replace(/\0/g, '');

    Logger.info(`[AimeDB] cmd=0x${cmd.toString(16).padStart(2, '0')} game=${
        gameId} keychip=${keychip}`);

    switch (cmd) {
      case CMD_FELICA_LOOKUP:
        return this.handleFeliCaLookup(pkt, gameId);
      case CMD_FELICA_REGISTER:
        return this.handleFeliCaRegister(pkt, gameId);
      case CMD_LOOKUP:
        return this.handleLookup(pkt, gameId);
      case CMD_REGISTER:
        return this.handleRegister(pkt, gameId);
      case CMD_STATUS_LOG:
        return this.handleStatusLog(pkt);
      case CMD_AIME_LOG:
        return this.handleAimeLog(pkt);
      case CMD_CAMPAIGN:
        return this.handleCampaign(pkt);
      case CMD_CAMPAIGN_CLEAR:
        return this.handleCampaignClear(pkt);
      case CMD_LOOKUP_EX:
        return this.handleLookupEx(pkt, gameId);
      case CMD_FELICA_LOOKUP_EX:
        return this.handleFeliCaLookupEx(pkt, gameId);
      case CMD_AIME_LOG_EX:
        return this.handleAimeLogEx(pkt);
      case CMD_HELLO:
        Logger.info('[AimeDB] Hello');
        return this.makeHeader(pkt, CMD_HELLO_RESP, HDR_SIZE);
      case CMD_GOODBYE:
        Logger.info('[AimeDB] Goodbye');
        return null;
      default:
        // artemis sends no response for unregistered commands
        Logger.warn(
            `[AimeDB] Unhandled cmd=0x${cmd.toString(16)} — no response sent`);
        return undefined;
    }
  }

  private makeHeader(
      req: Buffer, respCmd: number, totalLength: number,
      status: number = STATUS_OK): Buffer {
    const h = Buffer.alloc(HDR_SIZE, 0);
    h.writeUInt16LE(0xa13e, HDR_MAGIC);
    h.writeUInt16LE(req.readUInt16LE(HDR_PROTO_VER), HDR_PROTO_VER);
    h.writeUInt16LE(respCmd, HDR_CMD);
    h.writeUInt16LE(totalLength, HDR_LENGTH);
    h.writeUInt16LE(status, HDR_STATUS);
    req.copy(h, HDR_GAME_ID, HDR_GAME_ID, HDR_GAME_ID + 6);
    req.copy(h, HDR_STORE_ID, HDR_STORE_ID, HDR_STORE_ID + 4);
    req.copy(h, HDR_KEYCHIP, HDR_KEYCHIP, HDR_KEYCHIP + 12);
    return h;
  }

  private makePacket(
      req: Buffer, respCmd: number, payload: Buffer,
      status: number = STATUS_OK): Buffer {
    const total = HDR_SIZE + payload.length;
    const header = this.makeHeader(req, respCmd, total, status);
    return Buffer.concat([header, payload]);
  }

  // ── FeliCa lookup (cmd 0x01) ─────────────────────────────────────────────
  // Request @ DATA_START: IDm(8 BE) + PMm(8 BE)

  private async handleFeliCaLookup(pkt: Buffer, gameId: string):
      Promise<Buffer> {
    const idmHex = pkt.slice(DATA_START, DATA_START + 8)
                       .readBigUInt64BE(0)
                       .toString(16)
                       .toUpperCase()
                       .padStart(16, '0');

    Logger.info(`[AimeDB] FeliCaLookup IDm=${idmHex}`);

    if (idmHex === '0000000000000000') {
      Logger.warn('[AimeDB] FeliCaLookup: all-zero IDm rejected');
      return this.makeFeliCaLookupResponse(pkt, null, STATUS_BAN_SYS);
    }

    const result = await FindProfileByFeliCa(idmHex);
    Logger.info(`[AimeDB] FeliCaLookup IDm=${idmHex} → ${
        result ? result.accessCode : 'not found'}`);
    return this.makeFeliCaLookupResponse(
        pkt, result ? result.accessCode : null);
  }

  private async handleFeliCaRegister(pkt: Buffer, gameId: string):
      Promise<Buffer> {
    const idmHex = pkt.slice(DATA_START, DATA_START + 8)
                       .readBigUInt64BE(0)
                       .toString(16)
                       .toUpperCase()
                       .padStart(16, '0');

    Logger.info(`[AimeDB] FeliCaRegister IDm=${idmHex}`);

    if (idmHex === '0000000000000000') {
      Logger.warn('[AimeDB] FeliCaRegister: all-zero IDm rejected');
      return this.makeFeliCaLookupResponse(pkt, null, STATUS_BAN_SYS);
    }

    if (!CONFIG.allow_register) {
      Logger.warn('[AimeDB] FeliCaRegister: registration disabled');
      return this.makeFeliCaLookupResponse(pkt, null, STATUS_BAN_SYS);
    }

    const result = await RegisterFeliCa(idmHex, gameId || 'SDHD');
    Logger.info(`[AimeDB] FeliCaRegister IDm=${idmHex} → ${
        result ? result.accessCode : 'failed'}`);
    return this.makeFeliCaLookupResponse(
        pkt, result ? result.accessCode : null);
  }

  // Response: felica_idx(u32) + access_code(u8×10) + Padding(2) = 16 bytes
  private makeFeliCaLookupResponse(
      pkt: Buffer, accessCode: string|null,
      status: number = STATUS_OK): Buffer {
    const payload = Buffer.alloc(16, 0);

    if (!accessCode) {
      payload.writeUInt32LE(0xFFFFFFFF, 0);
      // access_code bytes stay zero
    } else {
      payload.writeUInt32LE(0, 0);
      // pack the 20-digit decimal access code back into 10 bytes
      accessCodeToBytes(accessCode).copy(payload, 4, 0, 10);
    }
    // 2 bytes padding at offset 14 already zero

    return this.makePacket(pkt, CMD_FELICA_RESP, payload, status);
  }

  // ── AiMe card lookup (cmd 0x04) ──────────────────────────────────────────
  // Request @ DATA_START: access_code(10) + company_code(i8) + fw_ver(i8) +
  // serial(u32) Response: user_id(i32) + portal_reg(i8) + Padding(11) = 16
  // bytes

  private async handleLookup(pkt: Buffer, gameId: string): Promise<Buffer> {
    // access code is 10 bytes; toString('hex') gives 20 hex chars = 20 decimal
    // digits
    const accessCodeHex =
        pkt.slice(DATA_START, DATA_START + 10).toString('hex').toUpperCase();

    if (accessCodeHex === '00000000000000000000') {
      Logger.warn('[AimeDB] Lookup: all-zero access code rejected');
      return this.makeLookupResponse(pkt, null, STATUS_BAN_SYS);
    }

    Logger.info(`[AimeDB] Lookup accessCode=${accessCodeHex}`);
    const result = await FindProfileByAccessCode(accessCodeHex);
    Logger.info(`[AimeDB] Lookup: ${
        result ? `found aimeId=${result.aimeId}` : 'not found'}`);
    return this.makeLookupResponse(pkt, result ? result.aimeId : null);
  }

  private async handleRegister(pkt: Buffer, gameId: string): Promise<Buffer> {
    const accessCodeHex =
        pkt.slice(DATA_START, DATA_START + 10).toString('hex').toUpperCase();
    const serialNumber =
        pkt.length >= DATA_START + 16 ? pkt.readUInt32LE(DATA_START + 12) : 0;

    if (accessCodeHex === '00000000000000000000') {
      Logger.warn('[AimeDB] Register: all-zero access code rejected');
      return this.makeLookupResponse(pkt, null, STATUS_BAN_SYS);
    }

    Logger.info(`[AimeDB] Register accessCode=${accessCodeHex} serial=0x${
        serialNumber.toString(16)}`);

    if (!CONFIG.allow_register) {
      Logger.warn('[AimeDB] Register: registration disabled');
      return this.makeLookupResponse(pkt, null, STATUS_BAN_SYS);
    }

    const result =
        await FindOrCreateCardProfile(accessCodeHex, gameId || 'SDHD');
    Logger.info(`[AimeDB] Register: ${
        result ?
            `${result.isNew ? 'created' : 'existing'} aimeId=${result.aimeId}` :
            'failed'}`);
    return this.makeLookupResponse(pkt, result ? result.aimeId : null);
  }

  private makeLookupResponse(
      pkt: Buffer, aimeId: number|null, status: number = STATUS_OK): Buffer {
    const payload = Buffer.alloc(16, 0);
    payload.writeInt32LE(aimeId !== null && aimeId >= 0 ? aimeId : -1, 0);
    payload.writeInt8(0, 4);  // portal_reg = NO_REG
    // 11 bytes padding at offset 5..15 already zero
    return this.makePacket(pkt, CMD_LOOKUP_RESP, payload, status);
  }

  // ── Extended lookup (cmd 0x0F) ───────────────────────────────────────────
  // Response: user_id(i32) + portal_reg(i8) + Padding(3) + auth_key(256) +
  // relation1(i32) + relation2(i32) = 272 bytes

  private async handleLookupEx(pkt: Buffer, gameId: string): Promise<Buffer> {
    const accessCodeHex =
        pkt.slice(DATA_START, DATA_START + 10).toString('hex').toUpperCase();

    if (accessCodeHex === '00000000000000000000') {
      Logger.warn('[AimeDB] LookupEx: all-zero access code rejected');
      return this.makeLookupExResponse(pkt, null, STATUS_BAN_SYS);
    }

    Logger.info(`[AimeDB] LookupEx accessCode=${accessCodeHex}`);
    const result = await FindProfileByAccessCode(accessCodeHex);
    Logger.info(`[AimeDB] LookupEx: ${
        result ? `found aimeId=${result.aimeId}` : 'not found'}`);
    return this.makeLookupExResponse(pkt, result ? result.aimeId : null);
  }

  private makeLookupExResponse(
      pkt: Buffer, aimeId: number|null, status: number = STATUS_OK): Buffer {
    const payload = Buffer.alloc(272, 0);
    payload.writeInt32LE(aimeId !== null && aimeId >= 0 ? aimeId : -1, 0);
    payload.writeInt8(0, 4);  // portal_reg = NO_REG
    // 3 bytes padding at 5..7 zero
    // auth_key 256 bytes at 8..263 zero (no signing)
    payload.writeInt32LE(-1, 264);  // relation1 unsupported
    payload.writeInt32LE(-1, 268);  // relation2 unsupported
    return this.makePacket(pkt, CMD_LOOKUP_EX_RESP, payload, status);
  }

  // ── FeliCa lookup EX (cmd 0x11) ──────────────────────────────────────────
  // Request: RC(16) @ DATA_START, IDm+PMm(8+8 BE) @ DATA_START+16
  // Response: user_id(i32) + relation1(i32) + relation2(i32) + access_code(10)
  //           + portal_status(u8) + company_code(u8) + Padding(8) +
  //           auth_key(256) = 288 bytes

  private async handleFeliCaLookupEx(pkt: Buffer, gameId: string):
      Promise<Buffer> {
    const idmHex = pkt.slice(DATA_START + 16, DATA_START + 24)
                       .readBigUInt64BE(0)
                       .toString(16)
                       .toUpperCase()
                       .padStart(16, '0');

    Logger.info(`[AimeDB] FeliCaLookupEx IDm=${idmHex}`);

    if (idmHex === '0000000000000000') {
      Logger.warn('[AimeDB] FeliCaLookupEx: all-zero IDm rejected');
      return this.makeFeliCaLookupExResponse(pkt, null, null, STATUS_BAN_SYS);
    }

    const result = await FindProfileByFeliCa(idmHex);
    Logger.info(`[AimeDB] FeliCaLookupEx: ${
        result ? `found aimeId=${result.aimeId}` : 'not found'}`);
    return this.makeFeliCaLookupExResponse(
        pkt, result ? result.aimeId : null, result ? result.accessCode : null);
  }

  private makeFeliCaLookupExResponse(
      pkt: Buffer, aimeId: number|null, accessCode: string|null,
      status: number = STATUS_OK): Buffer {
    const payload = Buffer.alloc(288, 0);
    payload.writeInt32LE(aimeId !== null && aimeId >= 0 ? aimeId : -1, 0);
    payload.writeInt32LE(-1, 4);  // relation1 unsupported
    payload.writeInt32LE(-1, 8);  // relation2 unsupported

    if (accessCode) {
      accessCodeToBytes(accessCode).copy(payload, 12, 0, 10);
    }

    payload.writeUInt8(0, 22);  // portal_status = NO_REG
    payload.writeUInt8(1, 23);  // company_code = SEGA
    // 8 bytes padding at 24..31 zero
    // auth_key 256 bytes at 32..287 zero

    return this.makePacket(pkt, CMD_FELICA_LOOKUP_EX_RESP, payload, status);
  }

  // ── Campaign (cmd 0x0B) ───────────────────────────────────────────────────
  // New protocol (>= 0x3030): 3 × Campaign(160 bytes) = 480 bytes payload →
  // total 0x200 Old protocol (< 0x3030): 4 × i32 = 16 bytes payload → total
  // 0x30 All-zero fields = no campaigns; game skips the reward screen silently.

  private handleCampaign(pkt: Buffer): Buffer {
    const protoVer = pkt.readUInt16LE(HDR_PROTO_VER);
    Logger.info(`[AimeDB] Campaign protoVer=0x${protoVer.toString(16)}`);

    if (protoVer >= PROTO_VER_NEW_CAMPAIGN) {
      // 3 × Campaign:
      // id(4)+name(128)+announce_date(4)+start(4)+end(4)+distrib_start(4)+distrib_end(4)+Padding(8)
      // = 160
      return this.makePacket(pkt, CMD_CAMPAIGN_RESP, Buffer.alloc(160 * 3, 0));
    } else {
      // 4 × i32 = 16
      return this.makePacket(pkt, CMD_CAMPAIGN_RESP, Buffer.alloc(16, 0));
    }
  }

  // ── Campaign clear (cmd 0x0D) ─────────────────────────────────────────────
  // 3 × CampaignClear: id(4)+entry_flag(4)+clear_flag(4)+Padding(4) = 16 → 48
  // bytes payload → total 0x50

  private handleCampaignClear(pkt: Buffer): Buffer {
    Logger.info('[AimeDB] CampaignClear');
    return this.makePacket(
        pkt, CMD_CAMPAIGN_CLEAR_RESP, Buffer.alloc(16 * 3, 0));
  }

  // ── Status log (cmd 0x07) ─────────────────────────────────────────────────
  // artemis: ADBBaseResponse(resp_code, 0x20, ...) — header only, no payload

  private handleStatusLog(pkt: Buffer): Buffer {
    const aimeId =
        pkt.length >= DATA_START + 4 ? pkt.readUInt32LE(DATA_START) : 0;
    const status =
        pkt.length >= DATA_START + 8 ? pkt.readUInt32LE(DATA_START + 4) : 0;
    Logger.info(`[AimeDB] StatusLog aimeId=${aimeId} status=${status}`);
    return this.makeHeader(pkt, CMD_STATUS_LOG_RESP, HDR_SIZE);
  }

  // ── AiMe log (cmd 0x09) ───────────────────────────────────────────────────
  // artemis: ADBBaseResponse(resp_code, 0x20, ...) — header only, no payload

  private handleAimeLog(pkt: Buffer): Buffer {
    const aimeId =
        pkt.length >= DATA_START + 4 ? pkt.readUInt32LE(DATA_START) : 0;
    Logger.info(`[AimeDB] AimeLog aimeId=${aimeId}`);
    return this.makeHeader(pkt, CMD_AIME_LOG_RESP, HDR_SIZE);
  }

  // ── AiMe log EX (cmd 0x13) ────────────────────────────────────────────────
  // Response: log_result(i8×20) + Padding(12) = 32 bytes payload → total 0x40

  private handleAimeLogEx(pkt: Buffer): Buffer {
    const NUM_LOGS = 20;
    const LOG_EX_SIZE = 48;
    const numLogsOffset = DATA_START + (LOG_EX_SIZE * NUM_LOGS);
    const numLogs =
        pkt.length > numLogsOffset + 4 ? pkt.readUInt32LE(numLogsOffset) : 0;

    Logger.info(`[AimeDB] AimeLogEx numLogs=${numLogs}`);

    // log_result: 1 = accepted for each slot; Padding(12) at offset 20
    const payload = Buffer.alloc(32, 0);
    for (let i = 0; i < NUM_LOGS; i++) payload.writeInt8(1, i);

    return this.makePacket(pkt, CMD_AIME_LOG_EX_RESP, payload);
  }
}