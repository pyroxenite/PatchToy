/**
 * Parser for magic comments in custom GLSL nodes
 *
 * Supports both single-line and multi-line comments
 * Parses directives like @node, @title, @category, @input, @description
 */

export class GLSLCommentParser {
    /**
     * Parse magic comments from GLSL code
     * @param {string} glslCode - The GLSL code with magic comments
     * @returns {Object} Parsed metadata and cleaned code
     */
    static parse(glslCode) {
        const metadata = {
            node: null,
            title: null,
            category: 'custom',
            inputs: {},
            description: '',
            options: {}
        };

        // Extract all comments (both single-line and multi-line)
        const comments = this.extractComments(glslCode);

        // Process each comment for directives
        for (const comment of comments) {
            this.processComment(comment, metadata);
        }

        return {
            metadata,
            code: glslCode
        };
    }

    /**
     * Extract all comments from GLSL code
     */
    static extractComments(code) {
        const comments = [];

        // Match single-line comments: // @directive
        const singleLineRegex = /\/\/\s*@(\w+)\s+([^\n]*)/g;
        let match;
        while ((match = singleLineRegex.exec(code)) !== null) {
            comments.push({
                type: 'single',
                directive: match[1],
                content: match[2].trim(),
                fullMatch: match[0]
            });
        }

        // Match multi-line comments: /* ... */
        const multiLineRegex = /\/\*([^*]|\*(?!\/))*\*\//g;
        while ((match = multiLineRegex.exec(code)) !== null) {
            const content = match[0];
            // Check if this comment contains any directives
            if (content.includes('@')) {
                comments.push({
                    type: 'multi',
                    content: content,
                    fullMatch: match[0]
                });
            }
        }

        return comments;
    }

    /**
     * Process a single comment for directives
     */
    static processComment(comment, metadata) {
        if (comment.type === 'single') {
            this.processDirective(comment.directive, comment.content, metadata);
        } else {
            // Multi-line comment - extract all directives from it
            const lines = comment.content.split('\n');
            let currentDirective = null;
            let currentContent = [];

            for (let line of lines) {
                // Remove leading/trailing whitespace, /* */ and *
                line = line.replace(/^[\s/*]+|[\s*/]+$/g, '');

                // Check if this line starts a new directive
                const directiveMatch = line.match(/^@(\w+)\s*(.*)/);
                if (directiveMatch) {
                    // Save previous directive if any
                    if (currentDirective) {
                        this.processDirective(
                            currentDirective,
                            currentContent.join('\n').trim(),
                            metadata
                        );
                    }

                    // Start new directive
                    currentDirective = directiveMatch[1];
                    currentContent = [directiveMatch[2]];
                } else if (currentDirective) {
                    // Continuation of current directive
                    currentContent.push(line);
                }
            }

            // Process last directive
            if (currentDirective) {
                this.processDirective(
                    currentDirective,
                    currentContent.join('\n').trim(),
                    metadata
                );
            }
        }
    }

    /**
     * Process a specific directive
     */
    static processDirective(directive, content, metadata) {
        switch (directive) {
            case 'node':
                metadata.node = content.trim();
                break;

            case 'title':
                metadata.title = content.trim();
                break;

            case 'category':
                metadata.category = content.trim();
                break;

            case 'input':
                this.processInputDirective(content, metadata);
                break;

            case 'description':
                metadata.description = this.processDescription(content);
                break;

            case 'option':
                this.processOptionDirective(content, metadata);
                break;
        }
    }

    /**
     * Process @input directive
     * Format: paramName "DisplayName" default="expression" defaultNode="NodeType"
     */
    static processInputDirective(content, metadata) {
        // Match: paramName "DisplayName" default="expression" defaultNode="NodeType"
        // Both default and defaultNode are optional and can be used together
        const match = content.match(/(\w+)\s+"([^"]+)"(?:\s+default\s*=\s*"([^"]+)")?(?:\s+defaultNode\s*=\s*"([^"]+)")?/);

