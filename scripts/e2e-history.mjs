#!/usr/bin/env node
/**
 * End-to-end checks of undo / redo (src/core/History.js) in headless Chrome.
 *
 *   node scripts/e2e-history.mjs                       # private Vite (free port, HMR off)
 *   node scripts/e2e-history.mjs --app http://localhost:5281/
 *
 * Covers: add -> undo -> redo (library click, ⌘Z / ⇧⌘Z / Ctrl+Y), node drag = one step
 * without a recompile, connect / disconnect / drop-replacement / accessor, Param slider
 * scrub and typing coalescing (Parameters panel open), group / ungroup (scope kept),
 * group inputs unplugged inside stay patched from outside (virtual), unused outputs kept while open
 * and pruned on close (undoable), cables dropped on a group box become virtual inputs,
 * custom GLSL node create / update, JS code restore never grants trust, live state kept
 * (Feedback buffers, preview renderer, JS state), MCP-style batch = one step, history
 * cleared on load, memory cap, and timing / memory of snapshots on scene-medley.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { REPO_ROOT, startTestVite } from '../tests/lib/vite-server.mjs';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
let APP = argOf('app');
let vite = null;
if (!APP) {
    vite = await startTestVite();
    APP = vite.url;
}

let passes = 0, failures = 0;
function check(cond, label, extra) {
    if (cond) { passes++; console.log(`  ok   ${label}`); }
    else { failures++; console.log(`  FAIL ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 500) : ''}`); }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
    try {
        if (!sessionStorage.getItem('__hist_init')) {
            sessionStorage.setItem('__hist_init', '1');
            localStorage.clear();
            localStorage.setItem('patchtoy_ui_params_open', '1');
        }
    } catch (e) { /* ignore */ }
});
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

const sleep = (ms) => page.waitForTimeout(ms);
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const undo = async () => { await page.keyboard.press(`${MOD}+z`); await sleep(150); };
const redo = async () => { await page.keyboard.press(`${MOD}+Shift+z`); await sleep(150); };
const ev = (fn, arg) => page.evaluate(fn, arg);

/** Fresh empty project, history cleared, no dialogs. */
async function fresh() {
    await ev(() => {
        document.querySelectorAll('.pt-modal-backdrop').forEach(e => e.remove());
        window.toy.createNewProject();
    });
    await sleep(150);
}

/** Screen position of a world point. */
async function screenOf(x, y) {
    return ev(([x, y]) => {
        const g = window.toy.nodeGraph;
        const r = g.canvas.getBoundingClientRect();
        return { x: r.left + x * g.zoom + g.panX, y: r.top + y * g.zoom + g.panY };
    }, [x, y]);
}
async function portScreen(id, kind, index) {
    const p = await ev(([id, kind, index]) => {
        const n = window.toy.nodeGraph.nodes.find(n => n.id === id);
        return kind === 'out' ? n.getOutputPortPosition(index) : n.getInputPortPosition(index);
    }, [id, kind, index]);
    return screenOf(p.x, p.y);
}
async function drag(from, to, steps = 8) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await page.mouse.up();
    await sleep(120);
}
/** A user action that isn't a canvas gesture: a click on some button whose handler runs fn. */
async function clickDo(src) {
    await ev((src) => {
        window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        return (0, eval)(src);
    }, src);
    await sleep(120);
}
const hist = () => ev(() => window.toy.history.list());
const nodesInfo = () => ev(() => window.toy.nodeGraph.nodes.map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y })));
const connCount = () => ev(() => window.toy.nodeGraph.connections.length);

/** Count recompiles (main compile + feedback shader compile) from now on. */
async function spyCompiles() {
    await ev(() => {
        const t = window.toy;
        window.__compiles = 0;
        if (!t.__spied) {
            t.__spied = true;
            const cm = t.compilationManager;
            const orig = cm.compile.bind(cm);
            cm.compile = (...a) => { window.__compiles++; return orig(...a); };
            const fr = t.feedbackRenderer;
            const of = fr.compileFeedbackShaders.bind(fr);
            fr.compileFeedbackShaders = (...a) => { window.__compiles++; return of(...a); };
        }
    });
}
const compiles = async () => { await sleep(260); return ev(() => window.__compiles); };

