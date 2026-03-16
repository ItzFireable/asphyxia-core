import { Router, Request, Response } from 'express';
import { Logger } from '../utils/Logger';
import { CorePlugin } from '../CorePlugin';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

// Cache of pre-built hash tables:  key = `${gameCode}:${internalVer}:${saltHex}`
const hashTableCache: Record<string, Record<string, string>> = {};

/**
 * Build a PBKDF2 hash table for an internalVer + salt + iter-count.
 */
function buildHashTable(
  methodNames: string[],
  saltHex: string,
  iterCount: number
): Record<string, string> {
  const salt = Buffer.from(saltHex, 'hex');
  const table: Record<string, string> = {};

  for (const name of methodNames) {
    const hash = crypto.pbkdf2Sync(name, salt, iterCount, 128, 'sha1');
    const hashed = hash.toString('hex').slice(0, 32);
    table[hashed] = name;
  }
  return table;
}

/**
 * SegaRouter handles SEGA ChuniServlet protocol requests.
 */
export const SegaRouter = (plugins: CorePlugin[]) => {
  const router = Router();

  router.post(
    ['/:game/:version/:servlet/:endpoint', '/:game/:version/:servlet/MatchingServer/:endpoint'],
    async (req: Request, res: Response) => {
      const game = req.params.game;
      const version = parseInt(req.params.version, 10);
      let endpoint = req.params.endpoint;

      if (endpoint.toLowerCase() === 'ping') {
        return res.send(zlib.deflateSync(Buffer.from('{"returnCode":"1"}', 'utf8')));
      }

      let rawBody: Buffer;
      try {
        rawBody = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
      } catch (e) {
        Logger.error(`[SegaRouter] Failed to read body: ${e.message}`);
        return res.status(500).end();
      }

      if (!rawBody || rawBody.length === 0) {
        return res.status(400).end();
      }

      const plugin = plugins.find(p => p.GameCodes.includes(game));
      if (!plugin) {
        Logger.warn(`[SegaRouter] No plugin for game ${game}`);
        return res.status(404).end();
      }

      const internalVer = plugin.SegaVersionMap ? plugin.SegaVersionMap(game, version) : -1;

      let encrypted = false;
      let cryptoKey: Buffer = null;
      let cryptoIV: Buffer = null;

      const isHashed = /^[0-9a-fA-F]{32}$/.test(endpoint);

      if (isHashed && internalVer !== -1) {
        const cryptoKeysConfig = plugin.SegaCryptoKeys;

        if (cryptoKeysConfig && cryptoKeysConfig[String(internalVer)]) {
          const [keyHex, ivHex, saltHex, iterOverride] = cryptoKeysConfig[String(internalVer)];
          const iter = iterOverride ?? (plugin.SegaIterCounts[String(internalVer)] || 0);

          if (iter > 0) {
            const cacheKey = `${game}:${internalVer}:${saltHex}`;
            if (!hashTableCache[cacheKey]) {
              Logger.info(`[SegaRouter] Building hash table for ${game} int:${internalVer} (${iter} iters)...`);
              hashTableCache[cacheKey] = buildHashTable(plugin.SegaMethodNames, saltHex, iter);
              Logger.info(`[SegaRouter] Hash table built, ${Object.keys(hashTableCache[cacheKey]).length} entries`);
            }

            const resolved = hashTableCache[cacheKey][endpoint.toLowerCase()];
            if (resolved) {
              endpoint = resolved;
              cryptoKey = Buffer.from(keyHex, 'hex');
              cryptoIV = Buffer.from(ivHex, 'hex');
              encrypted = true;
            } else {
              Logger.error(`[SegaRouter] No hash match for ${game} int:${internalVer} endpoint ${endpoint}`);
              return res.send(zlib.deflateSync(Buffer.from('{"stat":"0"}', 'utf8')));
            }
          }
        }
      }

      let bodyBuf = rawBody;
      if (encrypted && cryptoKey && cryptoIV) {
        try {
          const decipher = crypto.createDecipheriv('aes-128-cbc', cryptoKey, cryptoIV);
          decipher.setAutoPadding(true);
          bodyBuf = Buffer.concat([decipher.update(rawBody), decipher.final()]);
        } catch (e) {
          Logger.error(`[SegaRouter] AES decryption failed for ${endpoint}: ${e.message}`);
          return res.send(zlib.deflateSync(Buffer.from('{"stat":"0"}', 'utf8')));
        }
      }

      let jsonBuf: Buffer;
      if (req.headers['x-debug']) {
        jsonBuf = bodyBuf;
      } else {
        try {
          jsonBuf = zlib.inflateSync(bodyBuf);
        } catch (e) {
          Logger.error(`[SegaRouter] Zlib inflate failed for ${endpoint}: ${e.message}`);
          return res.send(zlib.deflateSync(Buffer.from('{"stat":"0"}', 'utf8')));
        }
      }

      let reqData: any;
      try {
        reqData = JSON.parse(jsonBuf.toString('utf8'));
      } catch (e) {
        Logger.warn(`[SegaRouter] JSON parse failed for ${endpoint}: ${e.message}`);
        return res.status(400).end();
      }

      Logger.info(`[SegaRouter] ${game} v${version} (int:${internalVer}) ${endpoint} (Encrypted: ${encrypted})`);
      Logger.debug(`[SegaRouter] Request body: ${JSON.stringify(reqData, null, 2)}`);

      let result: any;
      try {
        result = await plugin.runSega(game, endpoint, reqData);
      } catch (e) {
        Logger.error(`[SegaRouter] Plugin runSega failed: ${e.message}`);
        return res.status(500).json({ returnCode: -1 });
      }

      if (result == null) result = { returnCode: 1 };

      const jsonOut = Buffer.from(JSON.stringify(result, null, 0), 'utf8');

      if (req.headers['x-debug']) {
        return res.send(jsonOut);
      }

      const zipped = zlib.deflateSync(jsonOut);

      if (encrypted && cryptoKey && cryptoIV) {
        try {
          const padLen = 16 - (zipped.length % 16);
          const padded = Buffer.concat([zipped, Buffer.alloc(padLen, padLen)]);
          const cipher = crypto.createCipheriv('aes-128-cbc', cryptoKey, cryptoIV);
          cipher.setAutoPadding(false);
          const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
          return res.send(enc);
        } catch (e) {
          Logger.error(`[SegaRouter] AES encryption of response failed: ${e.message}`);
        }
      }

      return res.send(zipped);
    }
  );

  return router;
};