        if (match) {
            const paramName = match[1];
            const displayName = match[2];
            const defaultValue = match[3] || null;
            const defaultNode = match[4] || null;

            metadata.inputs[paramName] = {
                displayName,
                default: defaultValue,
                defaultNode: defaultNode
            };
        }
    }

    /**
     * Process @description with special formatting rules:
     * - Strip leading whitespace and *
     * - Single newlines are ignored (continuous text)
     * - Empty lines create paragraph breaks
     */
    static processDescription(content) {
        const lines = content.split('\n').map(line => {
            // Remove leading whitespace and *
            return line.replace(/^[\s*]+/, '').trimEnd();
        });

        // Group lines into paragraphs (separated by empty lines)
        const paragraphs = [];
        let currentParagraph = [];

        for (const line of lines) {
            if (line === '') {
                if (currentParagraph.length > 0) {
                    paragraphs.push(currentParagraph.join(' '));
                    currentParagraph = [];
                }
            } else {
                currentParagraph.push(line);
            }
        }

        // Add last paragraph
        if (currentParagraph.length > 0) {
            paragraphs.push(currentParagraph.join(' '));
        }

        return paragraphs.join('\n\n');
    }

    /**
     * Process @option directive
     * Format: key value
     */
    static processOptionDirective(content, metadata) {
        const parts = content.split(/\s+/);
        if (parts.length >= 2) {
            const key = parts[0];
            const value = parts.slice(1).join(' ');
            metadata.options[key] = value;
        }
    }

    /**
     * Prettify parameter name for display
     * Examples:
     * - "position" → "Position"
     * - "pivot_point" → "Pivot Point"
     * - "waveLength" → "Wave Length"
     * - "uv" → "UV"
     */
    static prettifyParamName(name) {
        // Special cases
        if (name === 'uv') return 'UV';

        // Convert camelCase to space-separated: "waveLength" → "wave Length"
        let result = name.replace(/([a-z])([A-Z])/g, '$1 $2');

        // Convert snake_case to space-separated: "pivot_point" → "pivot point"
        result = result.replace(/_/g, ' ');

        // Capitalize first letter of each word
        result = result.replace(/\b\w/g, char => char.toUpperCase());

        return result;
    }

    /**
     * Generate default magic comments for GLSL code without any
     * @param {string} glslCode - The GLSL code
     * @returns {string} Code with generated magic comments prepended
     */
    static generateDefaultComments(glslCode) {
        // Parse existing code to find main function
        const funcMatch = glslCode.match(/(\w+)\s+(\w+)\s*\((.*?)\)/);

        if (!funcMatch) {
            return glslCode;
        }

        const returnType = funcMatch[1];
        const funcName = funcMatch[2];
        const paramsString = funcMatch[3];

        // Parse parameters
        const params = [];
        if (paramsString.trim()) {
            const paramList = paramsString.split(',').map(p => p.trim());
            for (const param of paramList) {
                const parts = param.split(/\s+/);
                if (parts.length >= 2) {
                    const type = parts[0];
                    const name = parts[1];
                    params.push({ type, name });
                }
            }
        }

        // Generate comment block
        let comment = `/* \n * @node ${funcName}\n`;
        comment += ` * @title ${funcName}\n`;
        comment += ` * @category custom\n * \n`;

        // Add input directives
        for (const param of params) {
            const prettyName = this.prettifyParamName(param.name);
            comment += ` * @input ${param.name} "${prettyName}"\n`;
        }

        comment += ` * \n * @description\n`;
        comment += ` */\n\n`;

        return comment + glslCode;
    }

    /**
     * Check if code already has magic comments
     */
    static hasComments(glslCode) {
        return /@node|@title|@category|@input|@description/.test(glslCode);
    }

    /**
     * Extract all function names from GLSL code
     */
    static extractFunctions(glslCode) {
        const functions = [];
        const regex = /(\w+)\s+(\w+)\s*\([^)]*\)\s*\{/g;
        let match;

        while ((match = regex.exec(glslCode)) !== null) {
            functions.push({
                returnType: match[1],
                name: match[2]
            });
        }

        return functions;
    }

    /**
     * Validate metadata against actual code
     * @returns {Object} { valid: boolean, errors: string[] }
     */
    static validate(metadata, glslCode) {
        const errors = [];
        const functions = this.extractFunctions(glslCode);

        // If @node is specified, it must match an actual function
        if (metadata.node) {
            const found = functions.find(f => f.name === metadata.node);
            if (!found) {
                errors.push(`@node "${metadata.node}" does not match any function in the code`);
            }
        }

        // If multiple functions exist, @node is required
        if (functions.length > 1 && !metadata.node) {
            errors.push(`Multiple functions found, @node directive is required`);
        }

        // Validate @input directives match function parameters
        if (metadata.node || functions.length === 1) {
            const mainFunc = metadata.node
                ? functions.find(f => f.name === metadata.node)
                : functions[0];

            if (mainFunc) {
                const funcMatch = glslCode.match(
                    new RegExp(`${mainFunc.returnType}\\s+${mainFunc.name}\\s*\\(([^)]*)\\)`)
                );

                if (funcMatch) {
                    const paramsString = funcMatch[1];
                    const actualParams = new Set();

                    if (paramsString.trim()) {
                        const paramList = paramsString.split(',').map(p => p.trim());
                        for (const param of paramList) {
                            const parts = param.split(/\s+/);
                            if (parts.length >= 2) {
                                actualParams.add(parts[1]);
                            }
                        }
                    }

                    // Check that all @input directives reference actual parameters
                    for (const inputName of Object.keys(metadata.inputs)) {
                        if (!actualParams.has(inputName)) {
                            errors.push(`@input "${inputName}" does not match any parameter in function ${mainFunc.name}`);
                        }
                    }
                }
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }
}