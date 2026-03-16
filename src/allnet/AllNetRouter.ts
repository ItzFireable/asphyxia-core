import { Router } from 'express';
import { CorePlugin } from '../CorePlugin';
import { FindCabinet } from '../utils/EamuseIO';
import { CONFIG } from '../utils/ArgConfig';
import { Logger } from '../utils/Logger';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

export const AllNetRouter = (plugins: CorePlugin[]) => {
    const router = Router();

    const decodeDFI = (data: string) => {
        try {
            const compressed = Buffer.from(data, 'base64');
            return zlib.inflateSync(compressed).toString('utf-8');
        } catch (e) {
            return data;
        }
    };

    const encodeDFI = (data: string) => {
        const compressed = zlib.deflateSync(Buffer.from(data, 'utf-8'));
        return compressed.toString('base64');
    };

    const handlePowerOn = async (req: any, res: any) => {
        const pragma = req.header('Pragma');
        const isDFI = pragma === 'DFI';

        let body = req.body;
        let bodyStr: string;
        if (Buffer.isBuffer(body)) {
            bodyStr = body.toString('utf-8');
        } else if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
            bodyStr = new URLSearchParams(body).toString();
        } else if (typeof body === 'string') {
            bodyStr = body;
        } else {
            bodyStr = '';
        }

        if (isDFI && bodyStr) {
            bodyStr = decodeDFI(bodyStr);
        } else if (!isDFI) {
            Logger.warn('[AllNet] PowerOn received without DFI pragma — proceeding anyway');
        }

        const params = new URLSearchParams(bodyStr);

        const game_id = params.get('game_id') || params.get('title_id') || 'SXXX';
        const ver = params.get('ver') || params.get('title_ver') || '1.00';
        const serial = params.get('serial') || params.get('client_id') || 'A69E01A8888';
        const token = params.get('token') || 'null';

        const format_ver = parseFloat(params.get('format_ver') || '1.00');

        Logger.info(`[AllNet] PowerOn: ${game_id} v${ver} (Serial: ${serial}, Format: ${format_ver})`);
        await FindCabinet(serial);

        const host = `${CONFIG.server_name || 'localhost'}:${CONFIG.sega_port || 80}`;
        const uri = `http://${host}/${game_id}/${ver.replace(/\./g, '')}/`;

        const now = new Date();
        const utcTime = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

        const responseObj: Record<string, string> = {
            stat: '1',
            uri: uri,
            host: host,
            place_id: '0123',
            name: CONFIG.server_name || 'Asphyxia',
            nickname: CONFIG.server_tag || 'Asphyxia',
            setting: '1',
            region0: '1',
            region_name0: 'AICHI',
            region_name1: 'JPN',
            region_name2: 'NAGOYA',
            region_name3: '',
            country: 'JPN',
            allnet_id: '1',
            client_timezone: '+0900',
            utc_time: utcTime,
            res_ver: '3',
        };

        if (format_ver >= 3) {
            responseObj.token = token;
        } else if (format_ver >= 2) {
            responseObj.country = 'JPN';
            responseObj.year = String(now.getUTCFullYear());
            responseObj.month = String(now.getUTCMonth() + 1);
            responseObj.day = String(now.getUTCDate());
            responseObj.hour = String(now.getUTCHours());
            responseObj.minute = String(now.getUTCMinutes());
            responseObj.second = String(now.getUTCSeconds());
            delete responseObj.utc_time;
            delete responseObj.allnet_id;
            delete responseObj.res_ver;
        }

        const respStr = new URLSearchParams(responseObj).toString() + '\n';

        if (isDFI) {
            res.setHeader('Pragma', 'DFI');
            res.send(encodeDFI(respStr));
        } else {
            res.send(respStr);
        }
    };

    router.post(['/sys/servlet/PowerOn', '/net/initialize'], handlePowerOn);

    router.post(['/sys/servlet/DownloadOrder', '/net/delivery/instruction'], async (req, res) => {
        let body = req.body;
        let bodyStr: string;
        if (Buffer.isBuffer(body)) {
            bodyStr = body.toString('utf-8');
        } else if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
            bodyStr = new URLSearchParams(body).toString();
        } else if (typeof body === 'string') {
            bodyStr = body;
        } else {
            bodyStr = '';
        }

        const params = new URLSearchParams(bodyStr);
        const serial = params.get('serial') || params.get('client_id') || 'A69E01A8888';
        Logger.info(`[AllNet] DownloadOrder from ${serial}`);
        res.send(`stat=1&serial=${serial}&uri=null\n`);
    });

    router.post('/sys/servlet/LoaderStateRecorder', (req, res) => {
        res.send('OK');
    });

    router.post('/sys/servlet/Alive', (req, res) => {
        res.send('OK');
    });

    router.get('/naomitest.html', (req, res) => {
        res.send('naomi ok');
    });

    router.post(['/request', '/request/'], async (req, res) => {
        let body = req.body;
        if (Buffer.isBuffer(body) && body.length > 0) {
            try {
                body = zlib.inflateRawSync(body);
            } catch (e) { }
        } else if (req.header('Content-Type') === 'application/octet-stream') {
            try {
                body = zlib.inflateRawSync(body);
            } catch (e) { }
        }

        const params = new URLSearchParams(body.toString());
        const requestno = params.get('requestno') || '1';
        Logger.info(`[Billing] Request ${requestno} from ${params.get('keychipid')}`);

        const resp = {
            result: '0',
            requestno: requestno,
            traceerase: '1',
            fixinterval: '120',
            fixlogcnt: '100',
            playlimit: '0',
            playlimitsig: '',
            playhistory: '000000/0:000000/0:000000/0',
            nearfull: '0',
            nearfullsig: '',
            linelimit: '100',
            protocolver: '1.000',
        };

        res.send(new URLSearchParams(resp).toString() + '\n');
    });

    return router;
};