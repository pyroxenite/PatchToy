/**
 * TypeRegistry - Central type system for primitives and structs
 *
 * Manages type definitions, validation, and GLSL code generation
 */

export const TypeRegistry = {
    types: {},

    /**
     * Initialize with primitive types
     */
    init() {
        // Special type that defers type checking to the node
        this.registerSpecialType('any');

        // Primitive types
        this.registerPrimitive('float', 'float');
        this.registerPrimitive('int', 'int');
        this.registerPrimitive('bool', 'bool');
        this.registerPrimitive('vec2', 'vec2');
        this.registerPrimitive('vec3', 'vec3');
        this.registerPrimitive('vec4', 'vec4');
        this.registerPrimitive('mat2', 'mat2');
        this.registerPrimitive('mat3', 'mat3');
        this.registerPrimitive('mat4', 'mat4');
        this.registerPrimitive('sampler2D', 'sampler2D');

        // Register built-in structs
        this.registerStruct('Camera', [
            { name: 'position', type: 'vec3' },
            { name: 'target', type: 'vec3' },
            { name: 'fov', type: 'float' }
        ], 'A camera with position, target, and field of view');

        this.registerStruct('Ray', [
            { name: 'origin', type: 'vec3' },
            { name: 'direction', type: 'vec3' }
        ], 'A ray with origin and direction for raymarching');
    },

    /**
     * Register a special type (like 'any')
     */
    registerSpecialType(name) {
        this.types[name] = {
            name,
            isSpecial: true,
            isPrimitive: false,
            isAny: name === 'any'
        };
    },

    /**
     * Register a primitive type
     */
    registerPrimitive(name, glslType) {
        this.types[name] = {
            name,
            isPrimitive: true,
            glslType,
            componentCount: this.getComponentCount(glslType)
        };
    },

    /**
     * Register a struct type
     */
    registerStruct(name, members, description = '') {
        // Validate that all member types exist
        for (const member of members) {
            if (!this.types[member.type]) {
                throw new Error(`Cannot register struct ${name}: member type ${member.type} is not registered`);
            }
        }

        this.types[name] = {
            name,
            isPrimitive: false,
            isStruct: true,
            members,
            description
        };
    },

    /**
     * Get type definition
     */
    getType(typeName) {
        return this.types[typeName];
    },

    /**
     * Check if a type exists
     */
    hasType(typeName) {
        return typeName in this.types;
    },

    /**
     * Check if a type is a primitive
     */
    isPrimitive(typeName) {
        const type = this.types[typeName];
        return type && type.isPrimitive;
    },

    /**
     * Check if a type is a struct
     */
    isStruct(typeName) {
        const type = this.types[typeName];
        return type && type.isStruct;
    },

    /**
     * Check if a type is the 'any' type
     */
    isAny(typeName) {
        const type = this.types[typeName];
        return type && type.isAny;
    },

    /**
     * Get component count for primitive types
     */
    getComponentCount(glslType) {
        const counts = {
            'float': 1,
            'int': 1,
            'bool': 1,
            'vec2': 2,
            'vec3': 3,
            'vec4': 4,
            'mat2': 4,
            'mat3': 9,
            'mat4': 16,
            'sampler2D': 0
        };
        return counts[glslType] || 0;
    },

    /**
     * Parse multi-level accessor (e.g., ".position.xy")
     * Returns { structPath: ['position'], swizzle: 'xy' }
     */
    parseAccessor(accessor) {
        if (!accessor || accessor === '') {
            return { structPath: [], swizzle: null };
        }

        // Remove leading dot
        const path = accessor.startsWith('.') ? accessor.slice(1) : accessor;
        const parts = path.split('.');

        const structPath = [];
        let swizzle = null;

        for (const part of parts) {
            if (this.isSwizzleComponent(part)) {
                // This is a swizzle - must be last part
                swizzle = part;
                break;
            } else {
                // This is a struct member name
                structPath.push(part);
            }
        }

        return { structPath, swizzle };
    },

    /**
     * Check if a string is a valid swizzle component
     */
    isSwizzleComponent(str) {
        // Valid swizzles: x, xy, xyz, xyzw, r, rg, rgb, rgba, etc.
        return /^[xyzw]{1,4}$/.test(str) || /^[rgba]{1,4}$/.test(str);
    },

    /**
     * Resolve type after applying accessor
     * Example: resolveAccessorType('Camera', '.position.xy') -> 'vec2'
     */
    resolveAccessorType(baseTypeName, accessor) {
        if (!accessor || accessor === '') {
            return baseTypeName;
        }

        const { structPath, swizzle } = this.parseAccessor(accessor);
        let currentType = baseTypeName;

        // Walk through struct path
        for (const memberName of structPath) {
            const typeDef = this.types[currentType];

            if (!typeDef) {
                throw new Error(`Type ${currentType} is not registered`);
            }

            if (typeDef.isPrimitive) {
                throw new Error(`Cannot access member .${memberName} on primitive type ${currentType}`);
            }

            const member = typeDef.members.find(m => m.name === memberName);
            if (!member) {
                throw new Error(`Struct ${currentType} has no member named ${memberName}`);
            }

            currentType = member.type;
        }

        // Apply swizzle if present
        if (swizzle) {
            currentType = this.applySwizzle(currentType, swizzle);
        }

        return currentType;
    },

    /**
     * Apply swizzle to a type
     * Example: applySwizzle('vec3', 'xy') -> 'vec2'
     */
    applySwizzle(typeName, swizzle) {
        const typeDef = this.types[typeName];

        if (!typeDef || !typeDef.isPrimitive) {
            throw new Error(`Cannot swizzle non-primitive type ${typeName}`);
        }

        const baseComponents = typeDef.componentCount;
        const swizzleLength = swizzle.length;

        // Validate swizzle is within bounds
        for (const char of swizzle) {
            const index = this.getSwizzleIndex(char);
            if (index >= baseComponents) {
                throw new Error(`Invalid swizzle .${swizzle} for type ${typeName} (out of bounds)`);
            }
        }

        // Return appropriate vector type based on swizzle length
        if (swizzleLength === 1) return 'float';
        if (swizzleLength === 2) return 'vec2';
        if (swizzleLength === 3) return 'vec3';
        if (swizzleLength === 4) return 'vec4';

        throw new Error(`Invalid swizzle length: ${swizzleLength}`);
    },

    /**
     * Get component index for swizzle character
     */
    getSwizzleIndex(char) {
        const indices = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
        return indices[char] ?? -1;
    },

    /**
     * Generate GLSL struct definition code
     */
    generateStructDefinition(typeName) {
        const typeDef = this.types[typeName];

        if (!typeDef || typeDef.isPrimitive) {
            return '';
        }

        let code = `struct ${typeName} {\n`;
        for (const member of typeDef.members) {
            code += `    ${member.type} ${member.name};\n`;
        }
        code += `};\n`;

        return code;
    },

    /**
     * Generate GLSL blend function for a type
     * Recursively generates blend functions for nested structs
     */
    generateBlendFunction(typeName, generatedFunctions = new Set()) {
        // Already generated
        if (generatedFunctions.has(typeName)) {
            return '';
        }

        const typeDef = this.types[typeName];

        // Primitives use built-in mix()
        if (typeDef.isPrimitive) {
            return '';
        }

        let code = '';

        // First, generate blend functions for all nested struct members
        for (const member of typeDef.members) {
            if (this.isStruct(member.type)) {
                code += this.generateBlendFunction(member.type, generatedFunctions);
            }
        }

        // Then generate this struct's blend function
        code += `${typeName} blend${typeName}(${typeName} a, ${typeName} b, float t) {\n`;
        code += `    ${typeName} result;\n`;

        for (const member of typeDef.members) {
            if (this.isStruct(member.type)) {
                // Use nested struct's blend function
                code += `    result.${member.name} = blend${member.type}(a.${member.name}, b.${member.name}, t);\n`;
            } else {
                // Use built-in mix for primitives
                code += `    result.${member.name} = mix(a.${member.name}, b.${member.name}, t);\n`;
            }
        }

        code += `    return result;\n`;
        code += `}\n\n`;

        generatedFunctions.add(typeName);
        return code;
    },

    /**
     * Generate all GLSL code needed for a struct type
     * (definition + blend function)
     */
    generateStructGLSL(typeName) {
        let code = '';

        // Generate struct definition
        code += this.generateStructDefinition(typeName);
        code += '\n';

        // Generate blend function
        code += this.generateBlendFunction(typeName);

        return code;
    },

    /**
     * Get all struct types used in a type (recursively)
     */
    getDependentStructs(typeName, visited = new Set()) {
        if (visited.has(typeName)) {
            return [];
        }

        visited.add(typeName);

        const typeDef = this.types[typeName];
        if (!typeDef || typeDef.isPrimitive) {
            return [];
        }

        const structs = [typeName];

        for (const member of typeDef.members) {
            if (this.isStruct(member.type)) {
                structs.push(...this.getDependentStructs(member.type, visited));
            }
        }

        return structs;
    }
};

// Initialize on load
TypeRegistry.init();
