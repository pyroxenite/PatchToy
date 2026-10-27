/**
 * Keyboard shortcut cheat sheet (press ? on the canvas, or Help menu → Keyboard shortcuts).
 * Content: shortcuts.js. Styles: .pt-modal--shortcuts / .ks-* in style.css.
 */
import { UIHelpers, h, escapeHtml } from '../UIHelpers.js';
import { shortcutsByArea, capLabel } from './shortcuts.js';

function keysHtml(item) {
    const alts = (item.keys || []).map(combo => {
        // Single characters typed in a row (swizzles, 1 … 9) read better as one group
        return `<span class="ks-combo">${combo.map(k => `<kbd>${escapeHtml(capLabel(k))}</kbd>`).join('')}</span>`;
    });
    let out = alts.join('<span class="ks-or">/</span>');
    if (item.mouse) out += `<span class="ks-mouse">${escapeHtml(item.mouse)}</span>`;
    return out;
}

export class ShortcutSheet {
    constructor(app) {
        this.app = app;
        this.modal = null;
    }

    isOpen() {
        return !!(this.modal && !this.modal.closed);
    }

    toggle() {
        if (this.isOpen()) this.close();
        else this.open();
    }

    close() {
        this.modal?.close();
    }

    open() {
        if (this.isOpen()) return this.modal;
        const m = UIHelpers.createModal({
            kicker: 'Help',
            title: 'Keyboard & mouse shortcuts',
            subtitle: 'Canvas shortcuts work when no text field has focus.',
            className: 'pt-modal--shortcuts',
            onClose: () => { if (this.modal === m) this.modal = null; },
        });
        this.modal = m;
        const grid = h('div', { className: 'ks-grid' });
        for (const area of shortcutsByArea()) {
            const sec = h('section', { className: 'ks-area' });
            sec.dataset.area = area.id;
            sec.appendChild(h('div', { className: 'pt-label ks-area-title', text: area.title }));
            for (const item of area.items) {
                const row = h('div', { className: 'ks-row' });
                row.dataset.shortcut = item.id;
                row.innerHTML = `<span class="ks-label">${escapeHtml(item.label)}</span><span class="ks-keys">${keysHtml(item)}</span>`;
                sec.appendChild(row);
            }
            grid.appendChild(sec);
        }
        m.body.appendChild(grid);

        const tour = UIHelpers.button('Take the tour', { variant: 'ghost', icon: 'flag', onClick: () => { m.close(); this.app.help?.startTour(); } });
        const ref = UIHelpers.button('Node reference', { variant: 'ghost', icon: 'help', onClick: () => { m.close(); this.app.help?.openNodeHelp(null, { focusSearch: true }); } });
        const done = UIHelpers.button('Done', { variant: 'primary', onClick: () => m.close() });
        m.footer.append(tour, ref, h('span', { className: 'ks-spacer' }), done);
        requestAnimationFrame(() => done.focus());
        return m;
    }
}
