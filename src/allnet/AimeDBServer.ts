import * as net from 'net';
import * as crypto from 'crypto';
import { Logger } from '../utils/Logger';

const AIMEDB_KEY = Buffer.from('Copyright(C)SEGA');

const CMD_FELICA_LOOKUP = 0x01;
const CMD_FELICA_REGISTER = 0x02;
const CMD_FELICA_RESP = 0x03;
const CMD_LOOKUP = 0x04;
const CMD_REGISTER = 0x05;
const CMD_LOOKUP_RESP = 0x06;
const CMD_LOG = 0x09;
const CMD_LOG_EX = 0x0a;
const CMD_HELLO = 0x64;
const CMD_GOODBYE = 0x66;

const RESULT_UNKNOWN_ERROR = 0x00;
const RESULT_OK = 0x01;

export class AimeDBServer {
    private server: net.Server;
    private port: number = 22356;

    constructor() {
        this.server = net.createServer((socket) => {
            this.handleConnection(socket);
        });
    }

    public getPort(): number {
        return this.port;
    }

    public start(port?: number) {
        if (port) this.port = port;
        this.server.listen(this.port, '0.0.0.0', () => {
            Logger.info(`[AimeDB] Listening on 0.0.0.0:${this.port}`);
        });
    }

    private decrypt(data: Buffer): Buffer {
        const decipher = crypto.createDecipheriv('aes-128-ecb', AIMEDB_KEY, null);
        decipher.setAutoPadding(false);
        return Buffer.concat([decipher.update(data), decipher.final()]);
    }

    private encrypt(data: Buffer): Buffer {
        const padLen = (16 - (data.length % 16)) % 16;
        const padded = padLen > 0 ? Buffer.concat([data, Buffer.alloc(padLen, 0)]) : data;
        const cipher = crypto.createCipheriv('aes-128-ecb', AIMEDB_KEY, null);
        cipher.setAutoPadding(false);
        return Buffer.concat([cipher.update(padded), cipher.final()]);
    }

    private async handleConnection(socket: net.Socket) {
        let buffer = Buffer.alloc(0);

        socket.on('data', async (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length >= 32) {
                try {
                    const header = this.decrypt(buffer.slice(0, 32));
                    const magic = header.readUInt16LE(0);

                    if (magic !== 0xa13e) {
                        buffer = buffer.slice(1);
                        continue;
                    }
                    const length = header.readUInt16LE(6);

                    const paddedLength = Math.ceil(length / 16) * 16;

                    if (buffer.length < paddedLength) {
                        break;
                    }

                    const fullPacket = this.decrypt(buffer.slice(0, paddedLength));
                    buffer = buffer.slice(paddedLength);

                    const response = await this.processPacket(fullPacket);
                    if (response) {
                        socket.write(this.encrypt(response));
                    }
                } catch (err) {
                    Logger.error(`[AimeDB] Error processing packet: ${err.message}`);
                    buffer = buffer.slice(16);
                }
            }
        });

        socket.on('error', (err) => {
            if (!err.message.includes('ECONNRESET')) {
                Logger.error(`[AimeDB] Socket error: ${err.message}`);
            }
        });

        socket.on('close', () => {
            Logger.info('[AimeDB] Connection closed');
        });
    }

    private async processPacket(packet: Buffer): Promise<Buffer | null> {
        const cmd = packet.readUInt16LE(4);
        const gameId = packet.toString('ascii', 10, 16).replace(/\0/g, '');
        const keychipId = packet.toString('ascii', 20, 32).replace(/\0/g, '');

        Logger.info(`[AimeDB] Command: 0x${cmd.toString(16).padStart(2, '0')} | Game: ${gameId} | Keychip: ${keychipId}`);

        switch (cmd) {
            case CMD_FELICA_LOOKUP:
            case CMD_FELICA_REGISTER:
                return this.handleFeliCa(packet);
            case CMD_LOOKUP:
            case CMD_REGISTER:
                return this.handleLookup(packet);

            case CMD_LOG:
            case CMD_LOG_EX:
                return this.handleLog(packet);
            case CMD_HELLO:
                return this.handleHello(packet);

            case CMD_GOODBYE:
                return null;

            default:
                Logger.warn(`[AimeDB] Unhandled command: 0x${cmd.toString(16)}`);
                return this.handleLog(packet);
        }
    }

    private buildHeader(
        requestPacket: Buffer,
        responseCmdId: number,
        totalLength: number,
        result: number = RESULT_OK
    ): Buffer {
        const header = Buffer.alloc(32, 0);
        header.writeUInt16LE(0xa13e, 0);
        header.writeUInt16LE(requestPacket.readUInt16LE(2), 2);
        header.writeUInt16LE(responseCmdId, 4);
        header.writeUInt16LE(totalLength, 6);
        header.writeUInt16LE(result, 8);
        return header;
    }

    private async handleHello(packet: Buffer): Promise<Buffer> {
        const totalLength = 0x20;
        const header = this.buildHeader(packet, 0x65, totalLength, RESULT_OK);
        return header;
    }

    private async handleFeliCa(packet: Buffer): Promise<Buffer> {
        const PAYLOAD_SIZE = 14;
        const totalLength = 32 + PAYLOAD_SIZE;
        const header = this.buildHeader(packet, CMD_FELICA_RESP, totalLength, RESULT_OK);
        const payload = Buffer.alloc(PAYLOAD_SIZE, 0);

        payload.writeUInt32LE(0xFFFFFFFF, 0);

        return Buffer.concat([header, payload]);
    }

    private async handleLookup(packet: Buffer): Promise<Buffer> {
        const PAYLOAD_SIZE = 5;
        const totalLength = 32 + PAYLOAD_SIZE;
        const header = this.buildHeader(packet, CMD_LOOKUP_RESP, totalLength, RESULT_OK);
        const payload = Buffer.alloc(PAYLOAD_SIZE, 0);

        payload.writeUInt32LE(0xFFFFFFFF, 0);
        payload.writeUInt8(0x00, 4);

        return Buffer.concat([header, payload]);
    }

    private async handleLog(packet: Buffer): Promise<Buffer> {
        const responseCmdId = packet.readUInt16LE(4) + 1;
        const totalLength = 0x20;
        return this.buildHeader(packet, responseCmdId, totalLength, RESULT_OK);
    }
}