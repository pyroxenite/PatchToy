/**
 * When onboarding UI (the first-run tour) may appear.
 *
 * The tour never starts by itself in automated sessions:
 *   ?tour=off                    always off (tests, embeds, demos on stage)
 *   ?bridge / ?bridge=… / ?bridgeToken / sessionStorage patchtoy_bridge_params
 *                                MCP-driven pages (src/automation/BridgeClient.js)
 *   ?headless=1, navigator.webdriver
 *                                headless / automated browsers (MCP, e2e, visual tests)
 *   routes other than the editor share links /p/<id>, user pages /u/<name>, /explore
 * ?tour=on (or ?tour=1) starts it regardless (QA, docs screenshots), except on ?tour=off.
 * A connected MCP bridge also closes a running tour (HelpCenter).
 */
import { parseRoute } from '../../core/router.js';

export const TOUR_DONE_KEY = 'patchtoy_tour_done';

function params() {
    try { return new URLSearchParams(window.location.search); } catch (e) { return new URLSearchParams(); }
}

/** 'on' | 'off' | null (no explicit flag). */
export function tourFlag() {
    const v = (params().get('tour') || '').toLowerCase();
    if (v === 'off' || v === '0' || v === 'false' || v === 'no') return 'off';
    if (params().has('tour') && (v === '' || v === 'on' || v === '1' || v === 'true' || v === 'force')) return 'on';
    return null;
}

/** True for MCP / headless / automated sessions. */
export function isAutomatedSession() {
    const q = params();
    if (q.has('bridge') || q.has('bridgeToken') || q.get('headless') === '1') return true;
    try { if (sessionStorage.getItem('patchtoy_bridge_params')) return true; } catch (e) { /* ignore */ }
    try { if (navigator.webdriver) return true; } catch (e) { /* ignore */ }
    return false;
}

export function tourDone() {
    try { return localStorage.getItem(TOUR_DONE_KEY) !== null; } catch (e) { return true; }
}

export function markTourDone(how = 'done') {
    try { localStorage.setItem(TOUR_DONE_KEY, JSON.stringify({ how, at: Date.now() })); } catch (e) { /* ignore */ }
}

export function resetTour() {
    try { localStorage.removeItem(TOUR_DONE_KEY); } catch (e) { /* ignore */ }
}

/**
 * Should the tour start by itself on this page load?
 * `firstRun` = no saved graph before this load (a brand-new profile).
 */
export function shouldAutoStartTour({ firstRun = false } = {}) {
    const flag = tourFlag();
    if (flag === 'off') return false;
    const route = parseRoute();
    if (route.name === 'project' || route.name === 'user') return false;
    if (flag === 'on') return true;
    if (isAutomatedSession()) return false;
    if (route.name !== 'home') return false;
    if (tourDone()) return false;
    return firstRun;
}

/** Manual starts (Help menu, empty canvas) are allowed everywhere except ?tour=off. */
export function tourAllowed() {
    return tourFlag() !== 'off';
}
