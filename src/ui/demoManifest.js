/**
 * Demo manifest: the demo patches shipped in /projects, discovered at build time.
 *
 * Any projects/<slug>.patchtoy.json shows up (with projects/<slug>.png as its
 * 16:10 thumbnail when present). The `?url` imports become hashed assets in
 * `vite build`; the JSON itself is only fetched when the gallery needs it.
 */

// Test artefacts (e2e-*, test-*, tmp-*, *.test.*) never ship as demos: the negative
// patterns keep them out of the build too. Literal arrays: import.meta.glob needs them inline.
const PROJECT_URLS = import.meta.glob(['/projects/*.patchtoy.json', '!/projects/e2e-*', '!/projects/test-*', '!/projects/tmp-*', '!/projects/*.test.*'], { query: '?url', import: 'default', eager: true });
// Only the small JPEG thumbs ship: the full-size projects/<slug>.png renders (~2 MB each) are
// sources for `npm run thumbs`, and globbing them would put ~40 MB of images in the build.
// Small JPEG copies made by `npm run thumbs` (scripts/make-thumbs.mjs); preferred when present
const SMALL_THUMB_URLS = import.meta.glob('/projects/thumbs/*.jpg', { query: '?url', import: 'default', eager: true });

/** Slugs of test artefacts (also filtered at runtime, in case a glob pattern is bypassed). */
export const isTestProjectSlug = (slug) => /^(e2e|test|tmp)-/i.test(slug) || /\.test$/i.test(slug);

/** Shown first, in this order; any other demo follows alphabetically. */
export const CURATED_ORDER = ['prism-drift', 'hyperbolic-lanterns', 'aurora-fjord', 'kaleido-tunnel', 'molten-orbit'];

const fileStem = (path, ext) => path.split('/').pop().replace(ext, '');
const prettify = (slug) => slug.split(/[-_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

function discoverDemos() {
    const thumbs = {};
    for (const [path, url] of Object.entries(SMALL_THUMB_URLS)) thumbs[fileStem(path, /\.jpg$/i)] = url;

    const rank = (slug) => {
        const i = CURATED_ORDER.indexOf(slug);
        return i === -1 ? CURATED_ORDER.length : i;
    };
    return Object.entries(PROJECT_URLS)
        .filter(([path]) => !isTestProjectSlug(fileStem(path, /\.patchtoy\.json$/i)))
        .map(([path, url]) => {
            const slug = fileStem(path, /\.patchtoy\.json$/i);
            if (import.meta.env.DEV && !thumbs[slug]) console.warn(`[demos] no thumbnail for ${slug}: run npm run thumbs`);
            return { slug, url, thumb: thumbs[slug] || null, fallbackName: prettify(slug) };
        })
        .sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));
}

const discovered = discoverDemos();

/** Demos in gallery order: [{ slug, url, thumb, fallbackName }]. Updated in place in dev. */
export const DEMOS = import.meta.hot?.data?.demos ?? discovered;

// Dev: the MCP server rewrites projects/*.patchtoy.json while agents work. Without this
// boundary every save would full-reload the page. Instead this module re-runs and refills
// the one shared array that importers hold (new objects, so cached project data is refetched).
if (import.meta.hot) {
    if (DEMOS !== discovered) DEMOS.splice(0, DEMOS.length, ...discovered);
    import.meta.hot.data.demos = DEMOS;
    import.meta.hot.accept();
}
