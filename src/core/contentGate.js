import { UIHelpers } from '../ui/UIHelpers.js';

/**
 * Remote media consent (security review M9).
 *
 * A project opened from Community, a user page or a share link that isn't yours
 * can't make this browser contact other websites on open (Video URL nodes, image
 * Params from a URL): those hosts would learn your IP address, browser and when you
 * opened it. Such loads wait here until you agree ("This project loads media from
 * other websites"). Your own projects, files you open and media you add yourself load
 * directly.
 *
 * ProjectManager switches the gate per opened project (setRestricted).
 */
class ContentGate {
    constructor() {
        this.restricted = false;
        this.allowed = true;
        /** owner (node) -> { url, load } */
        this.pending = new Map();
        this.prompting = false;
        this.timer = null;
        /** Another consent prompt is open (jsRuntime sets this): ask after it. */
        this.isBusy = () => false;
        this.listeners = new Set();
    }

    isRemote(url) {
        try {
            const u = new URL(String(url), window.location.href);
            return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== window.location.origin;
        } catch (e) {
            return false;
        }
    }

    /** Restrict remote media for the project being opened (true), or lift it (false: loads what waits). */
    setRestricted(on) {
        this.restricted = !!on;
        this.allowed = !on;
        if (on) {
            this.pending.clear();
        } else {
            this.flush();
        }
        this.emit();
    }

    /**
     * Load now (returns true), or once the user agrees (returns false). One pending
     * load per owner: a newer request replaces the older one.
     */
    request(owner, url, load) {
        if (!this.restricted || this.allowed || !this.isRemote(url)) {
            this.pending.delete(owner);
            load();
            return true;
        }
        this.pending.set(owner, { url: String(url), load });
        this.emit();
        this.schedulePrompt();
        return false;
    }

    isPending(owner) {
        return this.pending.has(owner);
    }

    /** The user agreed: load everything that waits, and anything this project asks for later. */
    allow() {
        this.allowed = true;
        this.flush();
    }

    flush() {
        const loads = [...this.pending.values()];
        this.pending.clear();
        for (const { load } of loads) {
            try {
                load();
            } catch (e) {
                console.warn('[media] load failed:', e);
            }
        }
        this.emit();
    }

    hosts() {
        const set = new Set();
        for (const { url } of this.pending.values()) {
            try { set.add(new URL(url, window.location.href).host); } catch (e) { /* ignore */ }
        }
        return [...set];
    }

    onChange(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit() {
        for (const fn of this.listeners) {
            try { fn(this); } catch (e) { /* ignore */ }
        }
    }

    schedulePrompt() {
        if (this.timer || this.prompting) return;
        // Let the rest of the project load first, so one question covers every node
        this.timer = setTimeout(() => {
            this.timer = null;
            this.prompt();
        }, 300);
    }

    /** Ask now (also from a click on a blocked node). */
    async prompt() {
        if (this.prompting || !this.pending.size) return;
        this.prompting = true;
        try {
            for (let i = 0; i < 600 && this.isBusy(); i++) await new Promise(r => setTimeout(r, 100));
            if (!this.pending.size) return;
            const hosts = this.hosts();
            const list = hosts.length > 3 ? `${hosts.slice(0, 3).join(', ')} and ${hosts.length - 3} more` : hosts.join(', ');
            const choice = await UIHelpers.choose({
                title: 'This project loads media from other websites',
                message: `It wants to load video or images from ${list}. Those sites would see your IP address, your browser and when you opened the project. ` +
                    'Until you allow it, the media stays blocked (click a blocked node to be asked again).',
                buttons: [
                    { label: 'Keep blocked', value: 'block', variant: 'ghost' },
                    { spacer: true },
                    { label: 'Load media', value: 'load', variant: 'primary' }
                ]
            });
            if (choice === 'load') this.allow();
        } catch (e) {
            /* dialog closed */
        } finally {
            this.prompting = false;
            this.emit();
        }
    }
}

export const contentGate = new ContentGate();
