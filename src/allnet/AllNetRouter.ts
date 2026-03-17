import { Router } from 'express';
import { CorePlugin } from '../CorePlugin';
import { FindCabinet, CreateCabinet, FindArcadeForCabinet } from '../utils/EamuseIO';
import { CONFIG } from '../utils/ArgConfig';
import { Logger } from '../utils/Logger';
import * as zlib from 'zlib';

export const AllNetRouter = (plugins: CorePlugin[]) => {
    const router = Router();

    const decodeDFI = (data: string): string => {
        try {
            const compressed = Buffer.from(data, 'base64');
            return zlib.inflateSync(compressed).toString('utf-8');
        } catch (e) {
            Logger.warn(`[AllNet] DFI decode failed: ${e.message}`);
            return data;
        }
    };

    const encodeDFI = (data: string): Buffer => {
        const compressed = zlib.deflateSync(Buffer.from(data, 'utf-8'));
        return Buffer.concat([
            Buffer.from(compressed.toString('base64'), 'utf-8'),
            Buffer.from('\r\n', 'utf-8'),
        ]);
    };

    const bodyToString = (body: any): string => {
        if (Buffer.isBuffer(body)) return body.toString('utf-8');
        if (typeof body === 'object' && body !== null && !Array.isArray(body))
            return new URLSearchParams(body).toString();
        if (typeof body === 'string') return body;
        return '';
    };

    const toResponseStr = (obj: Record<string, string>): string =>
        Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('&') + '\n';

    const resolveHostname = (): string =>
        (CONFIG.sega_hostname && CONFIG.sega_hostname.trim())
            ? CONFIG.sega_hostname.trim()
            : 'naominet.jp';

    const ensureCabinet = async (serial: string): Promise<void> => {
        try {
            const existing = await FindCabinet(serial);
            if (!existing) {
                await CreateCabinet(serial, `Auto: ${serial}`);
                Logger.info(`[AllNet] Auto-registered cabinet: ${serial}`);
            }
        } catch (err) {
            Logger.error(`[AllNet] Cabinet registration failed for ${serial}: ${err.message}`);
        }
    };

    const handlePowerOn = async (req: any, res: any) => {
        const pragma = req.header('Pragma');
        const isDFI = pragma === 'DFI';
        const rawBodyStr = bodyToString(req.body);
        Logger.info(`[AllNet] PowerOn raw body type=${typeof req.body} isBuffer=${Buffer.isBuffer(req.body)} len=${rawBodyStr.length} isDFI=${isDFI}`);

        let bodyStr = rawBodyStr;
        if (isDFI) {
            bodyStr = decodeDFI(bodyStr);
            Logger.info(`[AllNet] PowerOn decoded request: ${bodyStr}`);
        } else {
            Logger.warn('[AllNet] PowerOn received without DFI pragma');
            Logger.info(`[AllNet] PowerOn raw request: ${bodyStr}`);
        }

        const params = new URLSearchParams(bodyStr);
        const game_id = params.get('game_id') || params.get('title_id') || 'SXXX';
        const ver = params.get('ver') || params.get('title_ver') || '1.00';
        const serial = params.get('serial') || params.get('client_id') || 'A69E01A8888';
        const token = params.get('token') || '0';
        const format_ver = parseFloat(params.get('format_ver') || '1.00');

        Logger.info(`[AllNet] PowerOn: game=${game_id} ver=${ver} serial=${serial} format_ver=${format_ver} token=${token}`);

        await ensureCabinet(serial);

        const host = resolveHostname();
        const uri = `http://${host}/${game_id}/${ver.replace(/\./g, '')}/`;

        const now = new Date();
        const utcTime = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

        const arcade = await FindArcadeForCabinet(serial);
        Logger.info(`[AllNet] PowerOn arcade lookup for ${serial}: ${arcade ? `found id=${arcade.id} name=${arcade.name}` : 'none (unlinked, using defaults)'}`);

        const responseObj: Record<string, string> = {
            stat: '1',
            uri: uri,
            host: host,
            place_id: arcade?.place_id || '0123',
            name: arcade?.name || CONFIG.server_name || 'Asphyxia',
            nickname: CONFIG.server_tag || 'Asphyxia',
            setting: '1',
            region0: arcade?.region || '1',
            region_name0: arcade?.region_name0 || 'W',
            region_name1: arcade?.region_name1 || '',
            region_name2: arcade?.region_name2 || '',
            region_name3: arcade?.region_name3 || '',
            country: arcade?.country || 'JPN',
            allnet_id: '123',
            client_timezone: '+0900',
            utc_time: utcTime,
            res_ver: '3',
        };

        if (format_ver >= 3) {
            responseObj.token = token;
        } else if (format_ver >= 2) {
            responseObj.res_class = 'PowerOnResponseV2';
            responseObj.timezone = '+09:00';
            responseObj.year = String(now.getUTCFullYear());
            responseObj.month = String(now.getUTCMonth() + 1);
            responseObj.day = String(now.getUTCDate());
            responseObj.hour = String(now.getUTCHours());
            responseObj.minute = String(now.getUTCMinutes());
            responseObj.second = String(now.getUTCSeconds());
            delete responseObj.utc_time;
            delete responseObj.allnet_id;
            delete responseObj.res_ver;
        } else {
            responseObj.year = String(now.getUTCFullYear());
            responseObj.month = String(now.getUTCMonth() + 1);
            responseObj.day = String(now.getUTCDate());
            responseObj.hour = String(now.getUTCHours());
            responseObj.minute = String(now.getUTCMinutes());
            responseObj.second = String(now.getUTCSeconds());
            delete responseObj.utc_time;
            delete responseObj.allnet_id;
            delete responseObj.res_ver;
            delete responseObj.country;
            delete responseObj.client_timezone;
        }

        const respStr = toResponseStr(responseObj);
        Logger.info(`[AllNet] PowerOn response (plaintext): ${respStr.trim()}`);

        if (isDFI) {
            res.setHeader('Pragma', 'DFI');
            res.send(encodeDFI(respStr));
        } else {
            res.send(respStr);
        }
    };

    router.post(['/sys/servlet/PowerOn', '/net/initialize'], handlePowerOn);

    router.post(['/sys/servlet/DownloadOrder', '/net/delivery/instruction'], async (req, res) => {
        const pragma = req.header('Pragma');
        const isDFI = pragma === 'DFI';

        let bodyStr = bodyToString(req.body);
        if (isDFI) bodyStr = decodeDFI(bodyStr);

        const params = new URLSearchParams(bodyStr);
        const serial = params.get('serial') || params.get('client_id') || 'A69E01A8888';
        Logger.info(`[AllNet] DownloadOrder from serial=${serial}`);

        const respStr = `stat=1&serial=${serial}&uri=null\n`;
        Logger.info(`[AllNet] DownloadOrder response: ${respStr.trim()}`);

        if (isDFI) {
            res.setHeader('Pragma', 'DFI');
            res.send(encodeDFI(respStr));
        } else {
            res.send(respStr);
        }
    });

    router.post('/sys/servlet/LoaderStateRecorder', (req, res) => {
        Logger.info(`[AllNet] LoaderStateRecorder hit`);
        res.send('OK');
    });

    router.post('/report-api/Report', (req, res) => {
        try {
            let body = req.body;
            let parsed: any = null;
            if (Buffer.isBuffer(body)) {
                try { parsed = JSON.parse(body.toString('utf-8')); } catch {
                    parsed = Object.fromEntries(new URLSearchParams(body.toString('utf-8')));
                }
            } else if (typeof body === 'string') {
                try { parsed = JSON.parse(body); } catch {
                    parsed = Object.fromEntries(new URLSearchParams(body));
                }
            } else if (typeof body === 'object' && body !== null) {
                parsed = body;
            }

            const image = parsed?.appimage || parsed?.optimage;
            if (!image || !image.serial || image.serial.length === 0) {
                Logger.warn(`[AllNet] DeliveryReport: missing/invalid payload`);
                return res.send('NG');
            }

            Logger.info(`[AllNet] DeliveryReport serial=${image.serial} rf_state=${image.rf_state}`);
            res.send('OK');
        } catch (err) {
            Logger.error(`[AllNet] DeliveryReport error: ${err.message}`);
            res.send('NG');
        }
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
            try { body = zlib.inflateRawSync(body); } catch { }
        }

        const params = new URLSearchParams(body.toString());
        const requestno = params.get('requestno') || '1';
        Logger.info(`[Billing] Request requestno=${requestno} from keychipid=${params.get('keychipid')}`);

        const resp: Record<string, string> = {
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

        res.send(toResponseStr(resp));
    });

    return router;
};
