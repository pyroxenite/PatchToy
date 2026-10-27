/**
 * Projects on disk: <dir>/<slug>.patchtoy.json, in the same format as the
 * app's "Download project" file ({version, graph, customNodes, editorStates,
 * timestamp}) plus `name` and `description`. Files can be loaded in the app
 * via "Load local file".
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeFileNoFollow } from './auth.mjs';

export const PROJECT_EXT = '.patchtoy.json';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function slugify(name) {
    const s = String(name || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)
        .replace(/-+$/g, '');
    return s || 'project';
}

export class ProjectError extends Error {
    constructor(message, data) {
        super(message);
        this.name = 'ProjectError';
        if (data !== undefined) this.data = data;
    }
}

export function emptyProject(name, description = '') {
    return {
        name,
        description,
        version: '1.0',
        timestamp: new Date().toISOString(),
        graph: { nodes: [], connections: [], nextNodeId: 0, panX: 0, panY: 0, zoom: 1 },
        customNodes: {},
        editorStates: [],
    };
}

export class ProjectStore {
    constructor(dir) {
        this.dir = dir;
        this.stateFile = path.join(dir, '.mcp-state.json');
        this.backupDir = path.join(dir, '.backups');
    }

    ensureDir() {
        fs.mkdirSync(this.dir, { recursive: true });
    }

    file(slug) {
        if (!SLUG_RE.test(slug)) throw new ProjectError(`Invalid project slug "${slug}"`);
        return path.join(this.dir, slug + PROJECT_EXT);
    }

    exists(slug) {
        return SLUG_RE.test(slug) && fs.existsSync(this.file(slug));
    }

    async list() {
        this.ensureDir();
        const entries = await fsp.readdir(this.dir);
        const out = [];
        for (const f of entries.filter(f => f.endsWith(PROJECT_EXT)).sort()) {
            const slug = f.slice(0, -PROJECT_EXT.length);
            try {
                const data = await this.read(slug);
                const stat = await fsp.stat(this.file(slug));
                out.push({
                    name: data.name || slug,
                    slug,
                    description: data.description || '',
                    nodes: data.graph?.nodes?.length || 0,
                    custom_nodes: Object.keys(data.customNodes || {}).length,
                    updated: data.timestamp || stat.mtime.toISOString(),
                });
            } catch (e) {
                out.push({ name: slug, slug, error: `unreadable: ${e.message}` });
            }
        }
        return out;
    }

    /** Resolve a user-supplied name or slug to an existing slug, or throw. */
    async resolve(ref) {
        if (!ref || typeof ref !== 'string') throw new ProjectError('Project name is required');
        const trimmed = ref.trim().replace(new RegExp(`${PROJECT_EXT.replace(/\./g, '\\.')}$`), '');
        if (SLUG_RE.test(trimmed) && this.exists(trimmed)) return trimmed;
        const slug = slugify(trimmed);
        if (this.exists(slug)) return slug;
        const all = await this.list();
        const byName = all.filter(p => (p.name || '').toLowerCase() === trimmed.toLowerCase());
        if (byName.length === 1) return byName[0].slug;
        throw new ProjectError(`No project named "${ref}"`, { projects: all.map(p => p.name === p.slug ? p.slug : `${p.name} (${p.slug})`) });
    }

    async read(slug) {
        const text = await fsp.readFile(this.file(slug), 'utf8');
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new ProjectError(`Project file ${slug}${PROJECT_EXT} is not valid JSON: ${e.message}`); }
        if (!data || typeof data !== 'object' || !data.graph) throw new ProjectError(`Project file ${slug}${PROJECT_EXT} has no graph`);
        return data;
    }

    async write(slug, data) {
        this.ensureDir();
        const ordered = {
            name: data.name ?? slug,
            description: data.description ?? '',
            version: data.version || '1.0',
            timestamp: data.timestamp || new Date().toISOString(),
            graph: data.graph,
            customNodes: data.customNodes || {},
            editorStates: data.editorStates || [],
        };
        const file = this.file(slug);
        const tmp = `${file}.${process.pid}.tmp`;
        // Slugs can't contain path separators (SLUG_RE); also never follow a planted symlink
        writeFileNoFollow(tmp, JSON.stringify(ordered, null, 2) + '\n');
        await fsp.rename(tmp, file);
        return ordered;
    }

    async create(name, description = '') {
        if (!name || !String(name).trim()) throw new ProjectError('Project name is required');
        const slug = slugify(name);
        if (this.exists(slug)) throw new ProjectError(`A project with slug "${slug}" already exists`, { hint: 'Use open_project, or pick another name.' });
        const data = await this.write(slug, emptyProject(String(name).trim(), description));
        return { slug, data };
    }

    async delete(slug) {
        await fsp.unlink(this.file(slug));
    }

    async writeBackup(label, data) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        const file = path.join(this.backupDir, `${slugify(label)}-${new Date().toISOString().replace(/[:.]/g, '-')}${PROJECT_EXT}`);
        writeFileNoFollow(file, JSON.stringify({ name: `Backup ${label}`, description: 'Automatic backup of the browser graph before the agent opened a project', ...data }, null, 2));
        return file;
    }

    readState() {
        try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
    }

    writeState(state) {
        try {
            this.ensureDir();
            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2) + '\n');
        } catch { /* best effort */ }
    }
}
