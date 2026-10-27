/**
 * Monaco editor, loaded on demand (security review M2 / M3).
 *
 * Nothing is requested from the CDN until a code editor is opened, so a page load
 * (for example a password-reset link) never contacts a third party before the app
 * has cleaned up its URL. The loader script and the stylesheet carry Subresource
 * Integrity hashes (cdnjs, verified against the files); the production CSP allows
 * only this path (infra/lib/patchtoy-stack.ts).
 */
export const MONACO_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs';

const FILES = {
    loader: {
        url: `${MONACO_BASE}/loader.min.js`,
        integrity: 'sha512-ZG31AN9z/CQD1YDDAK4RUAvogwbJHv6bHrumrnMLzdCrVu4HeAqrUX7Jsal/cbUwXGfaMUNmQU04tQ8XXl5Znw=='
    },
    css: {
        url: `${MONACO_BASE}/editor/editor.main.min.css`,
        integrity: 'sha512-cglMadHaO/jAvqEM51bUj/saVbUkZwVa4PX0bcpWVlND3OrPpYcS/91uhIrgHrXmikanebYApd7UWjbDGEQUqg=='
    }
};

let loading = null;

function addStylesheet() {
    if (document.querySelector(`link[href="${FILES.css.url}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FILES.css.url;
    link.integrity = FILES.css.integrity;
    link.crossOrigin = 'anonymous';
    link.referrerPolicy = 'no-referrer';
    document.head.appendChild(link);
}

function addLoader() {
    return new Promise((resolve, reject) => {
        if (window.require && window.require.config) return resolve();
        const script = document.createElement('script');
        script.src = FILES.loader.url;
        script.integrity = FILES.loader.integrity;
        script.crossOrigin = 'anonymous';
        script.referrerPolicy = 'no-referrer';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Monaco loader failed to load'));
        document.head.appendChild(script);
    });
}

/** Resolves window.monaco (loads it the first time). Rejects when offline / blocked. */
export function loadMonaco() {
    if (window.monaco) return Promise.resolve(window.monaco);
    if (!loading) {
        loading = (async () => {
            addStylesheet();
            await addLoader();
            window.require.config({ paths: { vs: MONACO_BASE } });
            return await new Promise((resolve, reject) => {
                window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
            });
        })().catch((err) => {
            loading = null; // allow a retry (e.g. back online)
            throw err;
        });
    }
    return loading;
}
