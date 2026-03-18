if ((process as any).pkg) process.env.NODE_ENV = 'production';

import { Logger } from './utils/Logger';
import { ARGS, CONFIG, ReadConfig, SaveConfig } from './utils/ArgConfig';
import { services } from './eamuse';
import { VERSION } from './utils/Consts';
import { pad } from 'lodash';
import express from 'express';
import chalk from 'chalk';
import { CorePlugin } from './CorePlugin';
import { LoadExternalPlugins } from './eamuse/ExternalPluginLoader';
import { webui } from './webui/index';
import path from 'path';
import { ASSETS_PATH, LoadCoreDB, SeedDefaultAdmin, CreateCabinet } from './utils/EamuseIO';
import open from 'open';
import { Migrate } from './utils/migration';
import { AimeDBServer } from './allnet/AimeDBServer';
import { AllNetRouter } from './allnet/AllNetRouter';
import { SegaRouter } from './sega/SegaRouter';

function isIPv6(ip: string) {
  return !!/(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/.test(
    ip
  );
}

function cleanIP(ip: string) {
  if (ip.startsWith('[') && ip.endsWith(']')) {
    return ip.substr(1, ip.length - 2);
  }
  return ip;
}

function Main() {
  ReadConfig();

  process.title = `${CONFIG.server_name || 'Asphyxia Core'} ${VERSION}`;

  Logger.info('                        _                _        ');
  Logger.info('        /\\             | |              (_)      ');
  Logger.info('       /  \\   ___ _ __ | |__  _   ___  ___  __ _ ');
  Logger.info("      / /\\ \\ / __| '_ \\| '_ \\| | | \\ \\/ / |/ _` |");
  Logger.info('     / ____ \\\\__ \\ |_) | | | | |_| |>  <| | (_| |');
  Logger.info('    /_/    \\_\\___/ .__/|_| |_|\\__, /_/\\_\\_|\\__,_|');
  Logger.info('                 | |           __/ |     __   __   __   ___ ');
  Logger.info('                 |_|          |___/     /  ` /  \\ |__) |__  ');
  Logger.info('                                        \\__, \\__/ |  \\ |___ ');
  Logger.info('');
  Logger.info(chalk.cyanBright(pad(`${CONFIG.server_tag || 'CORE'} ${VERSION}`, 60)));
  Logger.info(pad(`Brought you by Team Asphyxia | Modified by Beafowl`, 60));
  Logger.info(` `);
  Logger.info(chalk.redBright(pad(`FREE SOFTWARE. BEWARE OF SCAMMERS.`, 60)));
  Logger.info(pad(`If you bought this software, request refund immediately.`, 60));
  Logger.info(` `);

  const EAMUSE = express();

  EAMUSE.disable('etag');
  EAMUSE.disable('x-powered-by');

  if (ARGS.dev) {
    Logger.info(` [Developer Mode] Console Output Enabled`);
    Logger.info(``);
  }

  const external = LoadExternalPlugins();
  SaveConfig();

  process.title = `${CONFIG.server_name || 'Asphyxia Core'} ${VERSION} | Plugins: ${external.length
    }`;
  if (external.length <= 0) {
    Logger.warn(chalk.yellowBright('no plugins are installed.'));
    Logger.info('');
  }

  // ========== EAMUSE ============
  EAMUSE.set('views', path.join(ASSETS_PATH, 'views'));
  EAMUSE.set('view engine', 'pug');

  const rawBuffer = express.raw({ type: '*/*', limit: '10mb' });
  const segaAllnetPaths = [
    '/sys/', '/net/', '/request', '/report-api/',
    '/naomitest.html',
  ];
  EAMUSE.use((req, res, next) => {
    if (segaAllnetPaths.some(p => req.url.startsWith(p)) ||
      /^\/[A-Z]{4}\/\d+\//.test(req.url)) {
      return rawBuffer(req, res, next);
    }
    next();
  });

  EAMUSE.use(SegaRouter(external));
  EAMUSE.use(AllNetRouter(external));
  EAMUSE.use('/static', express.static(path.join(ASSETS_PATH, 'static')));

  EAMUSE.use(webui);
  EAMUSE.use('/api/cabinets/register', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { pcbid, name, mac } = req.body;
      if (!pcbid) return res.status(400).json({ success: false, error: 'Missing pcbid' });
      const cabinet = await CreateCabinet(pcbid, name || 'Auto-Detected', mac || '');
      return res.json({ success: true, cabinet });
    } catch (e) {
      return res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  EAMUSE.use('*', services(CONFIG.port, external));

  // ========== AIME SERVER ========
  const aimeDB = new AimeDBServer();
  aimeDB.start(CONFIG.aime_port || 22356);

  // ========== LISTEN ============
  const cleaned = cleanIP(CONFIG.bind);
  const isV6 = isIPv6(cleaned);
  const printAddr = isV6 ? `[${cleaned}]` : cleaned;
  const removeNIC = cleaned.split('%')[0];
  const openAddr =
    cleaned == '0.0.0.0' || cleaned == '::' || cleaned == '0:0:0:0:0:0:0:0'
      ? 'localhost'
      : isV6
        ? `[${removeNIC}]`
        : removeNIC;

  const server = EAMUSE.listen(CONFIG.port, CONFIG.bind, () => {
    Logger.info(``);
    const serverInfo = `${printAddr} at ${CONFIG.port}`;
    const httpInfo = `http://${openAddr}:${CONFIG.port}`;
    Logger.info(`   +=============== Server Started ===============+`);
    Logger.info(`   | - Listening - - - - - - - - - - - - - - - - -|`);
    Logger.info(`   |${pad(serverInfo, 46)}|`);
    Logger.info(`   | - WebUI - - - - - - - - - - - - - - - - - - -|`);
    Logger.info(`   |${pad(httpInfo, 46)}|`);
    Logger.info(`   +==============================================+`);
    Logger.info('');

    if (CONFIG.webui_on_startup) {
      try {
        open(`http://${openAddr}:${CONFIG.port}`);
      } catch { }
    }
  });

  if (CONFIG.sega_port && CONFIG.sega_port !== CONFIG.port) {
    EAMUSE.listen(CONFIG.sega_port, CONFIG.bind, () => {
      const segaInfo = `${printAddr} at ${CONFIG.sega_port}`;
      const aimeInfo = `${printAddr} at ${aimeDB.getPort()}`;
      Logger.info(`   +============ SEGA All.Net Dedicated ==========+`);
      Logger.info(`   | - Listening - - - - - - - - - - - - - - - - -|`);
      Logger.info(`   |${pad(segaInfo, 46)}|`);
      Logger.info(`   | - AimeDB - - - - - - - - - - - - - - - - - - |`);
      Logger.info(`   |${pad(aimeInfo, 46)}|`);
      Logger.info(`   +==============================================+`);
      Logger.info('');
    });
  }

  server.on('error', (err: any) => {
    if (err && err.code == 'EADDRINUSE') {
      Logger.info('Server failed to start: port might be in use.');
      Logger.info('Use -p argument to change port.');
    }
    Logger.info(' ');
    Logger.error(`     ${err.message}`);
    Logger.info(' ');
    Logger.info('Press any key to exit.');
    process.stdin.resume();
    process.stdin.on('data', process.exit.bind(process, 0));
  });
}

Migrate().then(() => {
  LoadCoreDB()
    .then(() => SeedDefaultAdmin())
    .then(Main);
});