import { NodeGraph } from './src/core/NodeGraph.js';
import { ShaderCompiler } from './src/core/ShaderCompiler.js';
import { NodeDefinitions } from './src/core/NodeDefinitions.js';
import { ApiClient } from './src/services/ApiClient.js';
import { ProjectManager } from './src/managers/ProjectManager.js';
import { CompilationManager } from './src/managers/CompilationManager.js';
import { FeedbackRenderer } from './src/rendering/FeedbackRenderer.js';
import { BackgroundRenderer } from './src/rendering/BackgroundRenderer.js';
import { AuthDialogs } from './src/ui/AuthDialogs.js';
import { NodeDialogs } from './src/ui/NodeDialogs.js';
import { ProjectDialogs } from './src/ui/ProjectDialogs.js';
import { UIHelpers } from './src/ui/UIHelpers.js';

class PatchToy {
    constructor() {
        // DOM elements
        this.nodeCanvas = document.getElementById('nodeCanvas');
        this.videoElement = document.getElementById('cameraVideo');
        this.addNodeBtn = document.getElementById('addNodeBtn');

        // Core instances
        this.nodeGraph = new NodeGraph(this.nodeCanvas, this.videoElement);
        this.nodeGraph.addNodeButton = this.addNodeBtn;
        this.shaderCompiler = new ShaderCompiler();
        this.apiClient = new ApiClient();

        // Managers
        this.projectManager = new ProjectManager(this.nodeGraph, this.apiClient);
        this.backgroundRenderer = new BackgroundRenderer(this.nodeCanvas, this.videoElement);
        this.feedbackRenderer = new FeedbackRenderer(this.nodeGraph, this.shaderCompiler, null);
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
                    this.createCustomNode(nodeName, glslCode);
                    this.compilationManager.scheduleCompile();
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
                const success = this.createCustomNode(nodeName, glslCode);
                if (success) {
                    this.nodeGraph.addNode(nodeName, 200, 200);
                }
                return success;
            });
        };

        // Preview node code inspect
        this.nodeGraph.onPreviewCodeInspect = (node) => {
            const shaderSource = node?.renderer?.currentShaderSource?.fragment;
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
            this.cameraEnabled = await this.toggleCamera();
            const btn = document.getElementById('cameraBtn');
            btn.style.background = this.cameraEnabled ? '#007acc' : 'transparent';
            btn.style.borderColor = this.cameraEnabled ? '#007acc' : '#444';
        });

        // Microphone button
        document.getElementById('micBtn').addEventListener('click', async () => {
            await UIHelpers.enableAllMicrophones(this.nodeGraph);
        });

        // Load file input
        document.getElementById('loadFileInput').addEventListener('change', async (e) => {
            const loaded = await this.projectManager.loadProjectFromFile(
                e.target.files[0],
                (name, glsl, skipSave) => this.createCustomNode(name, glsl, skipSave),
                () => this.saveCustomNodes()
            );
            if (loaded) {
                this.compilationManager.scheduleCompile();
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
                onShowCurrentProjectMenu: (anchorBtn) => {
                    ProjectDialogs.showCurrentProjectMenu({
                        anchorBtn,
                        onDownload: () => this.projectManager.saveProjectToFile()
                    });
                },
                onLoadLocalClick: () => document.getElementById('loadFileInput').click(),
                onLoadCloudProject: async (projectId) => {
                    const loaded = await this.projectManager.loadCloudProject(projectId, (name, glsl) => this.createCustomNode(name, glsl));
                    if (loaded) this.compilationManager.scheduleCompile();
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
            // Compile feedback shaders first
            this.feedbackRenderer.compileFeedbackShaders();
            this.feedbackRenderer.renderFeedbackNodes();

            // Then schedule main compilation
            this.compilationManager.scheduleCompile();
            this.projectManager.saveGraph();
        };

        // Uniform value changes (no recompilation needed)
        this.nodeGraph.onUniformValueChanged = (node) => {
            this.compilationManager.updateUniforms();
            this.projectManager.saveGraph();
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

    createCustomNode(nodeName, glslCode, skipSave = false) {
        // Parse the GLSL function to extract signature
        const funcMatch = glslCode.match(/(\w+)\s+(\w+)\s*\((.*?)\)/);

        if (!funcMatch) {
            alert('Could not parse GLSL function. Please ensure it has a valid signature like: vec3 myFunc(vec2 uv)');
            return false;
        }

        const returnType = funcMatch[1];
        const funcName = funcMatch[2];
        const paramsString = funcMatch[3];

        // Parse parameters
        const inputs = [];
        if (paramsString.trim()) {
            const params = paramsString.split(',').map(p => p.trim());
            for (const param of params) {
                const parts = param.split(/\s+/);
                if (parts.length >= 2) {
                    const type = parts[0];
                    const name = parts[1];
                    inputs.push({ name, type });
                }
            }
        }

        // Create the node definition
        NodeDefinitions[nodeName] = {
            category: 'custom',
            inputs: inputs,
            outputs: [{ name: 'out', type: returnType }],
            customGLSL: glslCode,
            isCustomNode: true,
            glsl: (node, inputValues) => {
                // Build the function call with proper default values
                const args = inputs.map((inp) => {
                    if (inputValues[inp.name]) {
                        return inputValues[inp.name];
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
                    code: `${glslCode}\n${returnType} ${node.varName} = ${funcName}(${args});`,
                    output: node.varName
                };
            }
        };

        if (!skipSave) {
            this.saveCustomNodes();
        }

        this.nodeGraph.refreshNodesOfType(nodeName, { preserveData: true });

        console.log(`Created custom node: ${nodeName}`);
        return true;
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
        if (this.createCustomNode(finalName, glslCode)) {
            this.nodeGraph.addNode(finalName, this.nodeGraph.mouseX, this.nodeGraph.mouseY);
            this.nodeGraph.render();
            this.compilationManager.showSuccess(`Created custom node: ${finalName}`);
        }
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;

        // Node canvas
        const nodeRect = this.nodeCanvas.getBoundingClientRect();
        this.nodeCanvas.width = nodeRect.width * dpr;
        this.nodeCanvas.height = nodeRect.height * dpr;

        const ctx = this.nodeCanvas.getContext('2d');
        ctx.scale(dpr, dpr);
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

        // Check if URL contains shared project
        const urlParams = new URLSearchParams(window.location.search);
        const sharedProjectId = urlParams.get('project');

        if (sharedProjectId && this.apiClient.isEnabled()) {
            // Try to load shared project
            try {
                const result = await this.apiClient.getPublicProject(sharedProjectId);
                const projectData = result.data;

                // Mark as viewing someone else's project
                const sharedProjectInfo = {
                    id: sharedProjectId,
                    name: result.name,
                    username: result.username,
                    isOwner: result.isOwner || false
                };
                this.projectManager.viewingSharedProject = sharedProjectInfo;

                // Load custom nodes if present
                if (projectData.customNodes) {
                    for (const [nodeName, nodeData] of Object.entries(projectData.customNodes)) {
                        this.createCustomNode(nodeName, nodeData.customGLSL);
                    }
                }

                // Load the project
                if (projectData.graph) {
                    this.nodeGraph.deserialize(projectData.graph);
                } else {
                    // Old format - direct graph data
                    this.nodeGraph.nodes = projectData.nodes || [];
                    this.nodeGraph.connections = projectData.connections || [];
                }
                this.nodeGraph.render();

                // Update project title to show it's shared
                const projectTitleDisplay = document.getElementById('projectTitleDisplay');
                if (projectTitleDisplay) {
                    projectTitleDisplay.textContent = `${result.name} (by @${result.username})`;
                }

                // Show notification
                if (!result.isOwner) {
                    setTimeout(() => {
                        alert(`Viewing "${result.name}" by @${result.username}\n\nAny changes you save will create your own copy.`);
                    }, 500);
                }

                // Compile the shader
                this.compilationManager.scheduleCompile();

                // Clear URL parameter
                window.history.replaceState({}, document.title, window.location.pathname);
            } catch (err) {
                console.error('Failed to load shared project:', err);
                alert('Failed to load shared project: ' + err.message);
                // Fall through to normal init
                this.initDefaultProject();
            }
        } else {
            // Normal initialization
            this.initDefaultProject();
        }
    }

    initDefaultProject() {
        // Try to load saved graph
        const loaded = this.projectManager.loadGraph();

        if (!loaded) {
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
