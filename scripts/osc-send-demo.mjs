#!/usr/bin/env node
/**
 * Sends a few LFOs over OSC to PatchToy (through the I/O bridge), so the
 * projects/io-osc example works without TouchDesigner / Max / Ableton:
 *
 *   npm run io-bridge                    # terminal 1 (pair the app, enable I/O)
 *   node scripts/osc-send-demo.mjs       # terminal 2
 *
 * Messages (60 per second, to 127.0.0.1:9000 by default):
 *   /patchtoy/lfo     f   0..1 sine, 0.25 Hz
 *   /patchtoy/xy      ff  a slow Lissajous point, 0..1 each
 *   /patchtoy/color   fff an RGB color cycling through hues
 *   /patchtoy/beat    i   a beat counter, sent every 0.5 s (120 BPM)
 *
 * Options: --host 127.0.0.1 --port 9000 --rate 60 --bundle (send each frame as one OSC bundle)
 */
import dgram from 'node:dgram';
import { encodeMessage, encodeBundle } from '../mcp/lib/osc.mjs';

const argv = process.argv.slice(2);
const opt = { host: '127.0.0.1', port: 9000, rate: 60, bundle: false };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') opt.host = argv[++i];
    else if (a === '--port') opt.port = Number(argv[++i]);
    else if (a === '--rate') opt.rate = Math.max(1, Math.min(500, Number(argv[++i]) || 60));
    else if (a === '--bundle') opt.bundle = true;
    else if (a === '--help' || a === '-h') { console.log('usage: node scripts/osc-send-demo.mjs [--host 127.0.0.1] [--port 9000] [--rate 60] [--bundle]'); process.exit(0); }
}

const sock = dgram.createSocket('udp4');
const t0 = Date.now();
let beat = -1;
let sent = 0;

function hsv(h) {
    const k = (n) => (n + h * 6) % 6;
    const f = (n) => 1 - Math.max(0, Math.min(k(n), 4 - k(n), 1));
    return [f(5), f(3), f(1)];
}

const tick = () => {
    const t = (Date.now() - t0) / 1000;
    const msgs = [
        { address: '/patchtoy/lfo', args: [0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.25)] },
        { address: '/patchtoy/xy', args: [0.5 + 0.4 * Math.sin(t * 0.9), 0.5 + 0.4 * Math.sin(t * 1.3 + 1)] },
        { address: '/patchtoy/color', args: hsv((t * 0.05) % 1) },
    ];
    const b = Math.floor(t * 2);
    if (b !== beat) {
        beat = b;
        msgs.push({ address: '/patchtoy/beat', args: [b], types: 'i' });
    }
    const packets = opt.bundle ? [encodeBundle(msgs)] : msgs.map(m => encodeMessage(m.address, m.args, m.types));
    for (const p of packets) sock.send(p, opt.port, opt.host);
    sent += msgs.length;
};

const timer = setInterval(tick, 1000 / opt.rate);
const report = setInterval(() => process.stdout.write(`\rsent ${sent} OSC messages to ${opt.host}:${opt.port}   `), 500);
console.log(`Sending /patchtoy/{lfo,xy,color,beat} to ${opt.host}:${opt.port} at ${opt.rate} Hz${opt.bundle ? ' (bundles)' : ''}. Ctrl-C to stop.`);
process.on('SIGINT', () => { clearInterval(timer); clearInterval(report); sock.close(); console.log(''); process.exit(0); });
