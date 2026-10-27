#!/usr/bin/env node
/**
 * Make small gallery thumbnails: projects/<slug>.png (1280x800) -> projects/thumbs/<slug>.jpg (640x400).
 * The demo gallery prefers these and falls back to the full PNG when a thumb is missing.
 * Uses macOS `sips`; on other systems the gallery simply keeps using the PNGs.
 *
 *   node scripts/make-thumbs.mjs          # only missing / outdated thumbs
 *   node scripts/make-thumbs.mjs --force  # regenerate all
 */
import { readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = path.join(root, 'projects');
const out = path.join(src, 'thumbs');
const force = process.argv.includes('--force');
mkdirSync(out, { recursive: true });

let made = 0;
for (const file of readdirSync(src)) {
    if (!file.endsWith('.png')) continue;
    const from = path.join(src, file);
    const to = path.join(out, file.replace(/\.png$/, '.jpg'));
    if (!force && existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs) continue;
    try {
        execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '--resampleWidth', '640', from, '--out', to], { stdio: 'ignore' });
        made++;
        console.log(`thumb: ${path.relative(root, to)} (${Math.round(statSync(to).size / 1024)} KB)`);
    } catch (e) {
        console.error(`could not convert ${file} (is sips available?)`);
        process.exitCode = 1;
        break;
    }
}
console.log(made ? `${made} thumbnail(s) written` : 'thumbnails up to date');
