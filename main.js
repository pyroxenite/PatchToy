import { NodeGraph } from './src/core/NodeGraph.js';
import { ShaderCompiler } from './src/core/ShaderCompiler.js';
import { NodeDefinitions } from './src/core/NodeDefinitions.js';
import { ApiClient } from './src/services/ApiClient.js';
import { ProjectManager } from './src/managers/ProjectManager.js';
import { CompilationManager } from './src/managers/CompilationManager.js';
import { UniformRegistry } from './src/managers/UniformRegistry.js';
import { FeedbackRenderer } from './src/rendering/FeedbackRenderer.js';
import { BackgroundRenderer } from './src/rendering/BackgroundRenderer.js';
import { AuthDialogs } from './src/ui/AuthDialogs.js';
import { NodeDialogs } from './src/ui/NodeDialogs.js';
import { ProjectDialogs } from './src/ui/ProjectDialogs.js';
import { UIHelpers } from './src/ui/UIHelpers.js';
import { GLSLCommentParser } from './src/utils/GLSLCommentParser.js';
import { FloatingCodeEditor } from './src/ui/FloatingCodeEditor.js';

class PatchToy {
    constructor() {
        // DOM elements
        this.nodeCanvas = document.getElementById('nodeCanvas');
        this.videoElement = document.getElementById('cameraVideo');
        this.addNodeBtn = document.getElementById('addNodeBtn');

        // Create shared WebGL context for all rendering
        this.sharedGLCanvas = document.createElement('canvas');
        this.sharedGLCanvas.width = 512;
        this.sharedGLCanvas.height = 512;
        this.sharedGL = this.sharedGLCanvas.getContext('webgl2') || this.sharedGLCanvas.getContext('webgl');

        if (!this.sharedGL) {
            console.error('Failed to create shared WebGL context');
            alert('WebGL not supported - PatchToy requires WebGL to run');
        }

        // Core instances
        this.uniformRegistry = new UniformRegistry();
        this.nodeGraph = new NodeGraph(this.nodeCanvas, this.videoElement);
        this.nodeGraph.addNodeButton = this.addNodeBtn;
        this.nodeGraph.sharedGL = this.sharedGL; // Pass to node graph for creating preview nodes
        this.nodeGraph.uniformRegistry = this.uniformRegistry; // Pass registry to node graph
        this.shaderCompiler = new ShaderCompiler();
        this.apiClient = new ApiClient();

        // Managers
        this.projectManager = new ProjectManager(this.nodeGraph, this.apiClient);
        this.backgroundRenderer = new BackgroundRenderer(this.nodeCanvas, this.videoElement, this.sharedGL, this.uniformRegistry);
        this.backgroundRenderer.graph = this.nodeGraph; // Pass graph reference for video node access
        this.feedbackRenderer = new FeedbackRenderer(this.nodeGraph, this.shaderCompiler, this.sharedGL, this.uniformRegistry);
        this.compilationManager = new CompilationManager(this.nodeGraph, this.shaderCompiler, null, this.backgroundRenderer, this.feedbackRenderer);

        // State
        this.cameraEnabled = false;
        this.isPlaying = true;

        // Create persistent color input for color picker
        this.colorInput = this.createColorInput();

        this.setupEventListeners();
        this.init();
        this.startAnimationLoop();
    }

