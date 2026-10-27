/**
 * Node classes of the Render 3D objects: geometry nodes (own a GPU mesh built from their
 * CPU params), Mesh and Group 3D (plain library nodes with inline fields).
 */
import { LibraryNode } from '../nodes/LibraryNode.js';
import { buildGeometry, box } from './geometry.js';
import { uploadMesh, freeMesh } from './gl.js';
import { R3D, cpuInput, connAt } from './runtime.js';

const defaultBoxes = new WeakMap();

/** A unit box shared per context (Mesh without geometry). */
export function defaultBoxMesh(gl) {
    let m = defaultBoxes.get(gl);
    if (!m) {
        m = uploadMesh(gl, box({}));
        defaultBoxes.set(gl, m);
    }
    return m;
}

export class GeometryNode extends LibraryNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isGeometryNode = true;
        this._gpu = null;
        this._gl = null;
        this._params = {};
        this._key = '';
        this._epoch = -1;
        this._connected = false;
    }

    /** Current params ({name: value}); true when they changed since the last call. */
    refreshParams() {
        const defs = (this.definition && this.definition.geometryParams) || [];
        let changed = false;
        if (this._epoch !== R3D.epoch) {
            this._epoch = R3D.epoch;
            this._connected = false;
            for (let i = 0; i < defs.length; i++) if (connAt(this, i)) this._connected = true;
            changed = true;
        }
        if (!changed && !this._connected) return false;
        const tf = (this.definition && this.definition.textFields) || [];
        for (const f of tf) {
            const v = this.data[f.key] !== undefined ? String(this.data[f.key]) : f.default;
            if (this._params[f.key] !== v) { this._params[f.key] = v; changed = true; }
        }
        for (let i = 0; i < defs.length; i++) {
            const name = defs[i].name;
            const v = this._connected ? cpuInput(this, i, Number(this.data[name]) || defs[i].default) : Number(this.data[name]);
            const val = Number.isFinite(v) ? v : defs[i].default;
            if (this._params[name] !== val) { this._params[name] = val; changed = true; }
        }
        return changed;
    }

    /** The GPU mesh for the current params (rebuilt when they change). */
    gpuMesh(gl) {
        const changed = this.refreshParams();
        if (this._gpu && this._gl === gl && !changed) return this._gpu;
        let key = this.type;
        for (const k in this._params) key += `|${this._params[k]}`;
        if (this._gpu && this._gl === gl && key === this._key) return this._gpu;
        this._key = key;
        if (this._gpu && this._gl) freeMesh(this._gl, this._gpu);
        this._gl = gl;
        const mesh = buildGeometry(this.definition.geometryKind, this._params);
        this._gpu = uploadMesh(gl, mesh);
        this._gpu.bounds = mesh.bounds;
        return this._gpu;
    }

    cleanup() {
        if (this._gpu && this._gl) freeMesh(this._gl, this._gpu);
        this._gpu = null;
    }
}

export class MeshNode extends LibraryNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isMeshNode = true;
    }
}

export class GroupNode extends LibraryNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isGroup3DNode = true;
    }
}
