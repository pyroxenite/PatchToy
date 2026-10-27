#!/usr/bin/env node
/**
 * PatchToy I/O bridge (OSC / serial / Art-Net for the browser app):
 *
 *   npm run io-bridge
 *   npm run io-bridge -- --port 7879 --app http://localhost:5173/ --mock-serial --verbose
 *
 * Prints a pairing token and a URL that pairs the app automatically. In the app:
 * Output > I/O, paste the token (or open the URL), then enable I/O for the session
 * and allow the destinations (host:port) your patch sends to.
 *
 * Options:
 *   --port N          WebSocket port on 127.0.0.1 (default 7879, env PATCHTOY_IO_PORT)
 *   --token T         use this token instead of a random one (env PATCHTOY_IO_TOKEN; >= 16 chars)
 *   --app URL         the PatchToy app URL: its origin may connect, and the printed pairing link uses it
 *                     (default http://localhost:5173/, env PATCHTOY_URL)
 *   --origin O        also accept WebSocket connections from this browser origin (repeatable, exact),
 *                     e.g. a deployed PatchToy (https://patchtoy.example). Besides these, only the
 *                     PatchToy Vite dev servers running from this repo are accepted (the same Origin
 *                     policy as the MCP bridge, mcp/lib/auth.mjs), not every localhost page
 *   --mock-serial     add two fake serial ports: /dev/mock-loopback (echoes writes) and
 *                     /dev/mock-sensor (sends "a,b,n" lines at 20 Hz), for testing without hardware
 *   --no-serial       disable serial support
 *   --verbose         log every message
 *
 * The bridge only listens on 127.0.0.1 and sends nothing until a paired app has opted in.
 * See mcp/lib/io-bridge.mjs and README "Connecting hardware & other apps".
 */
import { IOBridge, IO_BRIDGE_DEFAULT_PORT } from '../mcp/lib/io-bridge.mjs';

const argv = process.argv.slice(2);
const opts = { port: Number(process.env.PATCHTOY_IO_PORT) || IO_BRIDGE_DEFAULT_PORT, token: process.env.PATCHTOY_IO_TOKEN || null, app: process.env.PATCHTOY_URL || 'http://localhost:5173/', origins: [], mockSerial: false, serial: 'auto', verbose: false };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
        const v = argv[++i];
        if (v === undefined) { console.error(`${a} needs a value`); process.exit(2); }
        return v;
    };
    if (a === '--port') opts.port = Number(val());
    else if (a === '--token') opts.token = val();
    else if (a === '--app') opts.app = val();
    else if (a === '--origin') opts.origins.push(val());
    else if (a === '--mock-serial') opts.mockSerial = true;
    else if (a === '--no-serial') opts.serial = 'off';
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--help' || a === '-h') {
        console.log('usage: npm run io-bridge -- [--port 7879] [--token T] [--app URL] [--origin O] [--mock-serial] [--no-serial] [--verbose]');
        process.exit(0);
    } else { console.error(`unknown option ${a} (see --help)`); process.exit(2); }
}
if (opts.token && opts.token.length < 16) { console.error('--token must be at least 16 characters'); process.exit(2); }
if (!(opts.port >= 0 && opts.port <= 65535)) { console.error('--port must be 0..65535'); process.exit(2); }

const bridge = new IOBridge({ port: opts.port, token: opts.token, appUrl: opts.app, allowedOrigins: opts.origins, mockSerial: opts.mockSerial, serial: opts.serial, verbose: opts.verbose });
try {
    await bridge.start();
} catch (e) {
    if (e.code === 'EADDRINUSE') console.error(`Port ${opts.port} is in use: is another io-bridge running? Use --port to pick another one.`);
    else console.error(`Could not start the I/O bridge: ${e.message}`);
    process.exit(1);
}

const f = bridge.features();
const line = '-'.repeat(64);
console.log(line);
console.log(' PatchToy I/O bridge');
console.log(`   listening   ws://127.0.0.1:${bridge.port}  (this machine only)`);
console.log(`   token       ${bridge.token}`);
console.log(`   pair        ${bridge.pairingUrl(opts.app)}`);
console.log(`   features    OSC in/out, Art-Net out, serial ${f.serial ? (f.serialMock ? 'on (+ mock ports)' : 'on') : `off (${f.serialError})`}`);
console.log(line);
console.log(' In PatchToy: Output > I/O, paste the token (or open the pair URL),');
console.log(' then "Enable I/O for this session" and allow your destinations.');
console.log(' The token changes every time the bridge starts. Ctrl-C to stop.');
console.log(line);

let stopping = false;
const stop = async (why) => {
    if (stopping) return;
    stopping = true;
    console.log(`[io-bridge] stopping (${why})`);
    const t = setTimeout(() => process.exit(0), 2000);
    t.unref?.();
    await bridge.close();
    process.exit(0);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
