import { icon, injectIconSprite } from './icons.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';
import { createSharedCanvasPreview } from '../rendering/SharedCanvasPreview.js';
import { midiService } from '../services/MIDIService.js';

/* --------------------------------------------------------------------------
 * Small DOM helpers
 * ------------------------------------------------------------------------ */

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Create an element: h('div', { className: 'x', text: 'hi', onClick }, [children])
 */
export function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'className') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'html') el.innerHTML = value;
        else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key in el && typeof value !== 'string') el[key] = value;
        else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
}

function iconNode(name, size = 16) {
    const t = document.createElement('template');
    t.innerHTML = icon(name, { size });
    return t.content.firstChild;
}

const AVATAR_COLORS = ['#f5c84b', '#4ade80', '#8ecbff', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf'];

export function avatarColor(seed = '') {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function initials(name = '') {
    const clean = name.replace(/[^a-zA-Z0-9]/g, '');
    return (clean.slice(0, 2) || '?').toUpperCase();
}

/* --------------------------------------------------------------------------
 * Overlay stack (menus / popovers / modals) — Escape closes the topmost
 * ------------------------------------------------------------------------ */

const overlayStack = [];

function pushOverlay(entry) {
    overlayStack.push(entry);
}

function removeOverlay(entry) {
    const i = overlayStack.indexOf(entry);
    if (i > -1) overlayStack.splice(i, 1);
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || overlayStack.length === 0) return;
    const top = overlayStack[overlayStack.length - 1];
    if (top && top.closeOnEscape !== false) {
        e.preventDefault();
        e.stopImmediatePropagation();
        top.close();
    }
}, true);

function positionFloating(el, anchor, { align = 'start', offset = 6, placement = 'bottom' } = {}) {
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    const w = el.offsetWidth;
    const elH = el.offsetHeight;

    let left = align === 'end' ? r.right - w : (align === 'center' ? r.left + r.width / 2 - w / 2 : r.left);
    left = Math.max(margin, Math.min(left, vw - w - margin));

    let top = placement === 'top' ? r.top - elH - offset : r.bottom + offset;
    if (placement !== 'top' && top + elH > vh - margin && r.top - elH - offset > margin) {
        top = r.top - elH - offset; // flip up
    }
    top = Math.max(margin, Math.min(top, vh - elH - margin));

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
}

/* --------------------------------------------------------------------------
 * Tooltip singleton
 * ------------------------------------------------------------------------ */

const tooltipState = {
    el: null,
    timer: null,
    target: null,
    lastHide: 0,
};

function showTooltipFor(target) {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    if (!tooltipState.el) {
        tooltipState.el = h('div', { className: 'pt-tooltip', role: 'tooltip' });
        document.body.appendChild(tooltipState.el);
    }
    const el = tooltipState.el;
    const kbd = target.getAttribute('data-kbd');
    el.innerHTML = `<span>${escapeHtml(text)}</span>${kbd ? `<kbd>${escapeHtml(kbd)}</kbd>` : ''}`;
    el.classList.remove('is-visible');
    const r = target.getBoundingClientRect();
    const inBottomHalf = r.top > window.innerHeight * 0.6;
    positionFloating(el, target, { align: 'center', offset: 8, placement: inBottomHalf ? 'top' : 'bottom' });
    requestAnimationFrame(() => el.classList.add('is-visible'));
    tooltipState.target = target;
}

function hideTooltip() {
    clearTimeout(tooltipState.timer);
    tooltipState.timer = null;
    if (tooltipState.el && tooltipState.target) {
        tooltipState.el.classList.remove('is-visible');
        tooltipState.lastHide = performance.now();
    }
    tooltipState.target = null;
}

/* --------------------------------------------------------------------------
 * Toasts
 * ------------------------------------------------------------------------ */

const TOAST_ICONS = { info: 'info', success: 'check', error: 'alert', warning: 'alert', mcp: 'spark' };
const TOAST_DURATION = { info: 3400, success: 2600, error: 6500, warning: 5000, mcp: 3200 };

