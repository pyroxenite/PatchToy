/**
 * Error attribution for the per-frame work (main.js animation loop, RenderLoop).
 *
 *   loopTrace.node     the node a phase is working on right now. The per-node loops
 *                      (Param ticks, SceneSwitchers, Feedback passes) set it before each
 *                      node: a plain field write, nothing to undo. When a phase throws,
 *                      the node it was on is the one to blame.
 *   loopErrors         report(phase, node, error): one console warning per phase + node +
 *                      message every REPORT_MS at most (with the count in between), and a
 *                      bounded list for diagnostics (window.toy.loopErrors.list()).
 */
export const loopTrace = { node: null };

const REPORT_MS = 5000;
const MAX_KEYS = 50;

class LoopErrorLog {
    constructor() {
        this.entries = new Map();
    }

    report(phase, node, error) {
        const message = String(error && error.message ? error.message : error);
        const key = `${phase}|${node ? node.id : ''}|${message}`;
        const now = performance.now();
        let e = this.entries.get(key);
        if (!e) {
            if (this.entries.size >= MAX_KEYS) this.entries.delete(this.entries.keys().next().value);
            e = {
                phase, message,
                node_id: node ? node.id : null,
                node_type: node ? node.type : null,
                count: 0, unreported: 0, first_ms: now, last_ms: now, reported_ms: -Infinity
            };
            this.entries.set(key, e);
        }
        e.count++;
        e.unreported++;
        e.last_ms = now;
        if (now - e.reported_ms < REPORT_MS) return e;
        const where = node ? ` at node #${node.id} (${node.type})` : '';
        const times = e.unreported > 1 ? ` [${e.unreported}x since the last report]` : '';
        console.warn(`[loop] ${phase} failed${where}: ${message}${times}`, error);
        e.reported_ms = now;
        e.unreported = 0;
        return e;
    }

    /** Most recent first: { phase, node_id, node_type, message, count, age_ms }. */
    list() {
        const now = performance.now();
        return [...this.entries.values()]
            .sort((a, b) => b.last_ms - a.last_ms)
            .map(e => ({ phase: e.phase, node_id: e.node_id, node_type: e.node_type, message: e.message, count: e.count, age_ms: Math.round(now - e.last_ms) }));
    }

    clear() {
        this.entries.clear();
    }
}

export const loopErrors = new LoopErrorLog();
