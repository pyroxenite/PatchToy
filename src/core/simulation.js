/**
 * Simulation state shared by everything that has to restart a patch from a clean,
 * reproducible state, and the per-project runtime state a project switch must drop.
 *
 *   resetSimulation(graph, gl)    Feedback buffers cleared, control-rate node state
 *                                 (Lag, Counter, Spring, Random, Delay...), JS node state
 *                                 (setup re-run), the audio-texture history. Offline export
 *                                 "from start" (src/output/OfflineExporter.js) and the
 *                                 render_preview warm-up (AutomationAPI) use it.
 *   settleSwitchers(graph)        SceneSwitchers start settled on data.current (no pending
 *                                 auto switch or transition); returns restore() for the live show.
 *   resetProjectRuntime(app)      A project is replaced (load, New project): forget the live
 *                                 uniform values, the control plan, JS runtime bookkeeping and
 *                                 the audio-texture history of the previous project.
 */
import { controlRuntime } from './control/ControlRuntime.js';
import { jsRuntime } from '../nodes/jsRuntime.js';
import { audioTextures } from '../services/AudioTextures.js';
import { midiMapper } from '../services/MidiMapper.js';

/** SceneSwitcher runtime fields (besides data.current / state) that drive auto mode and transitions. */
export const SWITCHER_FIELDS = ['_pending', '_lastSceneInput', '_lastNextInput', '_lastBar', '_sinceSwitch', '_lastTime'];

/** Clear both buffers of every Feedback node to transparent black. */
export function clearFeedbackBuffers(graph, gl) {
    if (!gl || !graph) return;
    for (const n of graph.nodes) {
        if (!n.isFeedbackNode) continue;
        for (const b of [n.readBuffer, n.writeBuffer]) {
            if (!b || !b.framebuffer) continue;
            gl.bindFramebuffer(gl.FRAMEBUFFER, b.framebuffer);
            gl.viewport(0, 0, n.bufferWidth || 1, n.bufferHeight || 1);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * Restart the simulation. js: JS nodes get a fresh `state` and their setup runs again
 * (async: tick until settled, see waitForJSSetup); false keeps what setup produced.
 */
export function resetSimulation(graph, gl, { js = true, feedback = true, audio = true } = {}) {
    if (feedback) clearFeedbackBuffers(graph, gl);
    try { controlRuntime.resetState(graph); } catch (e) { /* ignore */ }
    // Sample nodes (GPU -> control) start from 0 too, not from the live readback: their
    // first value is the frame-0 readback, one frame later (src/rendering/ProbeRenderer.js)
    for (const n of (graph && graph.nodes) || []) if (n.probeAlways) n._sampleRGBA = null;
    controlRuntime.lastTime = null;
    jsRuntime.lastTime = null;
    if (js && graph) {
        for (const n of graph.nodes) {
            if (!n.isJSNode) continue;
            n._setupFor = undefined; // next frame: state = {} and setup runs again
            n._setupToken = null;
            // pending until that setup ran (pendingJSSetup): a caller priming frames until JS
            // setup settled must not see the 'ready' of the previous run
            if (n.setupState === 'ready' || n.setupState === 'running') n.setupState = 'idle';
        }
    }
    if (audio) {
        try { audioTextures.reset(); } catch (e) { /* ignore */ }
    }
}

/** Trusted JS nodes whose setup has not settled yet. */
export function pendingJSSetup(graph) {
    return graph.nodes.filter(n => n.isJSNode && n.trust === 'trusted' && !['ready', 'error'].includes(n.setupState));
}

/**
 * Settle every SceneSwitcher on its current scene (auto mode counts from here, no transition
 * in flight). Returns restore(): puts the live runtime state back.
 */
export function settleSwitchers(graph) {
    const snaps = graph.nodes.filter(n => n.isSceneSwitcher).map(sw => {
        const snap = { sw, current: sw.data.current, state: { ...sw.state } };
        for (const k of SWITCHER_FIELDS) snap[k] = sw[k];
        return snap;
    });
    for (const { sw, current } of snaps) {
        sw.state = { ...sw.state, a: current, b: current, p: 0, active: false };
        sw._pending = null;
        sw._lastSceneInput = undefined;
        sw._lastNextInput = undefined;
        sw._lastBar = undefined;
        sw._sinceSwitch = 0;
        sw._lastTime = null;
        try { sw.pushUniforms?.(true); } catch (e) { /* ignore */ }
    }
    return function restore() {
        for (const snap of snaps) {
            const { sw } = snap;
            sw.data.current = snap.current;
            sw.state = snap.state;
            for (const k of SWITCHER_FIELDS) sw[k] = snap[k];
            try { sw.pushUniforms?.(true); } catch (e) { /* ignore */ }
        }
    };
}

/**
 * A project is being replaced (NodeGraph.deserialize, New project). The old nodes are
 * disposed by NodeGraph.disposeNodes; this drops the state keyed by names / ids that the
 * next project reuses: live uniform values (node_N names are compact indices, so a stale
 * value of another type would be applied to the new project's uniform until the next
 * compile finishes), the cached control plan, JS runtime bookkeeping, MIDI mapping runtime
 * state (pickup, slew, learn), audio-texture history.
 */
export function resetProjectRuntime(graph) {
    if (!graph) return;
    try { graph.uniformRegistry?.clear?.(); } catch (e) { /* ignore */ }
    graph._controlPlan = null;
    controlRuntime.lastTime = null;
    try { jsRuntime.resetProject?.(); } catch (e) { /* ignore */ }
    try { midiMapper.resetProject(); } catch (e) { /* ignore */ }
    try { audioTextures.reset(); } catch (e) { /* ignore */ }
}