// Captured at load so we can tell when automation (MCP bridge) has swapped
// window.alert out to collect app messages.
const NATIVE_ALERT = typeof window !== 'undefined' ? window.alert : null;

export class UIHelpers {
    /* ================= Toasts ================= */

    /**
     * Report a message to the user. Errors/warnings are routed through
     * window.alert when it has been intercepted (automation / headless mode)
     * so callers that capture alerts still receive them; otherwise a toast.
     */
    static notify(message, kind = 'info', opts = {}) {
        try {
            window.dispatchEvent(new CustomEvent('patchtoy:notify', { detail: { message, kind } }));
        } catch (e) { /* ignore */ }
        if ((kind === 'error' || kind === 'warning') && NATIVE_ALERT && window.alert !== NATIVE_ALERT) {
            window.alert(opts.title ? `${opts.title}: ${message}` : message);
            return null;
        }
        return UIHelpers.toast(message, kind, opts);
    }

    /**
     * Show a transient notification.
     * @param {string} message
     * @param {'info'|'success'|'error'|'warning'|'mcp'} kind
     * @param {{title?: string, duration?: number, action?: {label: string, onClick: Function}}} opts
     */
    static toast(message, kind = 'info', opts = {}) {
        let host = document.querySelector('.pt-toasts');
        if (!host) {
            host = h('div', { className: 'pt-toasts', 'aria-live': 'polite' });
            document.body.appendChild(host);
        }
        injectIconSprite();

        const toast = h('div', { className: `pt-toast pt-toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' });
        toast.appendChild(iconNode(TOAST_ICONS[kind] || 'info'));
        const msg = h('div', { className: 'pt-toast-msg' });
        if (opts.title) msg.appendChild(h('div', { className: 'pt-toast-title', text: opts.title }));
        msg.appendChild(document.createTextNode(message));
        toast.appendChild(msg);

        if (opts.action) {
            toast.appendChild(h('button', {
                className: 'pt-btn pt-btn--sm',
                text: opts.action.label,
                onClick: () => { dismiss(); opts.action.onClick?.(); }
            }));
        }
        const closeBtn = h('button', { className: 'pt-icon-btn pt-icon-btn--sm', 'aria-label': 'Dismiss', onClick: () => dismiss() });
        closeBtn.appendChild(iconNode('close'));
        toast.appendChild(closeBtn);

        host.appendChild(toast);
        while (host.children.length > 4) host.firstChild.remove();

        let timer = null;
        let removed = false;
        const duration = opts.duration ?? TOAST_DURATION[kind] ?? 3200;
        function dismiss() {
            if (removed) return;
            removed = true;
            clearTimeout(timer);
            toast.classList.add('is-leaving');
            setTimeout(() => toast.remove(), 170);
        }
        const arm = () => { if (duration > 0) timer = setTimeout(dismiss, duration); };
        toast.addEventListener('mouseenter', () => clearTimeout(timer));
        toast.addEventListener('mouseleave', arm);
        arm();
        return { dismiss, el: toast };
    }

    /* ================= Menus & popovers ================= */

    /**
     * Open a floating menu anchored to an element.
     * items: [{ icon, label, hint, badge, onClick, disabled, danger }, { separator: true }, { header: Element|string }]
     * or pass `content` (Element) for a custom popover.
     */
    static openMenu({ anchor, items = [], content = null, align = 'start', className = '', offset = 6, onClose = null }) {
        injectIconSprite();
        const menu = h('div', { className: `pt-menu ${align === 'end' ? 'is-align-end' : ''} ${className}`, role: 'menu' });

        if (content) {
            menu.appendChild(content);
        } else {
            for (const item of items) {
                if (!item) continue;
                if (item.separator) {
                    menu.appendChild(h('div', { className: 'pt-menu-sep', role: 'separator' }));
                    continue;
                }
                if (item.header) {
                    const header = h('div', { className: 'pt-menu-header' });
                    if (typeof item.header === 'string') header.textContent = item.header;
                    else header.appendChild(item.header);
                    menu.appendChild(header);
                    continue;
                }
                const btn = h('button', {
                    className: `pt-menu-item${item.danger ? ' pt-menu-item--danger' : ''}`,
                    role: 'menuitem',
                    disabled: !!item.disabled
                });
                if (item.icon) btn.appendChild(iconNode(item.icon));
                btn.appendChild(h('span', { className: 'pt-menu-item-label', text: item.label }));
                if (item.badge) btn.appendChild(h('span', { className: 'pt-badge', text: item.badge }));
                if (item.hint) btn.appendChild(h('span', { className: 'pt-menu-item-hint', text: item.hint }));
                if (!item.disabled) {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (item.keepOpen !== true) api.close();
                        await item.onClick?.(e);
                    });
                }
                menu.appendChild(btn);
            }
        }

        document.body.appendChild(menu);
        positionFloating(menu, anchor, { align, offset });
        anchor?.classList?.add('is-open');

        const onPointerDown = (e) => {
            if (menu.contains(e.target)) return;
            if (anchor && anchor.contains && anchor.contains(e.target)) {
                // Clicking the anchor again toggles the menu closed
                e.stopPropagation();
                e.preventDefault();
                api.close();
                return;
            }
            // Clicks inside a menu opened later (child) or a modal shouldn't close this one
            const idx = overlayStack.indexOf(api);
            const insideChild = overlayStack.slice(idx + 1).some(o => o.el && o.el.contains(e.target));
            if (insideChild) return;
            if (e.target.closest && e.target.closest('.pt-modal-backdrop, .pt-toasts')) return;
            api.close();
        };
        const onResize = () => api.close();

        const api = {
            el: menu,
            closed: false,
            close() {
                if (api.closed) return;
                api.closed = true;
                // Close children first
                const idx = overlayStack.indexOf(api);
                if (idx > -1) {
                    overlayStack.slice(idx + 1).forEach(o => o.close());
                }
                removeOverlay(api);
                document.removeEventListener('pointerdown', onPointerDown, true);
                window.removeEventListener('resize', onResize);
                anchor?.classList?.remove('is-open');
                menu.remove();
                onClose?.();
            },
            reposition() {
                positionFloating(menu, anchor, { align, offset });
            }
        };
        pushOverlay(api);
        setTimeout(() => {
            if (!api.closed) document.addEventListener('pointerdown', onPointerDown, true);
        }, 0);
        window.addEventListener('resize', onResize);
        return api;
    }

    /* ================= Modals ================= */

    /**
     * Create a modal dialog. Returns { backdrop, modal, body, footer, close, setError, setMessage }.
     */
    static createModal({ title = '', subtitle = '', kicker = '', className = '', closable = true, brand = false, onClose = null } = {}) {
        injectIconSprite();
        hideTooltip();
        const backdrop = h('div', { className: 'pt-modal-backdrop' });
        const modal = h('div', { className: `pt-modal ${className}`, role: 'dialog', 'aria-modal': 'true' });

        const header = h('div', { className: 'pt-modal-header' });
        const heading = h('div', { className: 'pt-modal-heading' });
        if (brand) {
            const brandRow = h('div', { className: 'pt-modal-brand' });
            // Same (build-hashed) logo as the top bar; absolute fallback for deep routes (/p/<id>, /u/<name>)
            const logoSrc = document.querySelector('.tb-logo img')?.src || '/patchtoy.png';
            brandRow.appendChild(h('img', { src: logoSrc, alt: 'PatchToy', width: 59, height: 12 }));
            heading.appendChild(brandRow);
        }
        if (kicker) heading.appendChild(h('span', { className: 'pt-label pt-modal-kicker', text: kicker }));
        const titleEl = h('div', { className: 'pt-modal-title', text: title, id: `pt-modal-title-${Date.now()}` });
        heading.appendChild(titleEl);
        modal.setAttribute('aria-labelledby', titleEl.id);
        const subtitleEl = h('div', { className: 'pt-modal-subtitle', text: subtitle });
        if (!subtitle) subtitleEl.hidden = true;
        heading.appendChild(subtitleEl);
        header.appendChild(heading);

        if (closable) {
            const x = h('button', { className: 'pt-icon-btn', 'aria-label': 'Close', onClick: () => api.close() });
            x.appendChild(iconNode('close'));
            header.appendChild(x);
        }

        const body = h('div', { className: 'pt-modal-body' });
        const footer = h('div', { className: 'pt-modal-footer' });
        modal.append(header, body, footer);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);

        // Close on backdrop click (only if the press also started on the backdrop)
        let downOnBackdrop = false;
        backdrop.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === backdrop; });
        backdrop.addEventListener('click', (e) => {
            if (closable && downOnBackdrop && e.target === backdrop) api.close();
        });

        let messageEl = null;
        const setMessage = (text, kind = 'error') => {
            if (!messageEl) {
                messageEl = h('div');
                body.insertBefore(messageEl, body.firstChild);
            }
            if (!text) {
                messageEl.hidden = true;
                return;
            }
            messageEl.hidden = false;
            messageEl.className = kind === 'success' ? 'pt-form-success' : 'pt-form-error';
            messageEl.innerHTML = '';
            messageEl.appendChild(iconNode(kind === 'success' ? 'check' : 'alert'));
            messageEl.appendChild(h('span', { text }));
        };

        const api = {
            el: backdrop,
            backdrop,
            modal,
            header,
            body,
            footer,
            titleEl,
            subtitleEl,
            closed: false,
            closeOnEscape: closable,
            close() {
                if (api.closed) return;
                api.closed = true;
                removeOverlay(api);
                backdrop.remove();
                onClose?.();
            },
            setError: (text) => setMessage(text, 'error'),
            setMessage,
        };
        pushOverlay(api);
        return api;
    }

    /** Build a labelled form field. Returns { field, input }. */
    static field({ label, type = 'text', placeholder = '', value = '', hint = '', autocomplete, mono = false, readOnly = false }) {
        const id = `pt-f-${Math.random().toString(36).slice(2, 8)}`;
        const field = h('div', { className: 'pt-field' });
        if (label) field.appendChild(h('label', { for: id, text: label }));
        const input = h('input', {
            id,
            type,
            className: `pt-input${mono ? ' pt-input--mono' : ''}`,
            placeholder,
            spellcheck: 'false',
            autocomplete: autocomplete || 'off'
        });
        input.value = value;
        if (readOnly) input.readOnly = true;
        field.appendChild(input);
        if (hint) field.appendChild(h('div', { className: 'pt-field-hint', text: hint }));
        return { field, input };
    }

    static button(label, { variant = '', size = '', icon: iconName = null, block = false, onClick = null, type = 'button' } = {}) {
        const cls = ['pt-btn'];
        if (variant) cls.push(`pt-btn--${variant}`);
        if (size) cls.push(`pt-btn--${size}`);
        if (block) cls.push('pt-btn--block');
        const btn = h('button', { className: cls.join(' '), type });
        if (iconName) btn.appendChild(iconNode(iconName));
        btn.appendChild(h('span', { text: label }));
        if (onClick) btn.addEventListener('click', onClick);
        btn.setLabel = (text) => { btn.querySelector('span').textContent = text; };
        return btn;
    }

    /**
     * Styled replacement for window.confirm(). Resolves true/false.
     */
    static confirm({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
        return new Promise((resolve) => {
            let result = false;
            const m = UIHelpers.createModal({
                title,
                subtitle: message,
                className: 'pt-modal--confirm',
                onClose: () => resolve(result)
            });
            m.body.remove();
            const cancel = UIHelpers.button(cancelLabel, { onClick: () => m.close() });
            const ok = UIHelpers.button(confirmLabel, {
                variant: danger ? 'danger' : 'primary',
                onClick: () => { result = true; m.close(); }
            });
            m.footer.append(cancel, ok);
            setTimeout(() => ok.focus(), 0);
        });
    }

    /**
     * Dialog with arbitrary choices. buttons: [{ label, value, variant }]. Resolves value or null.
     */
    static choose({ title, message = '', buttons = [] }) {
        return new Promise((resolve) => {
            let result = null;
            const m = UIHelpers.createModal({
                title,
                subtitle: message,
                className: 'pt-modal--confirm',
                onClose: () => resolve(result)
            });
            m.body.remove();
            let primary = null;
            let safe = null; // first non-destructive button (default focus when there's no primary)
            buttons.forEach((b, i) => {
                if (b.spacer) {
                    m.footer.appendChild(h('div', { className: 'pt-spacer' }));
                    return;
                }
                const btn = UIHelpers.button(b.label, {
                    variant: b.variant || '',
                    onClick: () => { result = b.value; m.close(); }
                });
                if (b.variant === 'primary') primary = btn;
                if (!safe && b.variant !== 'danger') safe = btn;
                m.footer.appendChild(btn);
            });
            // Never focus a destructive choice by default (Enter would confirm it)
            setTimeout(() => (primary || safe || m.footer.lastChild)?.focus(), 0);
        });
    }

    /* ================= Tooltips ================= */

    static initTooltips() {
        if (UIHelpers._tooltipsReady) return;
        UIHelpers._tooltipsReady = true;

        document.addEventListener('pointerover', (e) => {
            const target = e.target.closest?.('[data-tip]');
            if (!target || target === tooltipState.target) return;
            hideTooltip();
            // Tips also show on disabled buttons (they explain why)
            const warm = performance.now() - tooltipState.lastHide < 500;
            tooltipState.timer = setTimeout(() => showTooltipFor(target), warm ? 60 : 480);
        });
        document.addEventListener('pointerout', (e) => {
            const target = e.target.closest?.('[data-tip]');
            if (!target) return;
            if (e.relatedTarget && target.contains(e.relatedTarget)) return;
            hideTooltip();
        });
        document.addEventListener('pointerdown', hideTooltip, true);
        window.addEventListener('blur', hideTooltip);
        document.addEventListener('scroll', hideTooltip, true);
    }

    /** Refresh a visible tooltip after its data-tip changed. */
    static refreshTooltip(target) {
        if (tooltipState.target === target) showTooltipFor(target);
    }

    /* ================= Account ================= */

    /**
     * @param {ApiClient} apiClient
     * @param {Function} onLogout
     * @param {Array} [extraItems] - menu items shown under the header (my page, my projects, profile)
     */
    static showAccountMenu(apiClient, onLogout, extraItems = null) {
        const user = apiClient.getCurrentUser();
        const anchor = document.getElementById('accountBtn');
        const name = user?.username || 'user';

        const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } });
        const av = h('div', { className: 'am-avatar', text: initials(name) });
        av.style.setProperty('--avatar-bg', avatarColor(name));
        const info = h('div', { style: { minWidth: 0 } }, [
            h('div', { className: 'am-name', text: `@${name}` }),
            user?.email ? h('div', { className: 'am-email', text: user.email }) : null
        ]);
        header.append(av, info);

        return UIHelpers.openMenu({
            anchor,
            align: 'end',
            items: [
                { header },
                { separator: true },
                ...(extraItems && extraItems.length ? extraItems : [{ icon: 'user', label: 'Profile', badge: 'Soon', disabled: true }]),
                { icon: 'gear', label: 'Settings', badge: 'Soon', disabled: true },
                { separator: true },
                { icon: 'logout', label: 'Log out', onClick: () => onLogout?.() }
            ]
        });
    }

    static updateAccountButton(apiClient) {
        const btn = document.getElementById('accountBtn');
        const saveBtn = document.getElementById('saveCloudBtn');

        if (!btn) {
            console.warn('Account button not found');
            return;
        }

        const setTip = (el, text) => {
            if (!el) return;
            el.setAttribute('data-tip', text);
            el.removeAttribute('title');
            UIHelpers.refreshTooltip(el);
        };

        if (!apiClient.isEnabled()) {
            btn.disabled = true;
            btn.classList.remove('is-logged-in');
            setTip(btn, 'Cloud features are not configured');
            if (saveBtn) saveBtn.hidden = true;
            return;
        }

        btn.disabled = false;

        if (apiClient.isLoggedIn()) {
            const user = apiClient.getCurrentUser();
            const name = user?.username || 'user';
            btn.classList.add('is-logged-in');
            btn.style.setProperty('--avatar-bg', avatarColor(name));
            btn.innerHTML = `<span class="tb-avatar-initials">${escapeHtml(initials(name))}</span>`;
            setTip(btn, `Signed in as @${name}`);
            if (saveBtn) {
                saveBtn.hidden = false;
                setTip(saveBtn, 'Save to cloud');
            }
        } else {
            btn.classList.remove('is-logged-in');
            btn.style.removeProperty('--avatar-bg');
            btn.innerHTML = icon('user');
            setTip(btn, 'Sign in / Create account');
            if (saveBtn) {
                saveBtn.hidden = false;
                setTip(saveBtn, 'Sign in to save to the cloud');
            }
        }
    }

    /* ================= Device buttons ================= */

    /**
     * Update a device toggle in the top bar.
     * state: 'on' | 'off' | 'error'; available: whether the graph has nodes using it.
     */
    static setDeviceButtonState(idOrEl, { state = 'off', available = true, tip = null } = {}) {
        const btn = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
        if (!btn) return;
        // Drop any legacy inline colors set by older code paths
        btn.style.removeProperty('background');
        btn.style.removeProperty('border-color');
        btn.classList.toggle('is-on', state === 'on');
        btn.classList.toggle('is-error', state === 'error');
        btn.classList.toggle('is-available', !!available);
        btn.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
        if (tip) {
            if (btn.getAttribute('data-tip') !== tip) {
                btn.setAttribute('data-tip', tip);
                UIHelpers.refreshTooltip(btn);
            }
            btn.removeAttribute('title');
        }
    }

    static async enableAllMicrophones(nodeGraph) {
        const micNodes = nodeGraph.nodes.filter(n => n.isMicrophoneNode);

        if (micNodes.length === 0) {
            UIHelpers.toast('Add a Microphone node to use audio input.', 'info');
            return;
        }

        try {
            for (const micNode of micNodes) {
                if (!micNode.isActive) {
                    await micNode.enable();
                }
            }
            UIHelpers.setDeviceButtonState('micBtn', { state: 'on', tip: 'Microphone live' });
        } catch (error) {
            console.error('Failed to enable microphones:', error);
            UIHelpers.setDeviceButtonState('micBtn', { state: 'error', tip: 'Microphone error: ' + error.message });
            UIHelpers.toast(error.message, 'error', { title: 'Microphone unavailable' });
        }
    }

    static async enableMIDI() {

        try {
            const success = await midiService.enable();

            if (success) {
                const devices = midiService.getDevices();
                UIHelpers.setDeviceButtonState('midiBtn', { state: 'on', tip: `MIDI on · ${devices.length} device${devices.length === 1 ? '' : 's'}` });
                UIHelpers.toast(`MIDI enabled — ${devices.length} device${devices.length === 1 ? '' : 's'} found`, 'success');
            } else {
                throw new Error('Failed to enable MIDI');
            }
        } catch (error) {
            console.error('[MIDI] Failed to enable:', error);
            UIHelpers.setDeviceButtonState('midiBtn', { state: 'error', tip: 'MIDI error: ' + error.message });
            UIHelpers.toast(error.message, 'error', { title: 'MIDI unavailable' });
        }
    }

    static async enableAllCameras(nodeGraph) {
        const cameraNodes = nodeGraph.nodes.filter(n => n.isCameraNode);

        if (cameraNodes.length === 0) {
            UIHelpers.toast('Add a Camera node to use your webcam.', 'info');
            return;
        }

        try {
            for (const cameraNode of cameraNodes) {
                if (!cameraNode.isActive) {
                    await cameraNode.enable();
                }
            }
            UIHelpers.setDeviceButtonState('cameraBtn', { state: 'on', tip: 'Camera live' });
        } catch (error) {
            console.error('Failed to enable cameras:', error);
            UIHelpers.setDeviceButtonState('cameraBtn', { state: 'error', tip: 'Camera error: ' + error.message });
            UIHelpers.toast(error.message, 'error', { title: 'Camera unavailable' });
        }
    }

    /* ================= Fullscreen preview ================= */

    static togglePreviewFullscreen(previewPanel, resizeCallback) {
        previewPanel.classList.toggle('fullscreen-preview');

        setTimeout(() => {
            resizeCallback();
        }, 0);

        if (previewPanel.classList.contains('fullscreen-preview')) {
            const escapeHandler = (e) => {
                if (e.key === 'Escape') {
                    previewPanel.classList.remove('fullscreen-preview');
                    resizeCallback();
                    document.removeEventListener('keydown', escapeHandler);
                }
            };
            document.addEventListener('keydown', escapeHandler);
        }
    }

    static showPreviewNodeFullscreen(node, onClose) {
        if (!node.previewInstance) return;

        const previewInstance = node.previewInstance;

        // Get the display canvas (handles both legacy and shared context modes)
        const srcCanvas = node.getDisplayCanvas ? node.getDisplayCanvas() : previewInstance.canvas;
        if (!srcCanvas) return;

        hideTooltip();

        // Pause all other preview nodes to maximize performance
        const nodeGraph = node.graph;
        const otherPreviewNodes = nodeGraph ? nodeGraph.nodes.filter(n => n.isPreviewNode && n !== node) : [];
        const pausedAnimations = [];

        for (const otherNode of otherPreviewNodes) {
            if (otherNode.previewInstance && otherNode.previewInstance.animationId) {
                pausedAnimations.push({
                    node: otherNode,
                    animationId: otherNode.previewInstance.animationId
                });
                otherNode.previewInstance.stopRendering();
            }
        }

        // Pause background renderer if active
        let backgroundWasPaused = false;
        if (nodeGraph && nodeGraph.backgroundRenderer && nodeGraph.backgroundRenderer.shaderPreview) {
            const bgShaderPreview = nodeGraph.backgroundRenderer.shaderPreview;
            if (bgShaderPreview.animationId) {
                backgroundWasPaused = true;
                bgShaderPreview.stopRendering();
            }
        }

        // Pause the NodeGraph rendering itself
        let nodeGraphWasPaused = false;
        if (nodeGraph) {
            nodeGraphWasPaused = true;
            nodeGraph._originalRender = nodeGraph.render;
            nodeGraph.render = () => {};
        }

        // Fullscreen overlay
        const overlay = h('div', { className: 'pt-fullscreen is-ui-visible' });
        const displayCanvas = document.createElement('canvas');
        overlay.appendChild(displayCanvas);

        const hud = h('div', { className: 'pt-fullscreen-hud' });
        hud.appendChild(h('span', { html: 'Click or press <kbd>Esc</kbd> to exit' }));
        const closeBtn = h('button', { className: 'pt-icon-btn', 'aria-label': 'Exit fullscreen' });
        closeBtn.appendChild(iconNode('close'));
        hud.appendChild(closeBtn);
        overlay.appendChild(hud);

        document.body.appendChild(overlay);

        // Auto-hide HUD + cursor after inactivity
        let hudTimer = null;
        const pokeHud = () => {
            overlay.classList.add('is-ui-visible');
            clearTimeout(hudTimer);
            hudTimer = setTimeout(() => overlay.classList.remove('is-ui-visible'), 1800);
        };
        overlay.addEventListener('mousemove', pokeHud);
        pokeHud();

        // Size the canvas to the overlay - the window first, then the whole screen once
        // the browser actually enters fullscreen
        displayCanvas.style.width = '100%';
        displayCanvas.style.height = '100%';
        const sizeCanvas = () => {
            const dpr = window.devicePixelRatio || 1;
            const rect = overlay.getBoundingClientRect();
            displayCanvas.width = Math.max(1, Math.floor((rect.width || window.innerWidth) * dpr));
            displayCanvas.height = Math.max(1, Math.floor((rect.height || window.innerHeight) * dpr));
        };
        sizeCanvas();
        window.addEventListener('resize', sizeCanvas);

        Promise.resolve().then(() => {
            // Render in the shared GL context when there is one, so Feedback render
            // targets (which only exist there) can be sampled
            const sharedGL = nodeGraph?.sharedGL;
            const fullscreenPreview = sharedGL
                ? createSharedCanvasPreview({
                    sharedGL,
                    targetCanvas: displayCanvas,
                    videoElement: previewInstance.videoElement,
                    uniformRegistry: nodeGraph.uniformRegistry || null,
                    governor: 'background' // dynamic resolution (QualityGovernor.js)
                })
                : new ShaderPreview(displayCanvas, previewInstance.videoElement, {
                    offscreen: false,
                    uniformRegistry: nodeGraph?.uniformRegistry || null
                });

            if (nodeGraph) {
                fullscreenPreview.graph = nodeGraph;
            }

            if (previewInstance.currentShaderSource) {
                fullscreenPreview.loadShader(previewInstance.currentShaderSource);
            }

            if (previewInstance.customUniformValues) {
                fullscreenPreview.customUniformValues = previewInstance.customUniformValues;
            }

            overlay._fullscreenPreview = fullscreenPreview;

            if (isExiting) {
                fullscreenPreview.destroy();
                return;
            }

            overlay.requestFullscreen().catch(err => {
                console.warn('Fullscreen request failed:', err);
            });
        });

        let isExiting = false;

        const closeFullscreen = () => {
            if (isExiting) return;
            isExiting = true;
            clearTimeout(hudTimer);

            if (overlay._fullscreenPreview) {
                overlay._fullscreenPreview.destroy();
            }

            if (document.fullscreenElement) {
                document.exitFullscreen().catch(err => {
                    if (!err.message.includes('cancelled')) {
                        console.warn('Error exiting fullscreen:', err);
                    }
                });
            }

            for (const paused of pausedAnimations) {
                if (paused.node.previewInstance) {
                    paused.node.previewInstance.animate();
                }
            }

            if (backgroundWasPaused && nodeGraph && nodeGraph.backgroundRenderer && nodeGraph.backgroundRenderer.shaderPreview) {
                nodeGraph.backgroundRenderer.shaderPreview.animate();
            }

            if (nodeGraphWasPaused && nodeGraph && nodeGraph._originalRender) {
                nodeGraph.render = nodeGraph._originalRender;
                delete nodeGraph._originalRender;
                nodeGraph.render();
            }

            overlay.remove();

            if (onClose) onClose();

            document.removeEventListener('fullscreenchange', fullscreenChangeHandler);
            window.removeEventListener('resize', sizeCanvas);
            document.removeEventListener('keydown', escapeHandler);
        };

        const fullscreenChangeHandler = () => {
            if (!document.fullscreenElement && !isExiting) {
                closeFullscreen();
                return;
            }
            sizeCanvas();
        };
        document.addEventListener('fullscreenchange', fullscreenChangeHandler);

        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (!document.fullscreenElement) {
                    closeFullscreen();
                }
            }
        };
        document.addEventListener('keydown', escapeHandler);

        overlay.addEventListener('click', () => {
            closeFullscreen();
        });
    }

    static updatePreviewNodesCameraState(nodeGraph, cameraEnabled) {
        for (const [nodeId, previewInstance] of nodeGraph.previewNodes) {
            previewInstance.cameraEnabled = cameraEnabled;
        }
    }
}