try {
    await page.goto(APP, { waitUntil: 'load' });
    await page.waitForFunction(() => window.toy && window.toy.history && window.toy.shell, null, { timeout: 30000 });
    await sleep(600);
    await page.keyboard.press('Escape');
    await fresh();

    // ---------------------------------------------------------------- add / undo / redo
    console.log('- add -> undo -> redo');
    await page.click('.lib-item[data-type="UV"]');
    await sleep(200);
    let ns = await nodesInfo();
    check(ns.length === 1 && ns[0].type === 'UV', 'library click adds UV', ns);
    let h = await hist();
    check(h.undo.length === 1 && /Add UV/i.test(h.undo[0]), 'one step "Add UV"', h);
    const uvId = ns[0]?.id;
    await undo();
    check((await nodesInfo()).length === 0, '⌘Z removes the node');
    const toast = await ev(() => [...document.querySelectorAll('.pt-toast')].map(t => t.textContent).join('|'));
    check(/Undo: Add UV/.test(toast), 'toast "Undo: Add UV"', toast);
    await redo();
    ns = await nodesInfo();
    check(ns.length === 1 && ns[0].id === uvId, '⇧⌘Z brings it back with the same id', ns);
    await undo();
    await page.keyboard.press('Control+y');
    await sleep(150);
    check((await nodesInfo()).length === 1, 'Ctrl+Y redoes');
    check(await ev(() => [...window.toy.nodeGraph.selectionManager.selectedNodes].map(n => n.id).join(',')) === String(uvId), 'restored node is selected');

    // ---------------------------------------------------------------- move = one step, no recompile
    console.log('- drag = one step, position-only undo does not recompile');
    await fresh();
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__u = g.addNode('UV', 200, 200); window.__p = g.addNode('Preview', 600, 200);
        g.connections.push(new g.groupCtl.Connection(window.__u, 0, window.__p, 0)); g.onGraphChanged(); })()`);
    await sleep(400);
    const before = await ev(() => ({ x: window.__u.x, y: window.__u.y, renderer: !!window.__p.renderer }));
    await ev(() => { window.__renderer = window.__p.renderer; });
    h = await hist();
    const start = await screenOf(before.x + 30, before.y + 8);
    await drag(start, { x: start.x + 160, y: start.y + 90 }, 12);
    await sleep(150);
    h = await hist();
    check(h.undo[0] && /^Move UV/.test(h.undo[0]) && h.undo.length === 2, 'a 12-move drag is one "Move UV" step', h.undo);
    await spyCompiles();
    await undo();
    const after = await ev(() => ({ x: window.__u.x, y: window.__u.y, same: window.toy.nodeGraph.nodes.includes(window.__u), sameRenderer: window.__p.renderer === window.__renderer }));
    check(after.x === before.x && after.y === before.y, 'undo restores the position', { before, after });
    check(after.same && after.sameRenderer, 'same node instance and preview renderer after undo');
    check(await compiles() === 0, 'position-only undo: no recompile');
    check(await ev(() => window.toy.history.stats.lastCompile === false), 'history reports no compile');
    await redo();
    check(await compiles() === 0, 'position-only redo: no recompile');

    // ---------------------------------------------------------------- connect / disconnect / replacement
    console.log('- connect / disconnect / drop replacement / accessor');
    await fresh();
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__a = g.addNode('UV', 100, 100); window.__t = g.addNode('Time', 100, 300); window.__s = g.addNode('Sin', 400, 300); window.__p = g.addNode('Preview', 700, 150); })()`);
    await sleep(300);
    const [aId, tId, sId, pId] = await ev(() => [window.__a.id, window.__t.id, window.__s.id, window.__p.id]);
    await drag(await portScreen(aId, 'out', 0), await portScreen(pId, 'in', 0));
    check(await connCount() === 1, 'drag output -> input connects');
    h = await hist();
    check(/^Connect /.test(h.undo[0]), 'step "Connect …"', h.undo[0]);
    await spyCompiles();
    await undo();
    check(await connCount() === 0, 'undo disconnects');
    check(await compiles() > 0, 'connection undo recompiles');
    await redo();
    check(await connCount() === 1, 'redo reconnects');
    // Drop replacement: Time.time -> Sin, Sin -> Preview replaces UV -> Preview
    await drag(await portScreen(tId, 'out', 0), await portScreen(sId, 'in', 0));
    await drag(await portScreen(sId, 'out', 0), await portScreen(pId, 'in', 0));
    let conns = await ev(() => window.toy.nodeGraph.connections.map(c => `${c.fromNode.id}>${c.toNode.id}`));
    check(conns.includes(`${sId}>${pId}`) && !conns.includes(`${aId}>${pId}`), 'dropping on a connected input replaces the cable', conns);
    h = await hist();
    check(/^Reconnect/.test(h.undo[0]), 'replacement is one "Reconnect" step', h.undo[0]);
    await undo();
    conns = await ev(() => window.toy.nodeGraph.connections.map(c => `${c.fromNode.id}>${c.toNode.id}`));
    check(conns.includes(`${aId}>${pId}`) && !conns.includes(`${sId}>${pId}`), 'undo restores the replaced cable', conns);
    // Unplug: drag the connected Preview input to empty space
    const pin = await portScreen(pId, 'in', 0);
    await drag(pin, { x: pin.x - 40, y: pin.y + 220 });
    conns = await ev(() => window.toy.nodeGraph.connections.map(c => `${c.fromNode.id}>${c.toNode.id}`));
    check(!conns.includes(`${aId}>${pId}`), 'dragging a connected input away unplugs it', conns);
    h = await hist();
    check(/^Disconnect/.test(h.undo[0]), 'step "Disconnect …"', h.undo[0]);
    await undo();
    check((await ev(() => window.toy.nodeGraph.connections.map(c => `${c.fromNode.id}>${c.toNode.id}`))).includes(`${aId}>${pId}`), 'undo re-plugs it');
    // Accessor change (connection menu path sets conn.accessor)
    await clickDo(`(() => { const c = window.toy.nodeGraph.connections.find(c => c.toNode === window.__p); c.accessor = c.swizzle = '.xxy'; window.toy.nodeGraph.onGraphChanged(); })()`);
    await sleep(600);
    h = await hist();
    check(/Accessor \.xxy/.test(h.undo[0]), 'accessor change is a step', h.undo[0]);
    await undo();
    check(await ev(() => window.toy.nodeGraph.connections.find(c => c.toNode === window.__p)?.accessor ?? null) === null, 'undo restores the accessor');

    // ---------------------------------------------------------------- multi delete + ForLoop pair
    console.log('- multi delete, ForLoop pair, paste');
    await fresh();
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__f = g.addNode('ForLoopStart', 100, 100); g.addNode('Float', 100, 400); g.addNode('Float', 300, 400); })()`);
    await sleep(300);
    const n0 = await ev(() => window.toy.nodeGraph.nodes.map(n => `${n.id}:${n.type}`).sort().join(','));
    await ev(() => { const g = window.toy.nodeGraph; g.selectionManager.selectedNodes.clear(); g.selectionManager.selectedNodes.add(window.__f); g.selectionManager.selectedNodes.add(g.nodes.find(n => n.type === 'Float')); });
    await page.mouse.move(700, 600);
    await page.keyboard.press('Delete');
    await sleep(700);
    check(await ev(() => window.toy.nodeGraph.nodes.length) === 1, 'Delete removes ForLoopStart, its End and a Float');
    h = await hist();
    check(/^Delete 3 nodes/.test(h.undo[0]), 'one "Delete 3 nodes" step', h.undo[0]);
    await undo();
    const n1 = await ev(() => window.toy.nodeGraph.nodes.map(n => `${n.id}:${n.type}`).sort().join(','));
    check(n1 === n0, 'undo restores all three with their ids', { n0, n1 });
    check(await ev(() => { const s = window.toy.nodeGraph.nodes.find(n => n.isForLoopStartNode); const e = window.toy.nodeGraph.nodes.find(n => n.isForLoopEndNode); return s && e && s.data.pairNodeId === e.id && e.data.pairNodeId === s.id; }), 'ForLoop pair still linked');
    // Copy / paste
    await ev(() => { const g = window.toy.nodeGraph; g.selectionManager.selectedNodes.clear(); g.nodes.filter(n => n.type === 'Float').forEach(n => g.selectionManager.selectedNodes.add(n)); });
    await page.keyboard.press(`${MOD}+c`);
    await page.keyboard.press(`${MOD}+v`);
    await sleep(700);
    h = await hist();
    check(/^Paste 2 nodes/.test(h.undo[0]) && await ev(() => window.toy.nodeGraph.nodes.length) === 6, 'paste is one "Paste 2 nodes" step', h.undo[0]);
    await undo();
    check(await ev(() => window.toy.nodeGraph.nodes.length) === 4, 'undo paste');

    // ---------------------------------------------------------------- Param scrub / typing coalescing
    console.log('- Param slider scrub and typing coalesce (Parameters panel open)');
    await fresh();
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__pr = g.addNode('Param', 200, 200); window.__pr.data.label = 'Speed'; window.__pr.data.value = 0.25; window.__pr.rebuildTextInputs(); g.onGraphChanged(); })()`);
    await sleep(900);
    check(await ev(() => document.getElementById('paramsPanel') && !document.getElementById('paramsPanel').hidden && !!document.querySelector('#paramsList .pp-slider')), 'Parameters panel shows the Param slider');
    h = await hist();
    const steps0 = h.undo.length;
    const sl = await page.locator('#paramsList .pp-slider').first().boundingBox();
    await spyCompiles();
    await page.mouse.move(sl.x + sl.width * 0.2, sl.y + sl.height / 2);
    await page.mouse.down();
    for (let i = 0; i <= 20; i++) await page.mouse.move(sl.x + sl.width * (0.2 + 0.03 * i), sl.y + sl.height / 2);
    await page.mouse.up();
    await sleep(200);
    const scrubbed = await ev(() => window.__pr.data.value);
    h = await hist();
    check(h.undo.length === steps0 + 1 && /^Change Speed/.test(h.undo[0]), 'a 20-move slider scrub is one "Change Speed" step', h.undo.slice(0, 3));
    await undo();
    check(Math.abs(await ev(() => window.__pr.data.value) - 0.25) < 1e-9, 'undo restores the value before the scrub', scrubbed);
    check(await compiles() === 0, 'Param value undo: uniform push, no recompile');
    await redo();
    check(Math.abs(await ev(() => window.__pr.data.value) - scrubbed) < 1e-9, 'redo restores the scrubbed value');
    // Arrow keys on the focused slider coalesce
    await page.locator('#paramsList .pp-slider').first().focus();
    const v0 = await ev(() => window.__pr.data.value);
    const s1 = (await hist()).undo.length;
    for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowRight'); await sleep(60); }
    await sleep(700);
    h = await hist();
    check(h.undo.length === s1 + 1, '6 arrow-key nudges are one step', h.undo.slice(0, 3));
    await undo();
    check(Math.abs(await ev(() => window.__pr.data.value) - v0) < 1e-9, 'undo restores the value before the nudges');
    // Typing in the number field
    const field = page.locator('#paramsList .pp-num-input').first();
    await field.click();
    await field.fill('');
    const s2 = (await hist()).undo.length;
    await page.keyboard.type('0.875', { delay: 80 });
    await page.keyboard.press('Enter');
    await page.mouse.click(900, 700); // blur
    await sleep(700);
    h = await hist();
    check(Math.abs(await ev(() => window.__pr.data.value) - 0.875) < 1e-9 && h.undo.length === s2 + 1, 'typing a value is one step', h.undo.slice(0, 3));

    // ---------------------------------------------------------------- Param kind change, scene list, preview resize
    console.log('- Param kind change (cable), scene list edit, preview resize');
    await fresh();
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__k = g.addNode('Param', 100, 100); window.__kp = g.addNode('Preview', 500, 100);
        window.__kmul = g.addNode('Multiply', 300, 100);
        g.connections.push(new g.groupCtl.Connection(window.__k, 0, window.__kmul, 0)); g.onGraphChanged(); })()`);
    await sleep(400);
    const kOuts = await ev(() => window.__k.outputs.map(o => o.type).join(','));
    await clickDo(`window.__k.setKind('bool')`);
    await sleep(600);
    h = await hist();
    check(/kind/.test(h.undo[0]), 'Param kind change is a step', h.undo[0]);
    await undo();
    check(await ev(() => window.__k.outputs.map(o => o.type).join(',')) === kOuts && await ev(() => window.toy.nodeGraph.connections.some(c => c.fromNode === window.__k)), 'undo restores the kind, its ports and the cable');
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__sw = g.addNode('SceneSwitcher', 100, 400); })()`);
    await sleep(300);
    if (await ev(() => !!window.__sw)) {
        const sc0 = await ev(() => ({ names: window.__sw.data.scenes.map(s => s.name).join('|'), inputs: window.__sw.inputs.length }));
        await clickDo(`(() => { const n = window.__sw; n.data.scenes.push({ name: 'Third' }); n.rebuildTextInputs(); n.setOptions({ sceneName: { index: 0, name: 'Intro' } }); window.toy.nodeGraph.onGraphChanged(); })()`);
        await sleep(600);
        h = await hist();
        check(/scene/i.test(h.undo[0]), 'scene list edit is a step', h.undo[0]);
        await clickDo(`window.__sw.requestScene(1, { instant: true })`); // performance: not a step
        await sleep(300);
        check((await hist()).undo[0] === h.undo[0], 'switching scenes is not a step');
        await undo();
        const sc1 = await ev(() => ({ names: window.__sw.data.scenes.map(s => s.name).join('|'), inputs: window.__sw.inputs.length, current: window.__sw.data.current }));
        check(sc1.names === sc0.names && sc1.inputs === sc0.inputs, 'undo restores the scene list and ports', { sc0, sc1 });
        check(sc1.current === 1, 'the current scene (live) is kept', sc1);
    }
    const pw = await ev(() => ({ w: window.__kp.width, h: window.__kp.height, r: (window.__kpR = window.__kp.renderer, true) }));
    await clickDo(`(() => { const p = window.__kp; p.width = 420; p.height = 300; p.resizeCanvas(); window.toy.nodeGraph.onGraphChanged(); })()`);
    await sleep(600);
    h = await hist();
    check(/^Resize Preview/.test(h.undo[0]), 'preview resize is a step', h.undo[0]);
    await spyCompiles();
    await undo();
    check(await ev(() => window.__kp.width) === pw.w && await ev(() => window.__kp.renderer === window.__kpR), 'undo resizes the same preview back', pw);
    check(await compiles() === 0, 'preview resize undo: no recompile');

    // ---------------------------------------------------------------- Comment + resize
    console.log('- note text and resize, preview resize');
    await fresh();
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__c = g.addNode('Comment', 200, 200); })()`);
    await sleep(200);
    if (await ev(() => !!window.__c)) {
        const noteBefore = await ev(() => ({ text: window.__c.data.text || '', w: window.__c.width }));
        await clickDo(`(() => { window.__c.data.text = 'hello'; window.__c.data.width = 400; window.__c.syncSize(); window.toy.nodeGraph.onGraphChanged(); })()`);
        await sleep(600);
        h = await hist();
        check(/note/i.test(h.undo[0]), 'note edit labelled', h.undo[0]);
        await spyCompiles();
        await undo();
        const noteAfter = await ev(() => ({ text: window.__c.data.text || '', w: window.__c.width }));
        check(noteAfter.text === noteBefore.text && noteAfter.w === noteBefore.w, 'undo restores note text and size', { noteBefore, noteAfter });
        check(await compiles() === 0, 'note undo: no recompile');
    }

    // ---------------------------------------------------------------- groups
    console.log('- group / ungroup / rename; scope kept');
    await fresh();
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__g1 = g.addNode('UV', 100, 100); window.__g2 = g.addNode('Sin', 300, 100); window.__g3 = g.addNode('Preview', 600, 100); })()`);
    await sleep(300);
    await ev(() => { const g = window.toy.nodeGraph; g.selectionManager.selectedNodes.clear(); g.selectionManager.selectedNodes.add(window.__g1); g.selectionManager.selectedNodes.add(window.__g2); });
    await page.mouse.move(800, 650);
    await page.keyboard.press(`${MOD}+g`);
    await sleep(300);
    await page.keyboard.press('Enter'); // accept the rename field
    await sleep(700);
    h = await hist();
    check(await ev(() => window.toy.nodeGraph.groups.length) === 1 && /^Group/.test(h.undo[0]), '⌘G groups (one "Group" step)', h.undo.slice(0, 3));
    await undo();
    check(await ev(() => window.toy.nodeGraph.groups.length) === 0, 'undo removes the group');
    await redo();
    const gid = await ev(() => window.toy.nodeGraph.groups[0]?.id);
    check(!!gid && await ev(() => window.toy.nodeGraph.groups[0].nodeIds.length) === 2, 'redo brings the group back with its 2 nodes');
    // Inside the group: entering is not a step; edit, undo keeps the scope
    const beforeEnter = (await hist()).undo.length;
    await clickDo(`window.toy.nodeGraph.groupCtl.setScope(${JSON.stringify(gid)}, { animate: false })`);
    await sleep(200);
    check((await hist()).undo.length === beforeEnter, 'entering a group is not a step');
    await clickDo(`(() => { window.__g2.x += 50; })()`);
    await sleep(200);
    await undo();
    check(await ev(() => window.toy.nodeGraph.groupCtl.scope) === gid, 'undo inside a group keeps the group open');
    await ev(() => window.toy.nodeGraph.groupCtl.setScope(null, { animate: false }));
    // Rename
    await clickDo(`(() => { const c = window.toy.nodeGraph.groupCtl; c.renameGroup(c.groups[0].id, 'Wobble'); c.changed(); })()`);
    await sleep(600);
    h = await hist();
    check(/Rename group/.test(h.undo[0]), 'rename is a step', h.undo[0]);
    await undo();
    check(await ev(() => window.toy.nodeGraph.groups[0].name) !== 'Wobble', 'undo rename');
    // Ungroup
    await ev(() => { const g = window.toy.nodeGraph; g.selectionManager.selectedNodes.clear(); g.selectionManager.selectedNodes.add(g.groupCtl.proxyFor(g.groups[0].id)); });
    await page.keyboard.press(`${MOD}+Shift+g`);
    await sleep(700);
    h = await hist();
    check(await ev(() => window.toy.nodeGraph.groups.length) === 0 && /Ungroup/.test(h.undo[0]), '⇧⌘G ungroups', h.undo[0]);
    await undo();
    check(await ev(() => window.toy.nodeGraph.groups.length === 1 && window.toy.nodeGraph.groups[0].nodeIds.length === 2), 'undo ungroup');
    // Group box move
    await clickDo(`(() => { const g = window.toy.nodeGraph.groups[0]; g.x += 120; window.toy.nodeGraph.groupCtl.touch(); })()`);
    await sleep(300);
    h = await hist();
    check(/Move group/.test(h.undo[0]), 'group box move is a step', h.undo[0]);

    // ---------------------------------------------------------------- group box port names
    console.log('- group box port names: double-click rename (box + inside panel), undo / redo, save / load');
    {
        await fresh();
        await clickDo(`(() => { const g = window.toy.nodeGraph; const C = g.groupCtl.Connection;
            window.__pa = g.addNode('Float', 80, 200); window.__pb = g.addNode('Sin', 320, 200); window.__pc = g.addNode('Preview', 620, 200);
            g.connections.push(new C(window.__pa, 0, window.__pb, 0)); g.connections.push(new C(window.__pb, 0, window.__pc, 0)); g.onGraphChanged();
            const grp = g.groupCtl.createGroup({ name: 'Osc', nodes: [window.__pb], x: 300, y: 180 }); window.__pg = grp.id; g.groupCtl.changed(); })()`);
        await sleep(600);
        const boxPorts = () => ev(() => { const c = window.toy.nodeGraph.groupCtl; c.view(); const p = c.proxyFor(window.__pg); return { ins: p.inputs.map(i => i.name), outs: p.outputs.map(o => o.name), keys: [...p.inPorts, ...p.outPorts].map(q => q.key) }; });
        const before = await boxPorts();
        check(before.ins.length === 1 && before.outs.length === 1, 'the group box has one input and one output', before);
        // Double-click the output label on the box
        const outSpot = await ev(() => { const c = window.toy.nodeGraph.groupCtl; c.view(); const p = c.proxyFor(window.__pg); const r = p.portLabelRect('out', 0); return { x: r.x + r.w - 12, y: r.y + r.h / 2 }; });
        const so = await screenOf(outSpot.x, outSpot.y);
        await page.mouse.dblclick(so.x, so.y);
        await sleep(200);
        const field = await ev(() => { const el = document.querySelector('.pt-group-port-rename'); return el ? { value: el.value, placeholder: el.placeholder } : null; });
        check(field && field.value === before.outs[0] && field.placeholder === before.outs[0], 'double-clicking a box port label opens a name field', field);
        await page.keyboard.press(`${MOD}+a`);
        await page.keyboard.type('Wave');
        await page.keyboard.press('Enter');
        await sleep(700);
        let bp = await boxPorts();
        h = await hist();
        check(bp.outs[0] === 'Wave' && /Rename group ports/.test(h.undo[0]), 'the box output shows the new name (one "Rename group ports" step)', { bp, top: h.undo[0] });
        // Inside: the "To outside" row shows it; rename the "From outside" row
        await clickDo(`window.toy.nodeGraph.groupCtl.setScope(window.__pg, { animate: false })`);
        await sleep(300);
        const inside = await ev(() => { const c = window.toy.nodeGraph.groupCtl; const v = c.view(); c.viewNodes(); return { out: v.outPanel.rows.map(r => r.label), inn: v.inPanel.rows.map(r => r.label), spot: (() => { const r = v.inPanel.portLabelRect(0); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; })() }; });
        check(inside.out[0] === 'Wave', 'the matching "To outside" row inside shows the name', inside);
        const si = await screenOf(inside.spot.x, inside.spot.y);
        await page.mouse.dblclick(si.x, si.y);
        await sleep(200);
        check(await ev(() => !!document.querySelector('.pt-group-port-rename')), 'double-clicking a "From outside" row opens a name field');
        await page.keyboard.press(`${MOD}+a`);
        await page.keyboard.type('Freq');
        await page.keyboard.press('Enter');
        await sleep(700);
        const insideAfter = await ev(() => window.toy.nodeGraph.groupCtl.view().inPanel.rows[0].label);
        await ev(() => window.toy.nodeGraph.groupCtl.setScope(null, { animate: false }));
        await sleep(200);
        bp = await boxPorts();
        check(insideAfter === 'Freq' && bp.ins[0] === 'Freq' && bp.outs[0] === 'Wave', 'a panel rename shows on the box too', { insideAfter, bp });
        const stored = await ev(() => window.toy.nodeGraph.groupCtl.getGroup(window.__pg).portLabels);
        check(stored && Object.keys(stored).length === 2 && Object.keys(stored).every(k => bp.keys.includes(k)), 'labels are stored in the group record by port key', { stored, keys: bp.keys });
        // Undo / redo
        await undo();
        bp = await boxPorts();
        check(bp.ins[0] === before.ins[0] && bp.outs[0] === 'Wave', 'undo restores the automatic input name', bp);
        await undo();
        bp = await boxPorts();
        check(bp.ins[0] === before.ins[0] && bp.outs[0] === before.outs[0], 'undo again restores the automatic output name', bp);
        await redo();
        await redo();
        bp = await boxPorts();
        check(bp.ins[0] === 'Freq' && bp.outs[0] === 'Wave', 'redo brings both names back', bp);
        // Save / load (and re-layout keeps them: keys don't depend on positions)
        const reloaded = await ev(() => {
            const g = window.toy.nodeGraph;
            const data = JSON.parse(JSON.stringify(g.serialize()));
            g.deserialize(data);
            const c = g.groupCtl;
            c.layoutAllScopes();
            c.view();
            const grp = c.groups[0];
            const p = c.proxyFor(grp.id);
            return { saved: data.groups?.[0]?.portLabels, ins: p.inputs.map(i => i.name), outs: p.outputs.map(o => o.name) };
        });
        check(reloaded.saved && reloaded.ins[0] === 'Freq' && reloaded.outs[0] === 'Wave', 'names survive serialize / load and re-layout', reloaded);
        // Clear one name from the box context menu path (setPortLabel '' = automatic)
        const cleared = await ev(() => { const c = window.toy.nodeGraph.groupCtl; const gid = c.groups[0].id; const key = c.groupPorts(gid).find(p => p.kind === 'out').key; c.setPortLabel(gid, key, ''); return c.groupPorts(gid).find(p => p.kind === 'out'); });
        check(cleared && !cleared.custom && cleared.label === before.outs[0], 'an empty name restores the automatic one', cleared);
    }

    // ---------------------------------------------------------------- unplugged group ports stay while open
    console.log('- group ports unplugged inside: inputs stay patched from outside, unused outputs pruned on close; undo');
    {
        await fresh();
        await clickDo(`(() => { const g = window.toy.nodeGraph; const C = g.groupCtl.Connection; const c = g.groupCtl;
            window.__ka = g.addNode('Float', 60, 200); window.__kb = g.addNode('Sin', 340, 160); window.__ke = g.addNode('Add', 340, 330); window.__kp = g.addNode('Preview', 700, 200);
            g.connections.push(new C(window.__ka, 0, window.__kb, 0)); g.connections.push(new C(window.__kb, 0, window.__kp, 0)); g.onGraphChanged();
            const grp = c.createGroup({ name: 'Keep', nodes: [window.__kb, window.__ke], x: 320, y: 180 }); window.__kg = grp.id;
            grp.exposed = { inputs: [{ node: window.__ke.id, port: 1 }], outputs: [{ node: window.__ke.id, port: 0 }] };
            c.touch();
            c.setPortLabel(grp.id, 's:' + window.__ka.id + ':0', 'Freq');
            c.setPortLabel(grp.id, 'o:' + window.__kb.id + ':0', 'Wave');
            c.changed(); })()`);
        await sleep(700);
        const ids = await ev(() => ({ a: window.__ka.id, b: window.__kb.id, e: window.__ke.id, p: window.__kp.id, g: window.__kg }));
        const IN = `s:${ids.a}:0`, OUT = `o:${ids.b}:0`, XIN = `x:${ids.e}:1`, XOUT = `o:${ids.e}:0`;
        const conns = () => ev(() => window.toy.nodeGraph.connections.map(c => `${c.fromNode.id}.${c.fromOutput}>${c.toNode.id}.${c.toInput}`).sort());
        const rows = () => ev(() => {
            const c = window.toy.nodeGraph.groupCtl; const v = c.view(); c.viewNodes();
            const r = (p) => p.rows.filter(x => !x.expose).map(x => ({ key: x.key, label: x.label, kept: !!x.kept, virtual: !!x.virtual, live: x.conns.length > 0 }));
            return { scope: c.scope, ins: r(v.inPanel), outs: r(v.outPanel) };
        });
        const box = () => ev((gid) => {
            const c = window.toy.nodeGraph.groupCtl; const v = c.view(); c.viewNodes(); const p = c.proxyFor(gid);
            const port = (q) => ({ key: q.key, label: q.label, kept: !!q.kept, virtual: !!q.virtual, linked: !!q.linked });
            const ghostsIn = v.ghosts.filter(gl => gl.dst === p).map(gl => p.inPorts[gl.di]?.key);
            const solidIn = v.ghosts.filter(gl => gl.dst === p && gl.solid).map(gl => p.inPorts[gl.di]?.key);
            const linksIn = v.links.filter(l => l.toNode === p).map(l => p.inPorts[l.toInput]?.key);
            return { ins: p.inPorts.map(port), outs: p.outPorts.map(port), ghostsIn, solidIn, linksIn, labels: { ...(c.getGroup(gid).portLabels || {}) } };
        }, ids.g);
        const virtuals = () => ev((gid) => (window.toy.nodeGraph.groupCtl.getGroup(gid).virtualInputs || []).map(v => `${v.node}:${v.port}`), ids.g);
        const rowPos = (side, key) => ev(([side, key]) => {
            const c = window.toy.nodeGraph.groupCtl; const v = c.view(); c.viewNodes();
            const panel = side === 'in' ? v.inPanel : v.outPanel; const i = panel.indexOfKey(key);
            if (i < 0) return null;
            const p = side === 'in' ? panel.getOutputPortPosition(i) : panel.getInputPortPosition(i);
            const g = window.toy.nodeGraph; const r = g.canvas.getBoundingClientRect();
            return { x: r.left + p.x * g.zoom + g.panX, y: r.top + p.y * g.zoom + g.panY };
        }, [side, key]);
        // An empty spot of the canvas (screen coordinates)
        const emptySpot = () => ev(() => {
            const g = window.toy.nodeGraph; const r = g.canvas.getBoundingClientRect();
            const items = g.groupCtl.viewNodes();
            for (let fy = 0.92; fy > 0.1; fy -= 0.04) for (let fx = 0.5; fx < 0.95; fx += 0.05) {
                const sx = r.width * fx, sy = r.height * fy;
                const wx = (sx - g.panX) / g.zoom, wy = (sy - g.panY) / g.zoom;
                if (!items.some(n => wx >= n.x - 30 && wx <= n.x + (n.width || 100) + 30 && wy >= n.y - 40 && wy <= n.y + (n.height || 60) + 30)) return { x: r.left + sx, y: r.top + sy };
            }
            return null;
        });

        // Open the group with a double-click on its box
        const boxCenter = await ev((gid) => { const c = window.toy.nodeGraph.groupCtl; c.view(); const m = c.proxyFor(gid).minimapRect(); return { x: m.x + m.w / 2, y: m.y + m.h / 2 }; }, ids.g);
        const bc = await screenOf(boxCenter.x, boxCenter.y);
        await page.mouse.dblclick(bc.x, bc.y);
        await sleep(900);
        let r = await rows();
        check(r.scope === ids.g && r.ins.some(x => x.key === IN && x.live && x.label === 'Freq') && r.outs.some(x => x.key === OUT && x.live && x.label === 'Wave'),
            'double-click opens the group: the crossing rows are live and named', r);

        // Unplug the input inside: pull the cable off Sin.a and drop it on empty canvas
        const empty = await emptySpot();
        await drag(await portScreen(ids.b, 'in', 0), empty);
        await sleep(300);
        r = await rows();
        let cs = await conns();
        const inRow = r.ins.find(x => x.key === IN);
        check(!cs.includes(`${ids.a}.0>${ids.b}.0`) && inRow && inRow.virtual && !inRow.kept && !inRow.live && inRow.label === 'Freq',
            'unplugging inside leaves the "From outside" row patched from outside (virtual, still named)', { cs, r });
        check((await virtuals()).includes(`${ids.a}:0`), 'the input is stored as a virtual input of the group', await virtuals());
        // Re-plug: drag from that row to Sin.a
        await drag(await rowPos('in', IN), await portScreen(ids.b, 'in', 0));
        await sleep(300);
        cs = await conns();
        r = await rows();
        check(cs.includes(`${ids.a}.0>${ids.b}.0`) && r.ins.filter(x => x.key === IN).length === 1 && r.ins.find(x => x.key === IN).live,
            're-plugging from the virtual row reconnects the same outside source (same row)', { cs, r });
        check(!(await virtuals()).length, 'connected inside, it is a normal port again (no virtual input left)', await virtuals());

        // Unplug the output inside: pull its cable out of the "To outside" row
        await drag(await rowPos('out', OUT), await emptySpot());
        await sleep(300);
        cs = await conns();
        r = await rows();
        const outRow = r.outs.find(x => x.key === OUT);
        check(!cs.includes(`${ids.b}.0>${ids.p}.0`) && outRow && outRow.kept && outRow.label === 'Wave', 'unplugging an output leaves its "To outside" row', { cs, r });
        // Re-plug the output: drag from Sin's output onto the row
        await drag(await portScreen(ids.b, 'out', 0), await rowPos('out', OUT));
        await sleep(300);
        cs = await conns();
        r = await rows();
        check(cs.includes(`${ids.b}.0>${ids.p}.0`) && r.outs.find(x => x.key === OUT)?.live, 'dropping an inner output on the kept row feeds the outside input again', { cs, r });

        // Unplug both again, then undo / redo inside
        await drag(await portScreen(ids.b, 'in', 0), await emptySpot());
        await sleep(300);
        await drag(await rowPos('out', OUT), await emptySpot());
        await sleep(700);
        cs = await conns();
        check(!cs.includes(`${ids.a}.0>${ids.b}.0`) && !cs.includes(`${ids.b}.0>${ids.p}.0`), 'both unplugged', cs);
        await undo();
        r = await rows();
        check(r.scope === ids.g && (await conns()).includes(`${ids.b}.0>${ids.p}.0`) && r.outs.find(x => x.key === OUT)?.live && r.ins.find(x => x.key === IN)?.virtual,
            'undo inside reconnects the output; the unplugged input row is still there (virtual)', r);
        await undo();
        r = await rows();
        check((await conns()).includes(`${ids.a}.0>${ids.b}.0`) && r.ins.find(x => x.key === IN)?.live && !(await virtuals()).length,
            'undo again reconnects the input inside: one step for the unplug and the virtual input', { r, v: await virtuals() });
        await redo();
        r = await rows();
        check(!(await conns()).includes(`${ids.a}.0>${ids.b}.0`) && r.ins.find(x => x.key === IN)?.virtual && (await virtuals()).includes(`${ids.a}:0`),
            'redo unplugs the input again; it is virtual again', r);
        await redo();
        r = await rows();
        check(r.outs.find(x => x.key === OUT)?.kept && r.ins.find(x => x.key === IN)?.virtual, 'redo unplugs the output again; both rows stay', r);

        // Close the group (breadcrumb "Root"): the unused output is pruned, the virtual input stays
        await page.click('.pt-crumb.is-root');
        await sleep(900);
        let b = await box();
        let h2 = await hist();
        const keys = (list) => list.map(p => p.key);
        check(await ev(() => window.toy.nodeGraph.groupCtl.scope) === null && !keys(b.outs).includes(OUT),
            'closing the group prunes the output that has no cable on either side', b);
        const vin = b.ins.find(p => p.key === IN);
        check(vin && vin.virtual && vin.linked && vin.label === 'Freq' && b.solidIn.includes(IN) && !b.linksIn.includes(IN),
            'the input unplugged inside stays on the box, named, with the outside cable attached', b);
        check(keys(b.ins).includes(XIN) && keys(b.outs).includes(XOUT), 'exposed ports are kept', b);
        check(b.labels[IN] === 'Freq' && !b.labels[OUT], 'the pruned output loses its name; the input keeps its', b.labels);
        check(h2.undo[0] === 'Remove unused group ports', 'one "Remove unused group ports" step', h2.undo.slice(0, 3));
        // Undo brings the output back (with its name)
        await undo();
        b = await box();
        const kout = b.outs.find(p => p.key === OUT);
        check(kout && kout.kept && kout.label === 'Wave' && b.ins.find(p => p.key === IN)?.virtual,
            'undo restores the pruned output (named); the virtual input is still there', b);
        await undo();
        check((await conns()).includes(`${ids.b}.0>${ids.p}.0`), 'undo again reconnects the output', await conns());
        await redo();
        await redo();
        b = await box();
        check(keys(b.ins).includes(IN) && !keys(b.outs).includes(OUT) && b.labels[IN] === 'Freq', 'redo prunes the output again', b);

        // Re-open, plug the virtual input inside, close: the same box port is connected from outside
        await page.mouse.dblclick(bc.x, bc.y);
        await sleep(900);
        r = await rows();
        check(r.scope === ids.g && r.ins.find(x => x.key === IN)?.virtual, 'reopened: the virtual input row is there', r);
        await drag(await rowPos('in', IN), await portScreen(ids.b, 'in', 0));
        await sleep(300);
        await page.click('.pt-crumb.is-root');
        await sleep(900);
        b = await box();
        const live = b.ins.find(p => p.key === IN);
        check((await conns()).includes(`${ids.a}.0>${ids.b}.0`) && live && live.linked && !live.kept && live.label === 'Freq' && b.linksIn.includes(IN),
            'after closing, the same box port is connected from outside, name kept', b);
        check(!keys(b.outs).includes(OUT), 'the output left unused stays pruned', b.outs);
    }

    // ---------------------------------------------------------------- virtual group inputs
    console.log('- virtual group inputs: drop a cable on a group box, keep it through close / save / copy, connect it inside; undo');
    {
        await fresh();
        await clickDo(`(() => { const g = window.toy.nodeGraph; const C = g.groupCtl.Connection; const c = g.groupCtl;
            window.__va = g.addNode('Float', 40, 160); window.__vf = g.addNode('Time', 40, 420); window.__vu = g.addNode('UV', 40, 560);
            window.__vb = g.addNode('Sin', 360, 160); window.__ve = g.addNode('Add', 360, 330); window.__vp = g.addNode('Preview', 760, 200);
            g.connections.push(new C(window.__va, 0, window.__vb, 0)); g.connections.push(new C(window.__vb, 0, window.__vp, 0)); g.onGraphChanged();
            const grp = c.createGroup({ name: 'Virt', nodes: [window.__vb, window.__ve], x: 340, y: 200 }); window.__vg = grp.id;
            c.touch(); c.changed(); })()`);
        await sleep(900);
        const ids = await ev(() => ({ a: window.__va.id, f: window.__vf.id, u: window.__vu.id, b: window.__vb.id, e: window.__ve.id, p: window.__vp.id, g: window.__vg }));
        const FK = `s:${ids.f}:0`, AK = `s:${ids.a}:0`;
        const conns = () => ev(() => window.toy.nodeGraph.connections.map(c => `${c.fromNode.id}.${c.fromOutput}>${c.toNode.id}.${c.toInput}`).sort());
        const virtuals = (gid = ids.g) => ev((gid) => (window.toy.nodeGraph.groupCtl.getGroup(gid)?.virtualInputs || []).map(v => `${v.node}:${v.port}`), gid);
        const box = (gid = ids.g) => ev((gid) => {
            const c = window.toy.nodeGraph.groupCtl; const v = c.view(); c.viewNodes(); const p = c.proxyFor(gid);
            if (!p || !v.proxies.includes(p)) return null;
            const port = (q) => ({ key: q.key, label: q.label, virtual: !!q.virtual, kept: !!q.kept, linked: !!q.linked });
            return {
                ins: p.inPorts.map(port),
                solidIn: v.ghosts.filter(gl => gl.dst === p && gl.solid).map(gl => ({ key: p.inPorts[gl.di]?.key, from: gl.src.id })),
                linksIn: v.links.filter(l => l.toNode === p).map(l => p.inPorts[l.toInput]?.key),
                labels: { ...(c.getGroup(gid).portLabels || {}) },
            };
        }, gid);
        const rows = () => ev(() => {
            const c = window.toy.nodeGraph.groupCtl; const v = c.view(); c.viewNodes();
            return { scope: c.scope, ins: v.inPanel.rows.filter(x => !x.expose).map(x => ({ key: x.key, label: x.label, virtual: !!x.virtual, kept: !!x.kept, live: x.conns.length > 0 })) };
        });
        const rowPos = (key) => ev((key) => {
            const c = window.toy.nodeGraph.groupCtl; const v = c.view(); c.viewNodes();
            const i = v.inPanel.indexOfKey(key); if (i < 0) return null;
            const p = v.inPanel.getOutputPortPosition(i);
            const g = window.toy.nodeGraph; const r = g.canvas.getBoundingClientRect();
            return { x: r.left + p.x * g.zoom + g.panX, y: r.top + p.y * g.zoom + g.panY };
        }, key);
        const boxPoint = (what) => ev(([gid, what]) => {
            const c = window.toy.nodeGraph.groupCtl; c.view(); c.viewNodes(); const p = c.proxyFor(gid);
            let pt;
            if (what === 'zone') pt = { x: p.x + 14, y: p.y + 40 + 6 };
            else if (what === 'center') { const m = p.minimapRect(); pt = { x: m.x + m.w / 2, y: m.y + m.h / 2 }; }
            else { const i = p.indexOfKey('in', what); pt = p.getInputPortPosition(i); }
            const g = window.toy.nodeGraph; const r = g.canvas.getBoundingClientRect();
            return { x: r.left + pt.x * g.zoom + g.panX, y: r.top + pt.y * g.zoom + g.panY, zone: what === 'zone' ? p.newInputZoneAt(pt.x, pt.y) : null };
        }, [ids.g, what]);
        const emptySpot = () => ev(() => {
            const g = window.toy.nodeGraph; const r = g.canvas.getBoundingClientRect();
            const items = g.groupCtl.viewNodes();
            for (let fy = 0.92; fy > 0.1; fy -= 0.04) for (let fx = 0.5; fx < 0.95; fx += 0.05) {
                const sx = r.width * fx, sy = r.height * fy;
                const wx = (sx - g.panX) / g.zoom, wy = (sy - g.panY) / g.zoom;
                if (!items.some(n => wx >= n.x - 30 && wx <= n.x + (n.width || 100) + 30 && wy >= n.y - 40 && wy <= n.y + (n.height || 60) + 30)) return { x: r.left + sx, y: r.top + sy };
            }
            return null;
        });
        const shader = async () => { await sleep(400); return ev((id) => window.toy.nodeGraph.nodes.find(n => n.id === id)?.lastCompiledShader?.fragment || null, ids.p); };

        // Drop Time's output on the box's "new input" zone (inputs column)
        const before = { conns: await conns(), glsl: await shader() };
        const zone = await boxPoint('zone');
        check(zone.zone === true, 'the inputs column of the box is the "new input" drop zone', zone);
        await drag(await portScreen(ids.f, 'out', 0), zone);
        await sleep(300);
        let b = await box();
        let fin = b.ins.find(p => p.key === FK);
        check((await virtuals()).includes(`${ids.f}:0`) && fin && fin.virtual && fin.linked, 'dropping a cable on the box adds a virtual input, connected from outside', b);
        check(b.solidIn.some(x => x.key === FK && x.from === ids.f), 'the outside cable is drawn to the new box input', b.solidIn);
        check(fin && fin.label === b.labels[FK] && /time/i.test(fin.label), 'the new input is named after its source (portLabels)', { fin, labels: b.labels });
        check(JSON.stringify(await conns()) === JSON.stringify(before.conns), 'no real connection is made', await conns());
        const after = await shader();
        check(before.glsl && after === before.glsl, 'compiled shader unchanged by the virtual input', { len: [before.glsl?.length, after?.length] });
        let h = await hist();
        check(h.undo[0] === 'Add input to “Virt”', 'one "Add input" step', h.undo.slice(0, 2));
        await undo();
        b = await box();
        check(!b.ins.some(p => p.key === FK) && !(await virtuals()).length && !b.labels[FK], 'undo removes the virtual input (and its name)', b);
        await redo();
        b = await box();
        check(b.ins.find(p => p.key === FK)?.virtual && b.labels[FK], 'redo brings it back', b);

        // Dropping on the box body opens the port picker, whose first item also makes a new input
        const pickerItems = async () => ev(() => [...document.querySelectorAll('.pt-group-picker .pt-menu-item')].map(e => e.textContent.trim()));
        await drag(await portScreen(ids.a, 'out', 0), await boxPoint('center'));
        await sleep(250);
        let items = await pickerItems();
        check(items.length && !items.some(t => /New input/.test(t)), 'no "New input" in the picker for a source that already feeds the group', items);
        await page.keyboard.press('Escape');
        await sleep(150);
        await drag(await portScreen(ids.u, 'out', 0), await boxPoint('center'));
        await sleep(250);
        items = await pickerItems();
        check(items.length && /New input/.test(items[0]), 'the port picker offers "New input" first', items);
        await page.click('.pt-group-picker .pt-menu-item');
        await sleep(300);
        b = await box();
        check(b.ins.find(p => p.key === `s:${ids.u}:0`)?.virtual, 'picking it adds a virtual input', b);
        await undo();
        b = await box();
        check(!b.ins.some(p => p.key === `s:${ids.u}:0`), 'undo removes it', b);

        // Save / load
        const reloaded = await ev((gid) => {
            const g = window.toy.nodeGraph;
            const data = JSON.parse(JSON.stringify(g.serialize()));
            g.deserialize(data);
            const c = g.groupCtl; c.view(); c.viewNodes();
            const p = c.proxyFor(gid);
            return { saved: data.groups.find(x => x.id === gid)?.virtualInputs, ports: p.inPorts.map(q => ({ key: q.key, virtual: !!q.virtual, linked: !!q.linked, label: q.label })) };
        }, ids.g);
        check(reloaded.saved && reloaded.saved.some(v => v.node === ids.f && v.port === 0) && reloaded.ports.some(q => q.key === FK && q.virtual && q.linked),
            'virtual inputs are saved in the project and come back on load', reloaded);
        await ev(() => window.toy.history.reset());

        // Open the group: a "From outside" row that feeds nothing yet; close: still there
        const bc = await boxPoint('center');
        await page.mouse.dblclick(bc.x, bc.y);
        await sleep(900);
        let r = await rows();
        const frow = r.ins.find(x => x.key === FK);
        check(r.scope === ids.g && frow && frow.virtual && !frow.live && !frow.kept, 'inside, the virtual input is a "From outside" row with no inner cable', r);
        await page.click('.pt-crumb.is-root');
        await sleep(900);
        b = await box();
        check(b.ins.find(p => p.key === FK)?.virtual && (await virtuals()).includes(`${ids.f}:0`), 'closing the group keeps the virtual input (it has an outside cable)', b);
        check(!(await hist()).undo.length, 'opening / closing made no undo step', (await hist()).undo);

        // Connect it inside: drag from its row to Add.a -> a normal port
        await page.mouse.dblclick(bc.x, bc.y);
        await sleep(900);
        await drag(await rowPos(FK), await portScreen(ids.e, 'in', 0));
        await sleep(300);
        r = await rows();
        check((await conns()).includes(`${ids.f}.0>${ids.e}.0`) && r.ins.find(x => x.key === FK)?.live && !r.ins.find(x => x.key === FK)?.virtual && !(await virtuals()).length,
            'connecting the virtual row inside makes it a normal port', { r, v: await virtuals() });
        // Fan-out from the same row still works
        await drag(await rowPos(FK), await portScreen(ids.e, 'in', 1));
        await sleep(300);
        let cs = await conns();
        check(cs.includes(`${ids.f}.0>${ids.e}.0`) && cs.includes(`${ids.f}.0>${ids.e}.1`) && (await rows()).ins.filter(x => x.key === FK).length === 1, 'fan-out from the row feeds a second inner input (one row)', cs);
        await undo();
        await undo();
        r = await rows();
        check(!(await conns()).includes(`${ids.f}.0>${ids.e}.0`) && r.ins.find(x => x.key === FK)?.virtual && (await virtuals()).includes(`${ids.f}:0`),
            'undo makes it virtual again', { r, v: await virtuals() });
        await redo();
        r = await rows();
        check((await conns()).includes(`${ids.f}.0>${ids.e}.0`) && !(await virtuals()).length && r.ins.find(x => x.key === FK)?.live, 'redo makes it normal again', r);

        // Disconnect inside: the outside cable and the box port stay
        await drag(await portScreen(ids.e, 'in', 0), await emptySpot());
        await sleep(300);
        r = await rows();
        check(r.ins.find(x => x.key === FK)?.virtual && (await virtuals()).includes(`${ids.f}:0`), 'unplugging its last inner cable makes it virtual again', r);
        await page.click('.pt-crumb.is-root');
        await sleep(900);
        b = await box();
        check(b.ins.find(p => p.key === FK)?.virtual && b.solidIn.some(x => x.key === FK && x.from === ids.f), 'outside: the port and its cable are still there', b);

        // Pull the outside cable off a virtual box input (dropped on empty canvas): no cable on either side, the port goes
        await drag(await boxPoint(FK), await emptySpot());
        await sleep(300);
        b = await box();
        check(!b.ins.some(p => p.key === FK) && !(await virtuals()).length, 'unplugging the outside cable of a virtual input removes the port', b);
        await undo();
        b = await box();
        check(b.ins.find(p => p.key === FK)?.virtual, 'undo puts it back', b);

        // A row with no cable on either side stays while open, removed on close: add an input
        // from outside, connect it inside, then undo both while the group is open
        await drag(await boxPoint(FK), await emptySpot());          // (no input from Time)
        await sleep(300);
        await drag(await portScreen(ids.f, 'out', 0), await boxPoint('zone')); // step: add it again
        await sleep(300);
        await page.mouse.dblclick(bc.x, bc.y);
        await sleep(900);
        await drag(await rowPos(FK), await portScreen(ids.e, 'in', 0)); // step: connect it inside
        await sleep(300);
        await undo(); // virtual again
        await undo(); // no input from Time at all
        r = await rows();
        const krow = r.ins.find(x => x.key === FK);
        check(krow && krow.kept && !krow.virtual && !krow.live, 'with no cable on either side the row stays while the group is open (kept)', r);
        await page.click('.pt-crumb.is-root');
        await sleep(900);
        b = await box();
        check(!b.ins.some(p => p.key === FK) && b.ins.some(p => p.key === AK), 'closing the group removes the port with no cable on either side (others stay)', b);
        h = await hist();
        check(h.undo[0] === 'Remove unused group ports', '"Remove unused group ports" step', h.undo.slice(0, 3));

        // Copy / paste a group with its virtual input's source: remapped; without it: not pasted
        await clickDo(`(() => { const c = window.toy.nodeGraph.groupCtl; c.addVirtualInput(${JSON.stringify(ids.g)}, window.toy.nodeGraph.nodes.find(n => n.id === ${ids.f}), 0); c.changed(); })()`);
        await sleep(300);
        const pasted = await ev(([gid, fid]) => {
            const g = window.toy.nodeGraph; const c = g.groupCtl; c.view();
            const sel = g.selectionManager.selectedNodes;
            const res = {};
            for (const withSrc of [true, false]) {
                sel.clear(); sel.add(c.proxyFor(gid)); if (withSrc) sel.add(g.nodes.find(n => n.id === fid));
                g.copySelectedNodes(); const n0 = c.groups.length; g.pasteNodes();
                const grp = c.groups[c.groups.length - 1];
                const newF = withSrc ? g.nodes.filter(n => n.type === 'Time' && n.id !== fid).pop() : null;
                res[withSrc ? 'with' : 'without'] = { added: c.groups.length - n0, virtual: grp.virtualInputs || null, srcType: newF && newF.type, srcId: newF && newF.id, origF: fid };
            }
            return res;
        }, [ids.g, ids.f]);
        const w = pasted.with;
        check(w.added === 1 && w.virtual && w.virtual.length === 1 && w.virtual[0].node !== ids.f && w.virtual[0].node === w.srcId,
            'pasting a group with its virtual input source remaps the virtual input', pasted);
        check(pasted.without.added === 1 && !pasted.without.virtual, 'pasting it without the source drops it (like an outside cable)', pasted);

        // Deleting the inner node an input fed, inside the group: the input stays patched from outside
        await ev((gid) => { const g = window.toy.nodeGraph; g.selectionManager.selectedNodes.clear(); g.groupCtl.setScope(gid, { animate: false }); }, ids.g);
        await sleep(300);
        await ev((id) => { const g = window.toy.nodeGraph; g.selectionManager.selectedNodes.clear(); g.selectionManager.selectedNodes.add(g.nodes.find(n => n.id === id)); }, ids.b);
        await page.mouse.move(300, 300);
        await page.keyboard.press('Delete');
        await sleep(800); // (a key edit is recorded after the typing debounce)
        r = await rows();
        check(!(await nodesInfo()).some(n => n.id === ids.b) && r.ins.find(x => x.key === AK)?.virtual && (await virtuals()).includes(`${ids.a}:0`),
            'deleting the inner consumer inside leaves the input patched from outside', r);
        await undo();
        r = await rows();
        check((await conns()).includes(`${ids.a}.0>${ids.b}.0`) && r.ins.find(x => x.key === AK)?.live && !(await virtuals()).includes(`${ids.a}:0`),
            'undo brings the node and its cable back, in one step with the virtual input', r);

        // Nested: a virtual input of an inner group shows on the outer box too, cable attached
        await ev(() => window.toy.nodeGraph.groupCtl.setScope(null, { animate: false }));
        await clickDo(`(() => { const g = window.toy.nodeGraph; const c = g.groupCtl;
            const inner = c.createGroup({ name: 'Inner', parentId: ${JSON.stringify(ids.g)}, nodes: [g.nodes.find(n => n.id === ${ids.e})], x: 0, y: 0 });
            window.__vin = inner.id; c.addVirtualInput(inner.id, g.nodes.find(n => n.id === ${ids.u}), 0); c.changed(); })()`);
        await sleep(300);
        const UK = `s:${ids.u}:0`;
        b = await box();
        check(b.ins.find(p => p.key === UK)?.virtual && b.solidIn.some(x => x.key === UK && x.from === ids.u), 'the outer box shows an inner group\'s virtual input', b);
        await ev((gid) => window.toy.nodeGraph.groupCtl.setScope(gid, { animate: false }), ids.g);
        await sleep(300);
        const nested = await ev((uid) => {
            const c = window.toy.nodeGraph.groupCtl; const v = c.view(); c.viewNodes(); const p = c.proxyFor(window.__vin);
            const row = v.inPanel.rows.find(x => x.key === `s:${uid}:0`);
            return { row: row && { virtual: row.virtual, linked: row.linked }, solid: v.ghosts.filter(gl => gl.solid && gl.dst === p).length };
        }, ids.u);
        check(nested.row && nested.row.linked && nested.solid === 1, 'inside the outer group: its row is cabled to the inner box', nested);
        await ev(() => window.toy.nodeGraph.groupCtl.setScope(null, { animate: false }));
    }

    // ---------------------------------------------------------------- custom GLSL node
    console.log('- custom GLSL node create / update / delete');
    await fresh();
    const V1 = 'vec3 histWave(vec2 uv) { return vec3(uv, 0.0); }';
    const V2 = 'vec3 histWave(vec2 uv) { return vec3(uv.yx, 1.0); }';
    await clickDo(`(() => { const r = window.toy.createCustomNode('histWave', ${JSON.stringify(V1)}); window.__cn = window.toy.nodeGraph.addNode('histWave', 200, 200); return r; })()`);
    await sleep(300);
    h = await hist();
    check(/Create custom node histWave/.test(h.undo[0]), 'create custom node + instance is one step', h.undo[0]);
    const cnId = await ev(() => window.__cn.id);
    await clickDo(`window.toy.createCustomNode('histWave', ${JSON.stringify(V2)})`);
    await sleep(300);
    h = await hist();
    check(/Update custom node histWave/.test(h.undo[0]), 'update is a step', h.undo[0]);
    await spyCompiles();
    await undo();
    const glslNow = () => ev(async () => (await import('/src/core/NodeDefinitions.js')).NodeDefinitions.histWave?.customGLSL || null);
    check(/uv, 0\.0/.test(await glslNow() || ''), 'undo restores the previous GLSL', await glslNow());
    check(await ev((id) => window.toy.nodeGraph.nodes.some(n => n.id === id && n.type === 'histWave'), cnId), 'the instance survives with its id');
    check(await compiles() > 0, 'custom node undo recompiles');
    await undo();
    check(await ev(() => !window.toy.nodeGraph.nodes.some(n => n.type === 'histWave')), 'undo create removes the instance');
    check(await glslNow() === null, 'undo create removes the definition too');
    await redo();
    check(await ev((id) => window.toy.nodeGraph.nodes.some(n => n.id === id && n.type === 'histWave'), cnId), 'redo re-creates definition and instance');

    // ---------------------------------------------------------------- open code editors follow undo / redo
    console.log('- open code editors follow undo / redo');
    // State now: histWave = V1, the update to V2 is on the redo stack
    await ev(async () => {
        const { NodeDialogs } = await import('/src/ui/NodeDialogs.js');
        const { NodeDefinitions } = await import('/src/core/NodeDefinitions.js');
        const node = window.toy.nodeGraph.nodes.find(n => n.type === 'histWave');
        window.__ed = NodeDialogs.showEditNodeDialog(node, NodeDefinitions.histWave, (type, glsl) => { window.toy.createCustomNode(type, glsl); return undefined; });
    });
    const edState = () => ev(() => {
        const e = window.__ed;
        return { text: e.getValue(), dirty: !!e.isDirty, notice: !!(e.noticeBar && !e.noticeBar.hidden), noticeText: e.noticeText ? e.noticeText.textContent : '', open: document.body.contains(e.window) };
    });
    let es = await edState();
    check(es.open && /uv, 0\.0/.test(es.text) && !es.dirty, 'GLSL editor opened on the current definition', es);
    await redo();
    es = await edState();
    check(/uv\.yx, 1\.0/.test(es.text) && !es.dirty && !es.notice, 'redo refreshes a clean editor to the new GLSL', es);
    await ev(() => { window.__ed.editor.setValue('vec3 histWave(vec2 uv) { return vec3(0.5); }'); window.__ed.updateDirtyState(); });
    await undo();
    es = await edState();
    check(/vec3\(0\.5\)/.test(es.text) && es.dirty && es.notice && /outside the editor/.test(es.noticeText), 'undo with unsaved edits keeps them and marks "changed outside the editor"', es);
    await ev(() => window.__ed.reloadFromSource());
    es = await edState();
    check(/uv, 0\.0/.test(es.text) && !es.dirty && !es.notice, 'Reload takes the undone GLSL (no stale text to save)', es);
    await ev(() => window.__ed.close());
    // JS editor whose node an undo removes: says so, Save refused
    await fresh();
    await clickDo(`(() => { window.__jsE = window.toy.nodeGraph.addNode('JS', 300, 300); })()`);
    await sleep(300);
    const jsOk = await ev(() => !!window.__jsE && !!window.__jsE.isJSNode);
    if (jsOk) {
        await ev(() => { window.__ed = window.__jsE.openEditor(); });
        await undo();
        es = await edState();
        check(es.notice && /no longer exists/.test(es.noticeText), 'undo removing a JS node: its open editor says the node is gone', es);
        const n0 = await ev(() => window.toy.nodeGraph.nodes.length);
        await ev(() => { window.__ed.editor.setValue('return { v: 1 };'); window.__ed.updateDirtyState(); window.__ed.save(); });
        check(await ev(() => window.toy.nodeGraph.nodes.length) === n0 && await ev(() => document.body.contains(window.__ed.window)), 'Save into a removed node is refused (editor stays open)');
        await redo();
        es = await edState();
        check(!es.notice || !/no longer exists/.test(es.noticeText), 'redo brings the node back: the notice goes away', es);
        await ev(() => window.__ed.close());
    }

    // ---------------------------------------------------------------- JS trust + live state
    console.log('- JS code restore never grants trust; live state kept');
    await fresh();
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__js = g.addNode('JS', 200, 200); window.__fb = g.addNode('Feedback', 200, 450); })()`);
    await sleep(300);
    const hasJS = await ev(() => !!window.__js && !!window.__js.isJSNode);
    if (hasJS) {
        // "Someone else's" code arrives (as from a shared project / MCP set_node_data), untrusted
        await clickDo(`(() => { const n = window.__js; n.data.code = 'return 0.123456; // foreign'; n.rebuildTextInputs(); window.toy.nodeGraph.onGraphChanged(); })()`);
        await sleep(600);
        // The user edits it in this browser (editor save trusts it)
        await clickDo(`(async () => { const { jsRuntime } = await import('/src/nodes/jsRuntime.js'); const n = window.__js; n.data.code = 'return 0.5; // mine'; jsRuntime.trustNode(n); window.toy.nodeGraph.onGraphChanged(); })()`);
        await sleep(700);
        await ev(() => { window.__js.state.keep = 42; });
        // The trust prompt for the foreign code is a modal: undo waits for it to close
        await sleep(300);
        check(await ev(() => !!document.querySelector('.pt-modal-backdrop')), 'foreign JS code raised the trust prompt');
        await undo();
        check(/mine/.test(await ev(() => window.__js.data.code)), '⌘Z does nothing while a modal is open');
        await ev(() => document.querySelectorAll('.pt-modal-backdrop').forEach(e => e.remove()));
        await undo();
        await sleep(300);
        const tr = await ev(async () => { const { jsRuntime } = await import('/src/nodes/jsRuntime.js'); const n = window.__js; return { code: n.data.code, trust: n.trust, trusted: jsRuntime.isTrusted(n), same: window.toy.nodeGraph.nodes.includes(n) }; });
        check(/foreign/.test(tr.code) && tr.trust !== 'trusted' && !tr.trusted && tr.same, 'undo restores the foreign code without trusting it', tr);
        await redo();
        const tr2 = await ev(async () => { const n = window.__js; await new Promise(r => setTimeout(r, 200)); return { code: n.data.code, trust: n.trust }; });
        check(/mine/.test(tr2.code) && tr2.trust === 'trusted', 'redo: the user\'s own code is trusted again (it is on the trust list)', tr2);
        // Position undo keeps JS state and Feedback buffers
        await ev(() => { window.__fbBuf = window.__fb.framebuffers || window.__fb.textures || window.__fb.fboA || null; window.__js.state.keep = 42; window.__jsState = window.__js.state; });
        await clickDo(`(() => { window.__js.x += 80; window.__fb.x += 80; })()`);
        await sleep(200);
        await undo();
        const live = await ev(() => ({ js: window.__js.state === window.__jsState && window.__js.state.keep === 42, fb: window.toy.nodeGraph.nodes.includes(window.__fb) && (window.__fb.framebuffers || window.__fb.textures || window.__fb.fboA || null) === window.__fbBuf }));
        check(live.js && live.fb, 'JS state and Feedback buffers survive undo', live);
    }

    // ---------------------------------------------------------------- MIDI mapping undo keeps the live value
    console.log('- MIDI: undo a mapping, the MIDI-driven value stays; MIDI values are no steps');
    await fresh();
    await clickDo(`(() => { const g = window.toy.nodeGraph; window.__gain = g.addNode('Param', 200, 200); window.__gain.data.label = 'Gain'; window.__gain.data.value = 0.25; window.__gain.rebuildTextInputs(); g.onGraphChanged(); })()`);
    await sleep(700);
    const midi = await ev(async () => {
        const { AutomationAPI } = await import('/src/automation/AutomationAPI.js');
        const api = window.__api || (window.__api = new AutomationAPI(window.toy, { headless: true, agentName: 'Claude' }));
        const H = window.toy.history, n = window.__gain;
        const r = { methods: AutomationAPI.METHODS.includes('midiMap') };
        if (!r.methods) return r;
        await api.handle('midiMap', { param: n.id, type: 'cc', number: 21, channel: 1, options: { pickup: false } });
        r.mapped = !!(n.data.midi && n.data.midi.length);
        r.afterMap = H.list().undo.slice(0, 2);
        await api.handle('simulateMidi', { status: 176, data1: 21, data2: 127 });
        r.valueAfterMidi = n.data.value;
        r.afterMidi = H.list().undo.slice(0, 2);
        H.undo({ toast: false });
        r.mappedAfterUndo = !!(n.data.midi && n.data.midi.length);
        r.valueAfterUndo = n.data.value;
        H.redo({ toast: false });
        r.mappedAfterRedo = !!(n.data.midi && n.data.midi.length);
        r.valueAfterRedo = n.data.value;
        // MCP undo / redo / history
        r.hist = (await api.handle('getHistory', {})).undo.slice(0, 2);
        r.mcpUndo = await api.handle('undo', {});
        r.mcpRedo = await api.handle('redo', {});
        return r;
    });
    if (midi.methods) {
        check(midi.mapped && /MIDI/.test(midi.afterMap[0] || ''), 'midi_map is an undo step', midi.afterMap);
        check(Math.abs(midi.valueAfterMidi - 0.25) > 0.1 && midi.afterMidi[0] === midi.afterMap[0] && midi.afterMidi.length === midi.afterMap.length, 'simulate_midi changes the value without an undo step', midi);
        check(!midi.mappedAfterUndo && Math.abs(midi.valueAfterUndo - midi.valueAfterMidi) < 1e-9, 'undoing the mapping keeps the MIDI-driven value', midi);
        check(midi.mappedAfterRedo && Math.abs(midi.valueAfterRedo - midi.valueAfterMidi) < 1e-9, 'redo restores the mapping, value still kept', midi);
        check(midi.hist[0] === midi.afterMap[0] && midi.mcpUndo.undone.length === 1 && midi.mcpRedo.redone.length === 1, 'MCP getHistory / undo / redo', { hist: midi.hist, u: midi.mcpUndo, r: midi.mcpRedo });
    } else {
        console.log('    (MIDI automation not present; skipped)');
    }

    // ---------------------------------------------------------------- batch (MCP) + load clears
    console.log('- batch = one step; load clears history');
    await fresh();
    await ev(() => {
        const t = window.toy, g = t.nodeGraph;
        t.history.beginBatch({ prefix: 'Claude', label: 'Build graph' });
        const a = g.addNode('UV', 0, 0), b = g.addNode('Sin', 200, 0), c = g.addNode('Preview', 400, 0);
        g.connections.push(new g.groupCtl.Connection(a, 0, c, 0));
        g.onGraphChanged();
        t.history.endBatch();
    });
    h = await hist();
    check(h.undo.length === 1 && h.undo[0] === 'Claude: Build graph', 'beginBatch/endBatch = one labelled step', h.undo);
    await undo();
    check(await ev(() => window.toy.nodeGraph.nodes.length) === 0, 'undo the batch');
    await redo();
    const medley = fs.readFileSync(path.join(REPO_ROOT, 'projects/scene-medley.patchtoy.json'), 'utf8');
    await ev(async (json) => { await window.toy.openProjectFile(new File([json], 'scene-medley.patchtoy.json', { type: 'application/json' })); }, medley);
    await sleep(800);
    h = await hist();
    check(h.undo.length === 0 && h.redo.length === 0, 'opening a project clears the history', h);

    // ---------------------------------------------------------------- measurements (scene-medley)
    console.log('- measurements on scene-medley');
    const m = await ev(() => {
        const H = window.toy.history, g = window.toy.nodeGraph;
        const N = 40;
        let t0 = performance.now();
        for (let i = 0; i < N; i++) H.snapshot();
        const snapMs = (performance.now() - t0) / N;
        const s1 = H.snapshot();
        t0 = performance.now();
        for (let i = 0; i < N; i++) H.diff(H.base, s1);
        const diffMs = (performance.now() - t0) / N;
        let chars = 0;
        for (const s of H.base.nodes.values()) chars += s.length;
        for (const s of H.base.groups.values()) chars += s.length;
        for (const k of H.base.conns) chars += k.length;
        // A "move 3 nodes" step
        const three = g.nodes.slice(0, 3);
        H.flush();
        t0 = performance.now();
        three.forEach(n => { n.x += 10; });
        const step = H.capture({ label: 'measure move' });
        const captureMs = performance.now() - t0;
        t0 = performance.now();
        H.undo({ toast: false });
        const undoMs = performance.now() - t0;
        const undoCompiled = H.stats.lastCompile;
        // Worst case: delete everything (one step holding every node)
        H.flush();
        const all = [...g.nodes];
        t0 = performance.now();
        g.selectionManager.selectedNodes = new Set(all);
        g.deleteSelectedNodes({ groupContents: true });
        const del = H.capture({ label: 'measure delete all' });
        const delMs = performance.now() - t0;
        t0 = performance.now();
        H.undo({ toast: false });
        const restoreAllMs = performance.now() - t0;
        return {
            nodes: g.nodes.length, conns: g.connections.length, groups: g.groups.length,
            snapshotMs: +snapMs.toFixed(3), diffMs: +diffMs.toFixed(3), baseChars: chars,
            moveStepBytes: step && step.bytes, captureMs: +captureMs.toFixed(3), undoMoveMs: +undoMs.toFixed(2), undoCompiled,
            deleteAllStepBytes: del && del.bytes, deleteAllCaptureMs: +delMs.toFixed(1), restoreAllMs: +restoreAllMs.toFixed(1),
        };
    });
    console.log('    ', JSON.stringify(m));
    check(m.nodes > 600 && m.snapshotMs < 15, 'snapshot of ~700 nodes is fast', m.snapshotMs);
    check(m.moveStepBytes < 6000, 'a 3-node move step stores only those nodes', m.moveStepBytes);
    check(m.undoCompiled === false, 'move undo on scene-medley does not recompile');
    check(await ev(() => window.toy.nodeGraph.nodes.length) === m.nodes, 'delete-all undo restores every node');

    // ---------------------------------------------------------------- memory cap
    console.log('- memory cap');
    const cap = await ev(() => {
        const H = window.toy.history, g = window.toy.nodeGraph;
        H.flush();
        for (let i = 0; i < 130; i++) { g.nodes[i % g.nodes.length].x += 1; H.capture({ label: 'm' + i, mergeable: false }); }
        const count = H.undoStack.length;
        const saved = H.maxBytes;
        H.maxBytes = 200 * 1024;
        for (let i = 0; i < 6; i++) {
            const all = [...g.nodes];
            all.forEach(n => { n.y += 1; });
            H.capture({ label: 'big' + i, mergeable: false });
        }
        const r = { count, bytesAfterCap: H.memoryBytes(), stepsAfterCap: H.undoStack.length, maxBytes: H.maxBytes };
        H.maxBytes = saved;
        return r;
    });
    check(cap.count === 100, 'at most 100 steps', cap);
    check(cap.bytesAfterCap <= cap.maxBytes || cap.stepsAfterCap === 1, 'byte cap drops the oldest steps', cap);

    check(errors.length === 0, 'no console errors', errors.slice(0, 8));
} catch (err) {
    failures++;
    console.log(`  FAIL unexpected error: ${err.stack || err.message}`);
} finally {
    await browser.close();
    if (vite) await vite.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
