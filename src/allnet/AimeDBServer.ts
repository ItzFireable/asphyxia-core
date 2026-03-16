import * as net from 'net';
import * as crypto from 'crypto';
import { Logger } from '../utils/Logger';
import {
    FindProfileByAccessCode,
    FindOrCreateCardProfile,
    FindProfileByFeliCa,
    RegisterFeliCa,
    CONFIG,
} from '../utils/EamuseIO';

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

export class AimeDBServer {
    private server: net.Server;
    private port: number = DEFAULT_PORT;

    constructor() {
        this.server = net.createServer(s => this.handleConnection(s));
    }

    public getPort(): number { return this.port; }

    public start(port?: number) {
        if (port) this.port = port;
        this.server.listen(this.port, '0.0.0.0', () =>
            Logger.info(`[AimeDB] Listening on 0.0.0.0:${this.port}`)
        );
    }

    private decrypt(data: Buffer): Buffer {
        const d = crypto.createDecipheriv('aes-128-ecb', AIMEDB_KEY, null);
        d.setAutoPadding(false);
        return Buffer.concat([d.update(data), d.final()]);
    }

    private encrypt(data: Buffer): Buffer {
        const padLen = (16 - (data.length % 16)) % 16;
        const padded = padLen > 0
            ? Buffer.concat([data, Buffer.alloc(padLen, 0)])
            : data;
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
                        socket.write(this.encrypt(resp));
                    }
                } catch (err) {
                    Logger.error(`[AimeDB] Handler error: ${err.message}`);
                }
            }
        });

        socket.on('error', err => {
            if (!err.message.includes('ECONNRESET'))
                Logger.error(`[AimeDB] Socket error: ${err.message}`);
        });
    }

    private async dispatch(pkt: Buffer): Promise<Buffer | null | undefined> {
        const cmd = pkt.readUInt16LE(HDR_CMD);
        const gameId = pkt.toString('ascii', HDR_GAME_ID, HDR_GAME_ID + 6).replace(/\0/g, '');
        const keychip = pkt.toString('ascii', HDR_KEYCHIP, HDR_KEYCHIP + 12).replace(/\0/g, '');

        Logger.info(`[AimeDB] cmd=0x${cmd.toString(16).padStart(2, '0')} game=${gameId} keychip=${keychip}`);

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
                Logger.warn(`[AimeDB] Unhandled cmd=0x${cmd.toString(16)}`);
                return this.makeHeader(pkt, cmd + 1, HDR_SIZE);
        }
    }

    private makeHeader(
        req: Buffer,
        respCmd: number,
        totalLength: number,
        status: number = STATUS_OK
    ): Buffer {
        const h = Buffer.alloc(HDR_SIZE, 0);
        h.writeUInt16LE(0xa13e, HDR_MAGIC);
        h.writeUInt16LE(req.readUInt16LE(HDR_PROTO_VER), HDR_PROTO_VER); // echo proto ver
        h.writeUInt16LE(respCmd, HDR_CMD);
        h.writeUInt16LE(totalLength, HDR_LENGTH);
        h.writeUInt16LE(status, HDR_STATUS);
        req.copy(h, HDR_GAME_ID, HDR_GAME_ID, HDR_GAME_ID + 6);
        req.copy(h, HDR_STORE_ID, HDR_STORE_ID, HDR_STORE_ID + 4);
        req.copy(h, HDR_KEYCHIP, HDR_KEYCHIP, HDR_KEYCHIP + 12);
        return h;
    }

    private makePacket(req: Buffer, respCmd: number, payload: Buffer, status: number = STATUS_OK): Buffer {
        const total = HDR_SIZE + payload.length;
        const header = this.makeHeader(req, respCmd, total, status);
        return Buffer.concat([header, payload]);
    }

    private async handleFeliCaLookup(pkt: Buffer, gameId: string): Promise<Buffer> {
        const idmBuf = pkt.slice(DATA_START, DATA_START + 8);
        const idmHex = idmBuf.readBigUInt64BE(0).toString(16).toUpperCase().padStart(16, '0');

        Logger.info(`[AimeDB] FeliCaLookup IDm=${idmHex}`);

        if (idmHex === '0000000000000000') {
            Logger.warn('[AimeDB] FeliCaLookup: all-zero IDm rejected');
            return this.makeFeliCaResponse(pkt, null, STATUS_BAN_SYS);
        }

        const result = await FindProfileByFeliCa(idmHex);
        Logger.info(`[AimeDB] FeliCaLookup IDm=${idmHex} → ${result ? result.accessCode : 'not found'}`);
        return this.makeFeliCaResponse(pkt, result ? result.accessCode : null);
    }

    private async handleFeliCaRegister(pkt: Buffer, gameId: string): Promise<Buffer> {
        const idmBuf = pkt.slice(DATA_START, DATA_START + 8);
        const idmHex = idmBuf.readBigUInt64BE(0).toString(16).toUpperCase().padStart(16, '0');

        Logger.info(`[AimeDB] FeliCaRegister IDm=${idmHex}`);

        if (idmHex === '0000000000000000') {
            Logger.warn('[AimeDB] FeliCaRegister: all-zero IDm rejected');
            return this.makeFeliCaResponse(pkt, null, STATUS_BAN_SYS);
        }

        if (!CONFIG.allow_register) {
            Logger.warn('[AimeDB] FeliCaRegister: registration disabled');
            return this.makeFeliCaResponse(pkt, null);
        }

        const result = await RegisterFeliCa(idmHex, gameId || 'SDHD');
        Logger.info(`[AimeDB] FeliCaRegister IDm=${idmHex} → ${result ? result.accessCode : 'failed'}`);
        return this.makeFeliCaResponse(pkt, result ? result.accessCode : null);
    }

    private makeFeliCaResponse(pkt: Buffer, accessCode: string | null, status: number = STATUS_OK): Buffer {
        const payload = Buffer.alloc(16, 0);

        if (!accessCode) {
            payload.writeUInt32LE(0xFFFFFFFF, 0);
        } else {
            payload.writeUInt32LE(0x00000000, 0);
            const acBytes = Buffer.from(accessCode.replace(/\s/g, ''), 'hex');
            acBytes.copy(payload, 4, 0, Math.min(acBytes.length, 10));
        }

        return this.makePacket(pkt, CMD_FELICA_RESP, payload, status);
    }

    private async handleLookup(pkt: Buffer, gameId: string): Promise<Buffer> {
        const accessCodeHex = pkt.slice(DATA_START, DATA_START + 10).toString('hex').toUpperCase();

        if (accessCodeHex === '00000000000000000000') {
            Logger.warn('[AimeDB] Lookup: all-zero access code rejected');
            return this.makeLookupResponse(pkt, null, STATUS_BAN_SYS);
        }

        Logger.info(`[AimeDB] Lookup accessCode=${accessCodeHex}`);
        const result = await FindProfileByAccessCode(accessCodeHex);

        if (result) {
            Logger.info(`[AimeDB] Lookup: found aimeId=${result.aimeId}`);
        } else {
            Logger.info('[AimeDB] Lookup: not found');
        }

        return this.makeLookupResponse(pkt, result ? result.aimeId : null);
    }

    private async handleRegister(pkt: Buffer, gameId: string): Promise<Buffer> {
        const accessCodeHex = pkt.slice(DATA_START, DATA_START + 10).toString('hex').toUpperCase();
        const serialNumber = pkt.length >= DATA_START + 16
            ? pkt.readUInt32LE(DATA_START + 12)
            : 0;

        if (accessCodeHex === '00000000000000000000') {
            Logger.warn('[AimeDB] Register: all-zero access code rejected');
            return this.makeLookupResponse(pkt, null, STATUS_BAN_SYS);
        }

        Logger.info(`[AimeDB] Register accessCode=${accessCodeHex} serial=0x${serialNumber.toString(16)}`);

        if (!CONFIG.allow_register) {
            Logger.warn('[AimeDB] Register: registration disabled');
            return this.makeLookupResponse(pkt, null, STATUS_BAN_SYS);
        }

        const result = await FindOrCreateCardProfile(accessCodeHex, gameId || 'SDHD');
        if (result) {
            Logger.info(`[AimeDB] Register: ${result.isNew ? 'created' : 'existing'} aimeId=${result.aimeId}`);
        } else {
            Logger.error('[AimeDB] Register: failed to create profile');
        }

        return this.makeLookupResponse(pkt, result ? result.aimeId : null);
    }

    private makeLookupResponse(pkt: Buffer, aimeId: number | null, status: number = STATUS_OK): Buffer {
        const payload = Buffer.alloc(16, 0);
        payload.writeInt32LE(aimeId !== null && aimeId >= 0 ? aimeId : -1, 0);
        payload.writeInt8(0, 4);
        return this.makePacket(pkt, CMD_LOOKUP_RESP, payload, status);
    }

    private async handleLookupEx(pkt: Buffer, gameId: string): Promise<Buffer> {
        const accessCodeHex = pkt.slice(DATA_START, DATA_START + 10).toString('hex').toUpperCase();

        if (accessCodeHex === '00000000000000000000') {
            Logger.warn('[AimeDB] LookupEx: all-zero access code rejected');
            return this.makeLookupExResponse(pkt, null, STATUS_BAN_SYS);
        }

        Logger.info(`[AimeDB] LookupEx accessCode=${accessCodeHex}`);
        const result = await FindProfileByAccessCode(accessCodeHex);

        if (result) {
            Logger.info(`[AimeDB] LookupEx: found aimeId=${result.aimeId}`);
        } else {
            Logger.info('[AimeDB] LookupEx: not found');
        }

        return this.makeLookupExResponse(pkt, result ? result.aimeId : null);
    }

    private makeLookupExResponse(pkt: Buffer, aimeId: number | null, status: number = STATUS_OK): Buffer {
        const payload = Buffer.alloc(272, 0);
        payload.writeInt32LE(aimeId !== null && aimeId >= 0 ? aimeId : -1, 0);
        payload.writeInt8(0, 4);
        payload.writeInt32LE(-1, 264);
        payload.writeInt32LE(-1, 268);
        return this.makePacket(pkt, CMD_LOOKUP_EX_RESP, payload, status);
    }

    private async handleFeliCaLookupEx(pkt: Buffer, gameId: string): Promise<Buffer> {
        const IDM_OFFSET = DATA_START + 16; // 0x30
        const idmBuf = pkt.slice(IDM_OFFSET, IDM_OFFSET + 8);
        const idmHex = idmBuf.readBigUInt64BE(0).toString(16).toUpperCase().padStart(16, '0');

        Logger.info(`[AimeDB] FeliCaLookupEx IDm=${idmHex}`);

        if (idmHex === '0000000000000000') {
            Logger.warn('[AimeDB] FeliCaLookupEx: all-zero IDm rejected');
            return this.makeFeliCaLookupExResponse(pkt, null, null, STATUS_BAN_SYS);
        }

        const result = await FindProfileByFeliCa(idmHex);

        if (result) {
            Logger.info(`[AimeDB] FeliCaLookupEx: found aimeId=${result.aimeId} accessCode=${result.accessCode}`);
        } else {
            Logger.info('[AimeDB] FeliCaLookupEx: not found');
        }

        return this.makeFeliCaLookupExResponse(
            pkt,
            result ? result.aimeId : null,
            result ? result.accessCode : null
        );
    }

    private makeFeliCaLookupExResponse(
        pkt: Buffer,
        aimeId: number | null,
        accessCode: string | null,
        status: number = STATUS_OK
    ): Buffer {
        const payload = Buffer.alloc(288, 0);
        payload.writeInt32LE(aimeId !== null && aimeId >= 0 ? aimeId : -1, 0);
        payload.writeInt32LE(-1, 4);
        payload.writeInt32LE(-1, 8);

        if (accessCode) {
            const acBytes = Buffer.from(accessCode.replace(/\s/g, ''), 'hex');
            acBytes.copy(payload, 12, 0, Math.min(acBytes.length, 10));
        }

        payload.writeUInt8(0, 22);
        payload.writeUInt8(1, 23);
        return this.makePacket(pkt, CMD_FELICA_LOOKUP_EX_RESP, payload, status);
    }

    private handleCampaign(pkt: Buffer): Buffer {
        const protoVer = pkt.readUInt16LE(HDR_PROTO_VER);
        Logger.info(`[AimeDB] Campaign protoVer=0x${protoVer.toString(16)}`);

        if (protoVer >= PROTO_VER_NEW_CAMPAIGN) {
            const CAMPAIGN_SIZE = 160;
            const NUM_CAMPAIGNS = 3;
            const payload = Buffer.alloc(CAMPAIGN_SIZE * NUM_CAMPAIGNS, 0);
            return this.makePacket(pkt, CMD_CAMPAIGN_RESP, payload);
        } else {
            const payload = Buffer.alloc(16, 0);
            return this.makePacket(pkt, CMD_CAMPAIGN_RESP, payload);
        }
    }

    private handleCampaignClear(pkt: Buffer): Buffer {
        Logger.info('[AimeDB] CampaignClear');
        const payload = Buffer.alloc(48, 0);
        return this.makePacket(pkt, CMD_CAMPAIGN_CLEAR_RESP, payload);
    }

    private handleStatusLog(pkt: Buffer): Buffer {
        const aimeId = pkt.length >= DATA_START + 4 ? pkt.readUInt32LE(DATA_START) : 0;
        const status = pkt.length >= DATA_START + 8 ? pkt.readUInt32LE(DATA_START + 4) : 0;
        Logger.info(`[AimeDB] StatusLog aimeId=${aimeId} status=${status}`);
        return this.makeHeader(pkt, CMD_STATUS_LOG_RESP, HDR_SIZE);
    }

    private handleAimeLog(pkt: Buffer): Buffer {
        const aimeId = pkt.length >= DATA_START + 4 ? pkt.readUInt32LE(DATA_START) : 0;
        Logger.info(`[AimeDB] AimeLog aimeId=${aimeId}`);
        return this.makeHeader(pkt, CMD_AIME_LOG_RESP, HDR_SIZE);
    }

    private handleAimeLogEx(pkt: Buffer): Buffer {
        const NUM_LOGS = 20;
        const NUM_LEN_LOG_EX = 48;
        const numLogsOffset = DATA_START + (NUM_LEN_LOG_EX * NUM_LOGS);
        const numLogs = pkt.length > numLogsOffset + 4
            ? pkt.readUInt32LE(numLogsOffset)
            : 0;

        Logger.info(`[AimeDB] AimeLogEx numLogs=${numLogs}`);

        const payload = Buffer.alloc(32, 0);
        for (let i = 0; i < NUM_LOGS; i++) {
            payload.writeInt8(1, i);
        }

        return this.makePacket(pkt, CMD_AIME_LOG_EX_RESP, payload);
    }
}