    startAnimationLoop() {
        const animate = () => {
            // Render feedback nodes every frame
            this.feedbackRenderer.renderFeedbackNodes();
            requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }

    createColorInput() {
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.style.cssText = 'position: absolute; visibility: hidden;';
        document.body.appendChild(colorInput);

        // Handle color input changes
        colorInput.addEventListener('input', (e) => {
            if (colorInput._currentNode && colorInput._onColorChange) {
                const hex = e.target.value;
                const r = parseInt(hex.slice(1, 3), 16) / 255;
                const g = parseInt(hex.slice(3, 5), 16) / 255;
                const b = parseInt(hex.slice(5, 7), 16) / 255;

                colorInput._currentNode.data.r = r;
                colorInput._currentNode.data.g = g;
                colorInput._currentNode.data.b = b;

                colorInput._onColorChange();
            }
        });

        // Clear reference when picker is closed
        colorInput.addEventListener('change', () => {
            colorInput._currentNode = null;
            colorInput._onColorChange = null;
        });

        return colorInput;
    }

    setupEventListeners() {
        // Add node button
        this.addNodeBtn.addEventListener('click', (e) => {
            this.nodeGraph.quickNodeSearch.show(e.currentTarget);
        });

        // Node right-click handlers
        this.nodeGraph.onNodeRightClick = (node, e) => {
            const definition = NodeDefinitions[node.type];
            if (definition && definition.isCustomNode) {
                NodeDialogs.showEditNodeDialog(node, definition, (nodeName, glslCode) => {
                    const result = this.createCustomNode(nodeName, glslCode);
                    this.compilationManager.scheduleCompile();
                    // Return the final code so the editor can update
                    return result.success ? result.finalCode : null;
                });
            } else if (definition && definition.hasColorPicker) {
                NodeDialogs.showColorPicker(node, this.colorInput, this.nodeCanvas, () => {
                    this.nodeGraph.render();
                    if (this.nodeGraph.onGraphChanged) this.nodeGraph.onGraphChanged();
                });
            }
        };

        // Custom node creation request
        this.nodeGraph.onCustomNodeRequested = () => {
            NodeDialogs.showCustomNodeDialog((nodeName, glslCode) => {
                const result = this.createCustomNode(nodeName, glslCode);
                if (result.success) {
                    this.nodeGraph.addNode(nodeName, 200, 200);
                }
                return result.success;
            });
        };

        // Custom node deletion request
        this.nodeGraph.onCustomNodeDelete = (nodeName) => {
            this.deleteCustomNode(nodeName);
        };

        // Preview node code inspect
        this.nodeGraph.onPreviewCodeInspect = (node) => {
            // Try to get shader from last compilation (works even if compilation failed)
            const shaderSource = node?.lastCompiledShader?.fragment ||
                                 node?.renderer?.currentShaderSource?.fragment;
            NodeDialogs.showGeneratedCode(shaderSource);
        };

        // Preview node fullscreen
        this.nodeGraph.onPreviewFullscreen = (node) => {
            UIHelpers.showPreviewNodeFullscreen(node, () => {
                this.nodeGraph.render();
            });
        };

        // Preview node background toggle
        this.nodeGraph.onPreviewBackground = (node) => {
            // Handle null (clearing background)
            if (!node) {
                this.backgroundRenderer.setActivePreviewNode(null);
                // Clear all isBackground flags
                for (const n of this.nodeGraph.nodes) {
                    if (n.isPreviewNode) {
                        n.isBackground = false;
                    }
                }
                this.nodeGraph.render();
                return;
            }

            // Toggle: if this node is already background, disable it
            if (this.backgroundRenderer.isActive(node)) {
                this.backgroundRenderer.setActivePreviewNode(null);
                node.isBackground = false;
            } else {
                // Set this node as background and clear other nodes
                for (const n of this.nodeGraph.nodes) {
                    if (n.isPreviewNode) {
                        n.isBackground = false;
                    }
                }
                this.backgroundRenderer.setActivePreviewNode(node);
                node.isBackground = true;
            }
            this.nodeGraph.render();
        };

        // Pass background renderer to node graph for rendering
        this.nodeGraph.backgroundRenderer = this.backgroundRenderer;

        // Paste GLSL functions
        window.addEventListener('paste', (e) => {
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
                return;
            }

            const text = e.clipboardData.getData('text');
            if (this.isGLSLFunction(text)) {
                e.preventDefault();
                this.createNodeFromPastedGLSL(text);
            }
        });

        // Play/Stop button
        const playStopBtn = document.getElementById('playStopBtn');
        playStopBtn.addEventListener('click', () => {
            this.isPlaying = !this.isPlaying;

            if (this.isPlaying) {
                playStopBtn.classList.add('active');
                playStopBtn.textContent = '▶️';
                playStopBtn.title = 'Playing - auto-compile enabled';
                this.compilationManager.setAutoCompile(true);
                this.compilationManager.scheduleCompile();
            } else {
                playStopBtn.classList.remove('active');
                playStopBtn.textContent = '⏹';
                playStopBtn.title = 'Stopped - changes ignored';
                this.compilationManager.setAutoCompile(false);
            }
        });

        // Camera button
        document.getElementById('cameraBtn').addEventListener('click', async () => {
            await UIHelpers.enableAllCameras(this.nodeGraph);
        });

        // Microphone button
        document.getElementById('micBtn').addEventListener('click', async () => {
            await UIHelpers.enableAllMicrophones(this.nodeGraph);
        });

        // MIDI button
        document.getElementById('midiBtn').addEventListener('click', async () => {
            await UIHelpers.enableMIDI();
        });

        // Load file input
        document.getElementById('loadFileInput').addEventListener('change', async (e) => {
            // Close all open editors before loading new project
            FloatingCodeEditor.closeAll();

            const result = await this.projectManager.loadProjectFromFile(
                e.target.files[0],
                (name, glsl, skipSave) => this.createCustomNode(name, glsl, skipSave),
                () => this.saveCustomNodes()
            );
            if (result && result.success) {
                this.compilationManager.scheduleCompile();
                // Restore editor states from the loaded project
                this.restoreEditorStates(result.editorStates);
            }
            e.target.value = ''; // Reset file input
        });

        // Project menu button
        document.getElementById('projectMenuBtn').addEventListener('click', () => {
            ProjectDialogs.showProjectMenu({
                apiClient: this.apiClient,
                projectTitle: this.projectManager.projectTitle,
                currentProjectId: this.projectManager.currentProjectId,
                onProjectTitleChange: (title) => this.projectManager.setProjectTitle(title),
                onNewProject: () => this.handleNewProject(),
                onShowCurrentProjectMenu: (anchorBtn) => {
                    ProjectDialogs.showCurrentProjectMenu({
                        anchorBtn,
                        onDownload: () => this.projectManager.saveProjectToFile()
                    });
                },
                onLoadLocalClick: () => document.getElementById('loadFileInput').click(),
                onLoadCloudProject: async (projectId) => {
                    // Close all open editors before loading cloud project
                    FloatingCodeEditor.closeAll();

                    const result = await this.projectManager.loadCloudProject(projectId, (name, glsl) => this.createCustomNode(name, glsl));
                    if (result && result.success) {
                        // Restore editor states if present
                        if (result.editorStates && result.editorStates.length > 0) {
                            FloatingCodeEditor.restoreAllStates(result.editorStates, this.nodeGraph.nodes);
                        }
                        this.compilationManager.scheduleCompile();
                        // Update UI to show save button
                        UIHelpers.updateAccountButton(this.apiClient);
                    }
                },
                onShowProjectOptionsMenu: (project, anchorBtn, listItem) => {
                    ProjectDialogs.showProjectOptionsMenu({
                        project,
                        anchorBtn,
                        listItem,
                        apiClient: this.apiClient,
                        currentProjectId: this.projectManager.currentProjectId,
                        onProjectDeleted: (deletedProjectId) => {
                            if (this.projectManager.currentProjectId === deletedProjectId) {
                                this.projectManager.clearProject();
                            }
                        }
                    });
                }
            });
        });

        // Save to cloud button
        document.getElementById('saveCloudBtn').addEventListener('click', async () => {
            const result = await this.projectManager.saveToCloud();
            if (result.needsLogin) {
                AuthDialogs.showLogin(this.apiClient, () => {
                    UIHelpers.updateAccountButton(this.apiClient);
                });
            } else if (result.needsName) {
                // Just save with current project title
                try {
                    await this.projectManager.saveNewProject(this.projectManager.projectTitle, result.projectData);
                    alert('Project saved to cloud!');
                } catch (err) {
                    alert('Failed to save project: ' + err.message);
                }
            } else if (result.success) {
                alert('Project updated!');
            }
        });

        // Account button
        document.getElementById('accountBtn').addEventListener('click', () => {
            if (this.apiClient.isLoggedIn()) {
                UIHelpers.showAccountMenu(this.apiClient, () => {
                    this.apiClient.logout();
                    UIHelpers.updateAccountButton(this.apiClient);
                    this.projectManager.clearProject();
                });
            } else {
                AuthDialogs.showLogin(this.apiClient, () => {
                    UIHelpers.updateAccountButton(this.apiClient);
                });
            }
        });

        // Window resize
        window.addEventListener('resize', () => this.resize());

        // Graph changes
        this.nodeGraph.onGraphChanged = () => {
            // Mark project as dirty (has unsaved changes)
            this.projectManager.markDirty();

            // CRITICAL: Create global node ID mapping ONCE before ANY compilation
            // This ensures feedback shaders and preview shaders use consistent variable names
            this.compilationManager.createGlobalNodeIdMapping();

            // Compile feedback shaders first (uses the global ID mapping)
            this.feedbackRenderer.compileFeedbackShaders();
            this.feedbackRenderer.renderFeedbackNodes();

            // Then schedule main compilation (reuses the same global ID mapping)
            this.compilationManager.scheduleCompile();
            // Note: markDirty() already calls saveGraph()
        };

        // Uniform value changes (no recompilation needed)
        this.nodeGraph.onUniformValueChanged = (node) => {
            this.compilationManager.updateUniformsForNode(node);
            // Debounce save to avoid lag during dragging
            this.debouncedSave();
        };

        // Debounced save for uniform updates
        this.saveTimeout = null;
        this.debouncedSave = () => {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
            }
            this.saveTimeout = setTimeout(() => {
                this.projectManager.saveGraph();
            }, 500); // Save after 500ms of no changes
        };
    }

    async toggleCamera() {
        if (this.cameraEnabled) {
            // Disable camera
            if (this.cameraStream) {
                this.cameraStream.getTracks().forEach(track => track.stop());
                this.cameraStream = null;
            }
            this.videoElement.srcObject = null;
            this.cameraEnabled = false;
            console.log('Camera disabled');
            return false;
        } else {
            // Enable camera
            try {
                this.cameraStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'user' },
                    audio: false
                });
                this.videoElement.srcObject = this.cameraStream;
                await this.videoElement.play();
                this.cameraEnabled = true;
                console.log('Camera enabled');
                return true;
            } catch (error) {
                console.error('Failed to enable camera:', error);
                return false;
            }
        }
    }

    handleNewProject() {
        // Check if there are nodes in the current graph
        const hasNodes = this.nodeGraph.nodes.length > 0;

        if (hasNodes) {
            // Ask if user wants to save first
            const save = confirm('Do you want to save the current project before creating a new one?');

            if (save) {
                // If logged in, save to cloud
                if (this.apiClient.isLoggedIn()) {
                    this.projectManager.saveToCloud().then(result => {
                        if (result.success || result.needsName) {
                            // If save succeeded or was handled, create new project
                            this.createNewProject();
                        }
                        // If user cancelled save dialog, don't create new project
                    });
                } else {
                    // Not logged in, download to file
                    this.projectManager.saveProjectToFile();
                    // Create new project after a brief delay to allow download
                    setTimeout(() => this.createNewProject(), 100);
                }
            } else {
                // User doesn't want to save, just create new project
                this.createNewProject();
            }
        } else {
            // No nodes, just create new project
            this.createNewProject();
        }
    }

    createNewProject() {
        // Close all open editors (saves states before closing)
        FloatingCodeEditor.closeAll();

        // Clear the graph
        this.nodeGraph.nodes = [];
        this.nodeGraph.connections = [];
        this.nodeGraph.nextNodeId = 0;
        this.nodeGraph.panX = 0;
        this.nodeGraph.panY = 0;

        // Clear background renderer
        if (this.backgroundRenderer) {
            this.backgroundRenderer.setActivePreviewNode(null);
        }

        // Reset project info
        this.projectManager.projectTitle = 'Untitled Project';
        this.projectManager.currentProjectId = null;
        this.projectManager.viewingSharedProject = null;
        document.getElementById('projectTitleDisplay').textContent = 'Untitled Project';

        // Save the empty graph and trigger compilation
        this.projectManager.saveGraph();
        this.compilationManager.compile();
        this.nodeGraph.render();
    }

    createCustomNode(nodeName, glslCode, skipSave = false) {
        // Auto-generate default magic comments if none exist
        let finalCode = glslCode;
        if (!GLSLCommentParser.hasComments(glslCode)) {
            finalCode = GLSLCommentParser.generateDefaultComments(glslCode);
        }

        // Parse magic comments
        const { metadata, code } = GLSLCommentParser.parse(finalCode);

        // Validate the metadata
        const validation = GLSLCommentParser.validate(metadata, code);
        if (!validation.valid) {
            alert('Magic comment validation failed:\n' + validation.errors.join('\n'));
            return false;
        }

        // Extract all functions from code
        const functions = GLSLCommentParser.extractFunctions(code);
        if (functions.length === 0) {
            alert('Could not parse GLSL function. Please ensure it has a valid signature like: vec3 myFunc(vec2 uv)');
            return false;
        }

        // Determine main function
        let mainFunction;
        if (metadata.node) {
            mainFunction = functions.find(f => f.name === metadata.node);
        } else if (functions.length === 1) {
            mainFunction = functions[0];
        } else {
            alert('Multiple functions found but no @node directive specified');
            return false;
        }

        if (!mainFunction) {
            alert('Could not determine main function');
            return false;
        }

        // Parse function parameters
        const funcMatch = code.match(
            new RegExp(`${mainFunction.returnType}\\s+${mainFunction.name}\\s*\\(([^)]*)\\)`)
        );

        if (!funcMatch) {
            alert('Could not parse function parameters');
            return false;
        }

        const paramsString = funcMatch[1];
        const inputs = [];

        if (paramsString.trim()) {
            const params = paramsString.split(',').map(p => p.trim());
            for (const param of params) {
                const parts = param.split(/\s+/);
                if (parts.length >= 2) {
                    const type = parts[0];
                    const name = parts[1];

                    // Check if there's custom metadata for this input
                    const inputMeta = metadata.inputs[name];

                    inputs.push({
                        name,
                        type,
                        displayName: inputMeta?.displayName || name,
                        default: inputMeta?.default || null,
                        defaultNode: inputMeta?.defaultNode || null
                    });
                }
            }
        }

        // Use title from metadata, or function name if not specified
        const displayTitle = metadata.title || mainFunction.name;

        // Create the node definition
        NodeDefinitions[nodeName] = {
            category: metadata.category,
            inputs: inputs.map(inp => {
                const inputDef = {
                    name: inp.displayName || inp.name,
                    type: inp.type,
                    paramName: inp.name  // Store original param name for function calls
                };
                // Include defaultNode if specified
                if (inp.defaultNode) {
                    inputDef.defaultNode = inp.defaultNode;
                }
                return inputDef;
            }),
            outputs: [{ name: '', type: mainFunction.returnType }],
            customGLSL: finalCode,
            isCustomNode: true,
            displayTitle: displayTitle,
            description: metadata.description,
            glsl: (node, inputValues) => {
                // Build the function call with proper default values
                // inputValues is indexed by display name (input.name)
                const args = inputs.map((inp) => {
                    const displayName = inp.displayName || inp.name;
                    if (inputValues[displayName]) {
                        return inputValues[displayName];
                    }

                    // Use custom default from @input directive if available
                    if (inp.default) {
                        return inp.default;
                    }

                    // Generate appropriate default value based on type
                    const type = inp.type;
                    if (type === 'float') return '0.0';
                    if (type === 'int') return '0';
                    if (type === 'bool') return 'false';

                    const vecMatch = type.match(/vec(\d+)/);
                    if (vecMatch) {
                        return `vec${vecMatch[1]}(0.0)`;
                    }

                    const matMatch = type.match(/mat(\d+)/);
                    if (matMatch) {
                        return `mat${matMatch[1]}(1.0)`;
                    }

                    return '0.0';
                }).join(', ');

                return {
                    // Function definitions go in preamble (outside main)
                    preamble: code,
                    // Only the function call goes in main
                    code: `${mainFunction.returnType} ${node.varName} = ${mainFunction.name}(${args});`,
                    output: node.varName
                };
            }
        };

        if (!skipSave) {
            this.saveCustomNodes();
        }

        this.nodeGraph.refreshNodesOfType(nodeName, { preserveData: true });

        return { success: true, finalCode };
    }

    deleteCustomNode(nodeName) {
        // Remove from NodeDefinitions
        delete NodeDefinitions[nodeName];

        // Remove all instances of this node from the graph
        const nodesToRemove = this.nodeGraph.nodes.filter(n => n.type === nodeName);
        for (const node of nodesToRemove) {
            this.nodeGraph.deleteNode(node);
        }

        // Save updated custom nodes list
        this.saveCustomNodes();

        // Refresh UI
        this.nodeGraph.render();
        this.compilationManager.scheduleCompile();
    }

    saveCustomNodes() {
        try {
            const customNodes = {};
            for (const [name, def] of Object.entries(NodeDefinitions)) {
                if (def.isCustomNode) {
                    customNodes[name] = {
                        category: def.category,
                        inputs: def.inputs,
                        outputs: def.outputs,
                        customGLSL: def.customGLSL
                    };
                }
            }
            localStorage.setItem('patchtoy_custom_nodes', JSON.stringify(customNodes));
        } catch (e) {
            console.error('Failed to save custom nodes:', e);
        }
    }

    loadCustomNodes() {
        try {
            const saved = localStorage.getItem('patchtoy_custom_nodes');
            if (saved) {
                const customNodes = JSON.parse(saved);
                for (const [name, nodeData] of Object.entries(customNodes)) {
                    this.createCustomNode(name, nodeData.customGLSL, true);
                }
                return true;
            }
        } catch (e) {
            console.error('Failed to load custom nodes:', e);
        }
        return false;
    }

    isGLSLFunction(text) {
        const functionPattern = /^\s*(\w+)\s+(\w+)\s*\([^)]*\)\s*\{/;
        return functionPattern.test(text.trim());
    }

    createNodeFromPastedGLSL(glslCode) {
        const funcMatch = glslCode.match(/(\w+)\s+(\w+)\s*\(/);
        if (!funcMatch) return;

        const nodeName = funcMatch[2];

        // Check if node already exists
        let finalName = nodeName;
        let counter = 1;
        while (NodeDefinitions[finalName]) {
            finalName = `${nodeName}_${counter}`;
            counter++;
        }

        // Create the custom node
        const result = this.createCustomNode(finalName, glslCode);
        if (result.success) {
            this.nodeGraph.addNode(finalName, this.nodeGraph.mouseX, this.nodeGraph.mouseY);
            this.nodeGraph.render();
            this.compilationManager.showSuccess(`Created custom node: ${finalName}`);
        }
    }

    restoreEditorStates(editorStates) {
        if (!editorStates || editorStates.length === 0) return;

        // Restore each editor
        editorStates.forEach(state => {
            const nodeType = state.nodeType;
            const definition = NodeDefinitions[nodeType];

            if (definition && definition.customGLSL) {
                // Create a dummy node for the dialog
                const dummyNode = { type: nodeType };

                // Show editor with saved state
                NodeDialogs.showEditNodeDialog(
                    dummyNode,
                    definition,
                    (nodeName, glslCode) => {
                        const result = this.createCustomNode(nodeName, glslCode);
                        this.compilationManager.scheduleCompile();
                        return result.success ? result.finalCode : null;
                    },
                    state // Pass saved state for position/size
                );
            }
        });
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;

        // Node canvas
        const nodeRect = this.nodeCanvas.getBoundingClientRect();
        this.nodeCanvas.width = nodeRect.width * dpr;
        this.nodeCanvas.height = nodeRect.height * dpr;

        const ctx = this.nodeCanvas.getContext('2d');
        // Reset transform before scaling to prevent cumulative scaling
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);

        // Set default text properties to ensure consistency
        ctx.font = '12px "Pixeloid Sans"';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Update background renderer canvas size
        if (this.backgroundRenderer) {
            this.backgroundRenderer.updateCanvasSize();
        }

        this.nodeGraph.render();
    }

    async init() {
        this.resize();

        // Load custom nodes first
        this.loadCustomNodes();

        // Check if URL contains password reset token
        const urlParams = new URLSearchParams(window.location.search);
        const resetToken = urlParams.get('reset');

        if (resetToken && this.apiClient.isEnabled()) {
            // Show password reset dialog
            AuthDialogs.showResetPassword(this.apiClient, resetToken);
            // Clear the token from URL
            window.history.replaceState({}, document.title, window.location.pathname);
            return;
        }

        // Check if URL contains shared project
        const sharedProjectId = urlParams.get('project');

        if (sharedProjectId && this.apiClient.isEnabled()) {
            // Try to load shared project
            try {
                const result = await this.projectManager.loadCloudProject(
                    sharedProjectId,
                    (name, glsl) => this.createCustomNode(name, glsl)
                );

                if (result && result.success) {
                    // Restore editor states if present
                    if (result.editorStates && result.editorStates.length > 0) {
                        FloatingCodeEditor.restoreAllStates(result.editorStates, this.nodeGraph.nodes);
                    }

                    this.nodeGraph.render();

                    // Show notification if viewing someone else's project
                    if (this.projectManager.projectState && !this.projectManager.projectState.isOwner) {
                        setTimeout(() => {
                            const username = this.projectManager.projectState.ownerUsername;
                            const title = this.projectManager.projectState.title;
                            alert(`Viewing "${title}" by @${username}\n\nAny changes you save will create your own copy.`);
                        }, 500);
                    }

                    // Compile the shader
                    this.compilationManager.scheduleCompile();

                    // Update UI to show save button
                    UIHelpers.updateAccountButton(this.apiClient);

                    // KEEP URL parameter (don't clear it!) so users can share the URL
                } else {
                    // Failed to load - clear URL and start fresh
                    this.projectManager.clearProjectUrl();
                    this.initDefaultProject();
                }
            } catch (err) {
                console.error('Failed to load shared project:', err);

                // Check if it's a private project error
                const currentUser = this.apiClient.getCurrentUser();
                if (err.message.includes('private') || err.message.includes('not found')) {
                    // Try to extract owner info from error or make a best-effort message
                    const msg = currentUser
                        ? 'This project is private or does not exist.\n\nIf you know the owner, you can ask them to make it public.'
                        : 'This project is private or does not exist.\n\nPlease log in if you own this project, or ask the owner to make it public.';
                    alert(msg);
                } else {
                    alert('Failed to load project: ' + err.message);
                }

                // Clear URL and fall through to normal init
                this.projectManager.clearProjectUrl();
                this.initDefaultProject();
            }
        } else {
            // Normal initialization
            this.initDefaultProject();
        }
    }

    initDefaultProject() {
        // Try to load saved graph
        const editorStates = this.projectManager.loadGraph();

        if (editorStates && editorStates.length >= 0) {
            // Graph was loaded, restore editor states
            this.restoreEditorStates(editorStates);
        } else {
            // Create default nodes - Preview node instead of Output
            this.nodeGraph.addNode('Preview', 600, 200);
            this.nodeGraph.addNode('Vec3', 300, 200);
            this.nodeGraph.addNode('UV', 300, 400);
            this.nodeGraph.render();
        }

        // Initial compilation
        this.compilationManager.scheduleCompile();

        // Update account button state
        UIHelpers.updateAccountButton(this.apiClient);
    }
}

// Start the application
window.toy = new PatchToy();
