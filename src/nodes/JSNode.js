import { Node } from './Node.js';

/**
 * JSNode - A node that executes JavaScript code to generate uniform values
 * Supports setup code, external script loading, and automatic type detection
 */
export class JSNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        // Initialize JS-specific data
        if (!this.data.setupCode) this.data.setupCode = '';
        if (!this.data.code) this.data.code = 'return float(Math.sin(u_time));';
        if (!this.data.setupComplete) this.data.setupComplete = false;

        // Context object that persists across executions
        this._context = {};

        // Track DOM elements created by this node for cleanup
        this._domElements = [];

        // Cached uniform values from last execution
        this._cachedUniforms = [];

        // Error state
        this.setupError = null;
        this.executeError = null;
    }

    /**
     * Run the setup code once
     */
    async runSetup() {
        if (this.data.setupComplete && !this.setupError) {
            return; // Already set up successfully
        }

        this.setupError = null;

        // Cleanup previous setup
        this.cleanup();
        this._context = {};

        if (!this.data.setupCode || this.data.setupCode.trim() === '') {
            this.data.setupComplete = true;
            return;
        }

        try {
            // Create async function with setup code
            const setupFunc = new AsyncFunction(
                'loadScript',
                'node',
                this.data.setupCode
            );

            // Bind 'this' to context and provide helpers
            await setupFunc.call(
                this._context,
                this.loadScript.bind(this),
                this
            );

            this.data.setupComplete = true;
        } catch (error) {
            this.setupError = error.message;
            this.data.setupComplete = false;
            console.error('JS Node setup error:', error);
            throw error;
        }
    }

    /**
     * Helper function to load external scripts
     */
    async loadScript(url) {
        return new Promise((resolve, reject) => {
            // Check if already loaded
            const existing = document.querySelector(`script[src="${url}"]`);
            if (existing) {
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = url;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load script: ${url}`));

            document.head.appendChild(script);
            this._domElements.push(script);
        });
    }

    /**
     * Execute the main code and return uniform values
     */
    execute(time, resolution, mouse) {
        // Make sure setup has run
        if (!this.data.setupComplete) {
            if (this.data.setupCode && this.data.setupCode.trim() !== '') {
                throw new Error('Setup not complete. Call runSetup() first.');
            }
        }

        if (this.setupError) {
            throw new Error(`Cannot execute - setup failed: ${this.setupError}`);
        }

        this.executeError = null;

        try {
            // Create function with main code
            const execFunc = new Function(
                'u_time',
                'u_resolution',
                'u_mouse',
                'float',
                'int',
                'vec2',
                'vec3',
                'vec4',
                this.data.code
            );

            // Execute with context binding and type wrappers
            const result = execFunc.call(
                this._context,
                time,
                resolution,
                mouse,
                this.float,
                this.int,
                this.vec2,
                this.vec3,
                this.vec4
            );

            // Process result into uniforms
            const uniforms = this.processResult(result);
            this._cachedUniforms = uniforms;

            return uniforms;

        } catch (error) {
            this.executeError = error.message;
            console.error('JS Node execution error:', error);
            throw error;
        }
    }

    /**
     * Process the return value into uniform definitions
     */
    processResult(result) {
        const uniforms = [];

        // Single value - create one output
        if (result !== null && typeof result !== 'object') {
            const uniform = this.detectUniformType(result);
            uniforms.push({
                name: this.varName,
                type: uniform.type,
                value: uniform.value
            });
        }
        // Object with multiple values
        else if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
            for (const [key, value] of Object.entries(result)) {
                const uniform = this.detectUniformType(value);
                uniforms.push({
                    name: `${this.varName}_${key}`,
                    type: uniform.type,
                    value: uniform.value
                });
            }
        }
        // Array or wrapped value
        else {
            const uniform = this.detectUniformType(result);
            uniforms.push({
                name: this.varName,
                type: uniform.type,
                value: uniform.value
            });
        }

        return uniforms;
    }

    /**
     * Auto-detect uniform type from JavaScript value
     */
    detectUniformType(value) {
        // Explicit wrapper: {type: 'float', value: 0.5}
        if (value && typeof value === 'object' && value.type && value.value !== undefined) {
            return value;
        }

        // Array [x, y, z, w]
        if (Array.isArray(value)) {
            if (value.length === 2) return { type: 'vec2', value };
            if (value.length === 3) return { type: 'vec3', value };
            if (value.length === 4) return { type: 'vec4', value };
            throw new Error(`Invalid array length for vector: ${value.length}`);
        }

        // Object {x, y, z, w}
        if (typeof value === 'object' && value !== null) {
            const hasX = 'x' in value;
            const hasY = 'y' in value;
            const hasZ = 'z' in value;
            const hasW = 'w' in value;

            if (hasX && hasY && hasZ && hasW) {
                return { type: 'vec4', value: [value.x, value.y, value.z, value.w] };
            }
            if (hasX && hasY && hasZ) {
                return { type: 'vec3', value: [value.x, value.y, value.z] };
            }
            if (hasX && hasY) {
                return { type: 'vec2', value: [value.x, value.y] };
            }
            throw new Error(`Invalid object format for vector: ${Object.keys(value).join(', ')}`);
        }

        // Number (defaults to float)
        if (typeof value === 'number') {
            return { type: 'float', value };
        }

        throw new Error(`Cannot convert to uniform: ${typeof value}`);
    }

    /**
     * Type wrapper functions (optional for users)
     */
    float(value) {
        return { type: 'float', value: Number(value) };
    }

    int(value) {
        return { type: 'int', value: Math.floor(value) };
    }

    vec2(x, y) {
        if (Array.isArray(x)) {
            return { type: 'vec2', value: [x[0], x[1]] };
        } else if (typeof x === 'object' && x !== null) {
            return { type: 'vec2', value: [x.x, x.y] };
        } else {
            return { type: 'vec2', value: [x, y] };
        }
    }

    vec3(x, y, z) {
        if (Array.isArray(x)) {
            return { type: 'vec3', value: [x[0], x[1], x[2]] };
        } else if (typeof x === 'object' && x !== null) {
            return { type: 'vec3', value: [x.x, x.y, x.z] };
        } else {
            return { type: 'vec3', value: [x, y, z] };
        }
    }

    vec4(x, y, z, w) {
        if (Array.isArray(x)) {
            return { type: 'vec4', value: [x[0], x[1], x[2], x[3]] };
        } else if (typeof x === 'object' && x !== null) {
            return { type: 'vec4', value: [x.x, x.y, x.z, x.w] };
        } else {
            return { type: 'vec4', value: [x, y, z, w] };
        }
    }

    /**
     * Cleanup DOM elements and context
     */
    cleanup() {
        // Remove any DOM elements created during setup
        this._domElements.forEach(el => {
            if (el.parentNode) {
                el.parentNode.removeChild(el);
            }
        });
        this._domElements = [];
    }

    /**
     * Override destroy to cleanup
     */
    destroy() {
        this.cleanup();
        super.destroy?.();
    }
}

// Helper to create async functions (for setup code with await)
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
