import { NodeGraph } from './src/core/NodeGraph.js';
import { ShaderCompiler } from './src/core/ShaderCompiler.js';
import { NodeDefinitions } from './src/core/NodeDefinitions.js';
import { ApiClient } from './src/services/ApiClient.js';
import { ProjectManager, visibilityOf } from './src/managers/ProjectManager.js';
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
import { ShaderPreview } from './src/rendering/ShaderPreview.js';
import { AppShell } from './src/ui/AppShell.js';
import { DemoGallery } from './src/ui/DemoGallery.js';
import { ProjectBrowser } from './src/ui/ProjectBrowser.js';
import { CommunityManager } from './src/managers/CommunityManager.js';
import { clock } from './src/core/Clock.js';
import { audioEngine } from './src/services/AudioEngine.js';
import { tickParams } from './src/nodes/ParamNode.js';
import { jsRuntime } from './src/nodes/jsRuntime.js';
import { controlRuntime } from './src/core/control/ControlRuntime.js';
import { tickScenes } from './src/nodes/SceneSwitcherNode.js';
import { renderLoop } from './src/rendering/RenderLoop.js';
import { loopTrace, loopErrors } from './src/core/loopTrace.js';
import { quality } from './src/rendering/QualityGovernor.js';
import { QualityControl } from './src/ui/QualityControl.js';
import { History } from './src/core/History.js';
import { installRender3D } from './src/render3d/index.js'; // Render 3D: rasterized meshes (src/render3d)
import { customNodeNameError, loadLibrary, saveLibrary } from './src/core/customNodes.js';

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
        // Custom nodes of an opened project are scoped to it (never written to the user's library)
        this.projectManager.registerProjectCustomNode = (name, glsl) => this.createCustomNode(name, glsl, true, { scope: 'project' });
        this.projectManager.releaseCustomNodes = () => this.releaseProjectCustomNodes();
        this.backgroundRenderer = new BackgroundRenderer(this.nodeCanvas, this.videoElement, this.sharedGL, this.uniformRegistry);
        this.backgroundRenderer.graph = this.nodeGraph; // Pass graph reference for video node access
        this.feedbackRenderer = new FeedbackRenderer(this.nodeGraph, this.shaderCompiler, this.sharedGL, this.uniformRegistry);
        this.compilationManager = new CompilationManager(this.nodeGraph, this.shaderCompiler, null, this.backgroundRenderer, this.feedbackRenderer);
        installRender3D(this); // compiles with the previews, renders lazily when its textures are used

        // State
        this.cameraEnabled = false;
        this.isPlaying = true;

        // Create persistent color input for color picker
        this.colorInput = this.createColorInput();

        this.setupEventListeners();

        // Undo / redo (src/core/History.js): wraps onGraphChanged / deserialize set up above
        this.history = new History(this);

        // DOM shell: library sidebar, status bar, compile pill, shortcuts, canvas resize observer
        this.shell = new AppShell(this);
        // Render quality (dynamic resolution of the background / fullscreen / output window):
        // status bar control; window.toy.quality.status() for diagnostics
        this.quality = quality;
        try { this.qualityControl = new QualityControl(this); } catch (e) { console.warn('[quality] control failed', e); }

        // Demo gallery (the browser's Demos tab: top bar "Open", project menu, empty-canvas card, first visit)
        this.demoGallery = new DemoGallery(this);
        // Project browser (demos / community / my projects / user pages) and community features
        // (share links /p/<id>, user pages /u/<name>, forks, thumbnails)
        this.projectBrowser = new ProjectBrowser(this);
        this.community = new CommunityManager(this);

        this.init();
        // Reflect the restored graph right away (otherwise the empty-canvas card flashes on reload)
        this.shell.syncNow();
        this.startAnimationLoop();
    }

    startAnimationLoop() {
        renderLoop.attach(this);
        // Errors of the per-frame work: phase + node (the per-node loops set loopTrace.node),
        // one warning per phase / node / message every 5 s; window.toy.loopErrors.list()
        this.loopErrors = loopErrors;
        const phase = (name, fn) => {
            loopTrace.node = null;
            try { fn(); } catch (e) {
                // One failing phase never stops the loop
                loopErrors.report(name, loopTrace.node, e);
            }
            loopTrace.node = null;
        };
        const animate = (now, manualStep = false) => {
            // Schedule the next frame first: nothing below can stop the loop
            if (!manualStep) requestAnimationFrame(animate);
            // Offline export / output window (src/output) step frames themselves while the clock
            // is in manual mode; this page's previews keep drawing whatever the passes produced
            if (clock.manual && !manualStep) { phase('render', () => renderLoop.frame(now)); return; }
            // Per-frame CPU sources first (the clock already advanced this frame):
            // trigger pulses of Param nodes, then the control-rate graph (LFOs, Lags, math on
            // Params, JS nodes...) in dependency order; outputs become live uniforms
            phase('params', () => tickParams(this.nodeGraph));
            try { controlRuntime.tick(this); } catch (e) { phase('control', () => { throw e; }); phase('js', () => jsRuntime.tick(this)); }
            // Scene switchers: transitions, auto mode, scene uniforms (before the passes that use them)
            phase('scenes', () => tickScenes(this));
            // Render feedback nodes every frame
            phase('feedback', () => this.feedbackRenderer.renderFeedbackNodes());
            // Debug probes: one batched GPU readback (src/rendering/ProbeRenderer.js)
            phase('probes', () => this.compilationManager.renderProbes?.());
            // Previews (node thumbnails, background, fullscreen): src/rendering/RenderLoop.js
            if (!manualStep) phase('render', () => renderLoop.frame(now));
        };
        // One frame of the per-frame work, for drivers outside this loop (src/output:
        // offline export, output window while this page is hidden)
        this.tickFrame = () => animate(performance.now(), true);
        requestAnimationFrame(animate);
    }

    createColorInput() {
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'pt-color-input';
        colorInput.tabIndex = -1;
        colorInput.setAttribute('aria-hidden', 'true');
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
            if (node.isParamNode) {
                // Double-click a Param: show it in the Parameters panel (not when using its control)
                const pos = this.nodeGraph.getMousePos(e);
                const r = node.getControlRect && node.getControlRect();
                const onControl = r && pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h;
                if (!onControl) this.shell?.params.reveal(node, { rename: e.altKey });
                return;
            }
            if (node.isJSNode && node.openEditor) {
                node.openEditor();
                return;
            }
            if (node.isCommentNode && node.beginEdit) {
                node.beginEdit(this.nodeCanvas, () => {
                    if (this.nodeGraph.onGraphChanged) this.nodeGraph.onGraphChanged();
                });
            } else if (definition && definition.isCustomNode) {
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

            // Visual state (icon / colors / tooltip) is synced by AppShell.
            // The transport also freezes the global clock (u_time, beat clock, audio uniforms)
            // and pauses a playing music file.
            if (this.isPlaying) {
                this.compilationManager.setAutoCompile(true);
                this.compilationManager.scheduleCompile();
                clock.resume();
                if (this.resumeMusicOnPlay) audioEngine.play();
                this.resumeMusicOnPlay = false;
                this.shell?.activity('Live — time running, auto-compile on', { local: true });
            } else {
                this.compilationManager.setAutoCompile(false);
                clock.pause();
                this.resumeMusicOnPlay = audioEngine.isPlaying();
                audioEngine.pause();
                this.shell?.activity('Paused — time frozen, graph changes won’t recompile', { local: true });
            }
            this.shell?.syncNow();
        });

        // Camera button
        document.getElementById('cameraBtn').addEventListener('click', async () => {
            await UIHelpers.enableAllCameras(this.nodeGraph);
        });

        // Microphone button
        // The mic drives the global audio / beat uniforms (AudioEngine) and any Microphone nodes
        document.getElementById('micBtn').addEventListener('click', async () => {
            const micNodes = this.nodeGraph.nodes.filter(n => n.isMicrophoneNode);
            if (audioEngine.mic.stream) {
                micNodes.forEach(n => n.disable());
                if (audioEngine.source === 'mic') await audioEngine.setSource('off');
                this.shell?.syncNow();
                return;
            }
            try {
                await audioEngine.setSource('mic');
                for (const n of micNodes) if (!n.isActive) await n.enable();
                this.shell?.activity('Listening to the microphone — beat lock takes a few seconds', { local: true });
            } catch (error) {
                UIHelpers.setDeviceButtonState('micBtn', { state: 'error', tip: 'Microphone error: ' + (audioEngine.error || error.message) });
                UIHelpers.toast(audioEngine.error || error.message, 'error', { title: 'Microphone unavailable' });
            }
            this.shell?.syncNow();
        });

        // MIDI button
        document.getElementById('midiBtn').addEventListener('click', async () => {
            await UIHelpers.enableMIDI();
        });

        // Load file input
        document.getElementById('loadFileInput').addEventListener('change', async (e) => {
            await this.openProjectFile(e.target.files[0]);
            e.target.value = ''; // Reset file input
        });

        // Project menu button: actions on the open project (other projects: the Open panel)
        document.getElementById('projectMenuBtn').addEventListener('click', () => {
            ProjectDialogs.showProjectMenu({
                apiClient: this.apiClient,
                projectTitle: this.projectManager.projectTitle,
                projectState: this.projectManager.projectState,
                onProjectTitleChange: (title) => this.projectManager.setProjectTitle(title),
                onSave: () => this.saveProject(),
                onDuplicate: () => this.duplicateProject(),
                onShare: () => this.community.shareCurrentProject(),
                onPublish: () => this.togglePublishProject(),
                onDownload: () => this.downloadProject()
            });
        });

        // Save to cloud button
        document.getElementById('saveCloudBtn').addEventListener('click', () => this.saveProject());

        // Account button
        document.getElementById('accountBtn').addEventListener('click', () => {
            if (this.apiClient.isLoggedIn()) {
                UIHelpers.showAccountMenu(this.apiClient, () => {
                    this.apiClient.logout();
                    UIHelpers.updateAccountButton(this.apiClient);
                    this.projectManager.clearProject();
                    UIHelpers.toast('Signed out', 'info');
                }, this.community.accountMenuItems());
            } else {
                this.community.signIn();
            }
        });

        // Track mouse position for shader u_mouse uniform
        // Listen on document so it works both on the node canvas and in fullscreen overlays
        document.addEventListener('mousemove', (e) => {
            // If in fullscreen, use the fullscreen element's bounds
            const target = document.fullscreenElement || this.nodeCanvas;
            const rect = target.getBoundingClientRect();
            ShaderPreview.mouseX = (e.clientX - rect.left) / rect.width;
            ShaderPreview.mouseY = 1.0 - (e.clientY - rect.top) / rect.height;
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

            // Feedback shaders compile with the previews in the debounced compile (their links
            // run in the background there, the previous programs keep rendering). With auto-compile
            // off they still follow every change, as they always did.
            // (no extra pass here: the frame loop renders them; an extra pass per edit would
            // advance every feedback simulation one step per graph change)
            if (!this.compilationManager.autoCompile) this.feedbackRenderer.compileFeedbackShaders();

            // Schedule the compilation (reuses the same global ID mapping)
            this.compilationManager.scheduleCompile();
            // Note: markDirty() already calls saveGraph()
        };

        // Uniform value changes (no recompilation needed)
        this.nodeGraph.onUniformValueChanged = () => {
            // Values reach the renderers through the UniformRegistry; only save (debounced, no lag while dragging)
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

    async handleNewProject() {
        // Check if there are nodes in the current graph
        const hasNodes = this.nodeGraph.nodes.length > 0;

        if (hasNodes) {
            // Ask if user wants to save first
            const choice = await UIHelpers.choose({
                title: 'Start a new project?',
                message: `Save “${this.projectManager.projectTitle}” before clearing the canvas? ` +
                    (this.apiClient.isLoggedIn() ? 'It will be saved to the cloud.' : 'It will be downloaded as a .json file.'),
                buttons: [
                    { label: 'Cancel', value: null, variant: 'ghost' },
                    { spacer: true },
                    { label: 'Don’t save', value: 'discard' },
                    { label: 'Save first', value: 'save', variant: 'primary' }
                ]
            });
            if (!choice) return;
            const save = choice === 'save';

            if (save) {
                // If logged in, save to cloud
                if (this.apiClient.isLoggedIn()) {
                    const result = await this.projectManager.saveToCloud();
                    if (result.needsName) {
                        try {
                            await this.projectManager.saveNewProject(this.projectManager.projectTitle, result.projectData, { forkedFrom: result.forkedFrom });
                        } catch (err) {
                            UIHelpers.notify(err.message, 'error', { title: 'Save failed' });
                            return; // keep the current project if saving failed
                        }
                    } else if (!result.success) {
                        return;
                    }
                    UIHelpers.toast(`Saved “${this.projectManager.projectTitle}”`, 'success');
                    // Thumbnail of the patch before the canvas is cleared
                    await this.community.afterCloudSave();
                    this.createNewProject();
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

        // An empty project goes through the same path as every load (NodeGraph.deserialize):
        // the old nodes are disposed (render targets, Feedback buffers, streams, listeners),
        // per-project runtime state is dropped (src/core/simulation.js resetProjectRuntime),
        // and the hooks wrapping deserialize see it too - output calibrations
        // (OutputManager), automation sync (AutomationAPI), undo history (History).
        this.nodeGraph.deserialize({ nodes: [], connections: [], nextNodeId: 0, panX: 0, panY: 0, zoom: 1 });
        // ...and the previous project's custom nodes
        this.releaseProjectCustomNodes();

        // Reset project info. clearProject() also resets projectState (otherwise the next
        // save would overwrite the previous cloud project with the empty graph) and the URL.
        this.projectManager.viewingSharedProject = null;
        this.projectManager.clearProject();

        // Save the empty graph and trigger compilation
        this.projectManager.saveGraph();
        this.compilationManager.compile();
        this.nodeGraph.render();
        this.shell?.activity('New project', { local: true });
    }

    /**
     * Load a project .json (file input, drag-and-drop, demo gallery).
     * Registers its custom nodes, compiles and reopens its code editors.
     * @param {File} file
     * @param {{title?: string}} [options] - title: project name to show (e.g. a demo's name)
     * @returns {Promise<{success: boolean, editorStates: Array}|false|undefined>}
     */
    async openProjectFile(file, { title = null } = {}) {
        if (!file) return false;
        // Close all open editors before loading new project
        FloatingCodeEditor.closeAll();

        const result = await this.projectManager.loadProjectFromFile(
            file,
            (name, glsl) => this.createCustomNode(name, glsl, true, { scope: 'project' }),
            () => this.saveCustomNodes()
        );
        if (result && result.success) {
            this.offerKeepCustomNodes();
            if (title) {
                // A freshly opened project has no unsaved changes, even after renaming it
                this.projectManager.setProjectTitle(title);
                this.projectManager.markClean();
                this.projectManager.saveGraph();
            }
            this.compilationManager.scheduleCompile();
            // Restore editor states from the loaded project
            this.restoreEditorStates(result.editorStates);
        }
        return result;
    }

    /** Download the current project as .json and mark it clean. */
    downloadProject() {
        this.projectManager.saveProjectToFile();
        if (this.projectManager.projectState?.source !== 'cloud') {
            this.projectManager.markClean();
        }
        UIHelpers.toast('Project downloaded as .json', 'success');
    }

    /** Saved cloud project of my own open, saving first when needed (null if the user backed out). */
    async ensureOwnCloudProject(reason) {
        const ps = () => this.projectManager.projectState;
        if (ps()?.source === 'cloud' && ps().isOwner && ps().projectId) return ps();
        if (!this.apiClient.isLoggedIn()) {
            this.community.signIn(); // the user picks the action again once signed in
            return null;
        }
        {
            const ok = await UIHelpers.confirm({
                title: 'Save to the cloud first',
                message: `${reason} Save this patch to your account first.`,
                confirmLabel: 'Save to cloud'
            });
            if (!ok) return null;
        }
        await this.saveProject();
        return ps()?.source === 'cloud' && ps().isOwner && ps().projectId ? ps() : null;
    }

    /** Project menu: a cloud copy of the open patch ("<title> (Copy)"); the original stays open. */
    async duplicateProject() {
        if (!this.apiClient.isLoggedIn()) {
            this.community.signIn(() => this.duplicateProject());
            return;
        }
        const name = `${this.projectManager.projectTitle || 'Untitled Project'} (Copy)`;
        try {
            const result = await this.apiClient.saveProject(name, this.projectManager.currentProjectData());
            UIHelpers.toast(`Saved “${name}” to your projects`, 'success', {
                title: 'Duplicated',
                action: { label: 'Open copy', onClick: () => this.community.openCloudProject(result.id, { via: 'mine' }) }
            });
        } catch (err) {
            UIHelpers.notify(err.message, 'error', { title: 'Duplicate failed' });
        }
    }

    /** Project menu: publish the open project to Community, or take it off (it stays link-only). */
    async togglePublishProject() {
        const ps = await this.ensureOwnCloudProject('Only cloud projects can be published.');
        if (!ps) return;
        await this.apiClient.probeCapabilities?.();
        const project = { id: ps.projectId, name: this.projectManager.projectTitle, isPublic: !!ps.isPublic, visibility: visibilityOf(ps) };
        if (project.visibility === 'public') {
            await this.community.setVisibility(project, 'unlisted');
            return;
        }
        const ok = await UIHelpers.confirm({
            title: `Publish “${project.name}”?`,
            message: 'It will be listed in Community and on your page, and anyone can open it and save a copy.',
            confirmLabel: 'Publish'
        });
        if (ok) await this.community.setVisibility(project, 'public');
    }

    /** Save button / Cmd+S: cloud when signed in, otherwise prompt sign-in (or download if no backend). */
    async saveProject() {
        if (this._saving) return;
        const saveBtn = document.getElementById('saveCloudBtn');

        if (!this.apiClient.isEnabled()) {
            this.downloadProject();
            return;
        }

        if (!this.apiClient.isLoggedIn()) {
            this.community.signIn(() => this.saveProject());
            return;
        }

        this._saving = true;
        saveBtn?.classList.add('is-busy');
        const label = saveBtn?.querySelector('.tb-btn-label');
        if (label) label.textContent = 'Saving…';
        try {
            const result = await this.projectManager.saveToCloud();
            if (result.needsLogin) {
                this.community.signIn();
            } else if (result.needsName) {
                try {
                    await this.projectManager.saveNewProject(this.projectManager.projectTitle, result.projectData, { forkedFrom: result.forkedFrom });
                    UIHelpers.toast(
                        result.isFork
                            ? `It’s in your projects now (forked from @${result.originalOwner}). Saving updates your copy.`
                            : `Saved “${this.projectManager.projectTitle}” to the cloud`,
                        'success',
                        result.isFork ? { title: `Saved your copy of “${result.originalName}”` } : {}
                    );
                    UIHelpers.updateAccountButton(this.apiClient);
                    this.keepProjectCustomNodes({ quiet: true });
                    this.community.afterCloudSave();
                } catch (err) {
                    UIHelpers.notify(err.message, 'error', { title: 'Save failed' });
                }
            } else if (result.success) {
                UIHelpers.toast('Project saved', 'success');
                this.keepProjectCustomNodes({ quiet: true });
                this.community.afterCloudSave();
            }
        } finally {
            this._saving = false;
            saveBtn?.classList.remove('is-busy');
            if (label) label.textContent = 'Save';
            this.community?.updateChrome();
            this.shell?.syncNow();
        }
    }

    /**
     * Register (or update) a custom node type.
     * @param {boolean} [skipSave] - don't write the user's library
     * @param {{scope?: 'library'|'project', silent?: boolean}} [opts] - scope 'project': a node that
     *   came with an opened project (in memory and in that project only, see src/core/customNodes.js).
     *   Default: 'project' with skipSave, else 'library' (the user's own action).
     * @returns {{success: true, finalCode: string}|false}
     */
    createCustomNode(nodeName, glslCode, skipSave = false, opts = {}) {
        let scope = opts.scope || (skipSave ? 'project' : 'library');
        // Names are identifiers; built-in nodes and Object.prototype keys can't be redefined
        const nameError = customNodeNameError(nodeName);
        if (nameError) {
            console.warn(`[custom nodes] rejected ${JSON.stringify(String(nodeName).slice(0, 60))}: ${nameError}`);
            if (!opts.silent) UIHelpers.notify(nameError, 'error', { title: 'Custom node not created' });
            return false;
        }
        if (typeof glslCode !== 'string' || !glslCode.trim()) return false;
        const library = this._customLibrary();
        // A project node identical to the library's is simply the library node
        if (scope === 'project' && library.get(nodeName) === glslCode) scope = 'library';

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
            UIHelpers.notify(validation.errors.join('\n'), 'error', { title: 'Magic comment validation failed' });
            return false;
        }

        // Extract all functions from code
        const functions = GLSLCommentParser.extractFunctions(code);
        if (functions.length === 0) {
            UIHelpers.notify('Use a valid signature like: vec3 myFunc(vec2 uv)', 'error', { title: 'Could not parse GLSL function' });
            return false;
        }

        // Determine main function
        let mainFunction;
        if (metadata.node) {
            mainFunction = functions.find(f => f.name === metadata.node);
        } else if (functions.length === 1) {
            mainFunction = functions[0];
        } else {
            UIHelpers.notify('Add an @node directive naming the entry function.', 'error', { title: 'Multiple functions found' });
            return false;
        }

        if (!mainFunction) {
            UIHelpers.notify('Check that @node names an existing function.', 'error', { title: 'Could not determine main function' });
            return false;
        }

        // Parse function parameters
        const funcMatch = code.match(
            new RegExp(`${mainFunction.returnType}\\s+${mainFunction.name}\\s*\\(([^)]*)\\)`)
        );

        if (!funcMatch) {
            UIHelpers.notify('Could not parse function parameters.', 'error');
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
            customScope: scope,
            displayTitle: displayTitle,
            description: metadata.description,
            // Declare built-in uniforms the GLSL uses (otherwise u_time etc. are only declared if e.g. a Time node is present)
            uniforms: ['u_time', 'u_resolution', 'u_mouse'].filter(u => new RegExp(`\\b${u}\\b`).test(code)),
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
                    if (type === 'sampler2D') return 'u_camera'; // declared automatically when used

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

        if (scope === 'library' && !skipSave) {
            library.set(nodeName, finalCode);
            this.saveCustomNodes();
        }

        this.nodeGraph.refreshNodesOfType(nodeName, { preserveData: true });
        this.shell?.library.refresh();

        return { success: true, finalCode };
    }

    deleteCustomNode(nodeName) {
        // Remove from NodeDefinitions and the user's library
        delete NodeDefinitions[nodeName];
        this._customLibrary().delete(nodeName);

        // Remove all instances of this node from the graph
        const nodesToRemove = this.nodeGraph.nodes.filter(n => n.type === nodeName);
        if (nodesToRemove.length > 0) {
            this.nodeGraph.selectionManager.selectedNodes = new Set(nodesToRemove);
            this.nodeGraph.deleteSelectedNodes();
        }

        // Save updated custom nodes list
        this.saveCustomNodes();

        // Refresh UI
        this.nodeGraph.render();
        this.compilationManager.scheduleCompile();
        this.shell?.library.refresh();
    }

    /** The user's custom node library (name -> GLSL), persisted in localStorage. */
    _customLibrary() {
        if (!this.customLibrary) this.customLibrary = new Map();
        return this.customLibrary;
    }

    /** Persist the user's library only (project-scoped nodes are never written here). */
    saveCustomNodes() {
        try {
            saveLibrary(this._customLibrary());
        } catch (e) {
            console.error('Failed to save custom nodes:', e);
        }
    }

    loadCustomNodes() {
        try {
            // Sanitises libraries stored before 2.0 (built-in name clashes renamed, invalid names dropped)
            const { library, changed, notes } = loadLibrary();
            this.customLibrary = library;
            for (const note of notes) console.info(`[custom nodes] library migration: ${note}`);
            for (const [name, glsl] of library) {
                const ok = this.createCustomNode(name, glsl, true, { scope: 'library', silent: true });
                if (!ok) console.warn(`[custom nodes] library node ${name} could not be registered`);
            }
            if (changed) this.saveCustomNodes();
            return library.size > 0;
        } catch (e) {
            console.error('Failed to load custom nodes:', e);
        }
        return false;
    }

    /** Custom node definitions that came with the open project and aren't in the library. */
    projectCustomNodes() {
        return Object.entries(NodeDefinitions)
            .filter(([, def]) => def && def.isCustomNode && def.customScope === 'project')
            .map(([name]) => name);
    }

    /**
     * Forget the previous project's custom nodes before another project loads: library
     * versions come back, project-only ones are unregistered.
     */
    releaseProjectCustomNodes() {
        const library = this._customLibrary();
        let changed = false;
        for (const name of this.projectCustomNodes()) {
            changed = true;
            if (library.has(name)) this.createCustomNode(name, library.get(name), true, { scope: 'library', silent: true });
            else delete NodeDefinitions[name];
        }
        if (changed) this.shell?.library.refresh();
    }

    /** Copy the open project's custom nodes into the user's library (explicit save / "Keep"). */
    keepProjectCustomNodes({ names = null, quiet = false } = {}) {
        const library = this._customLibrary();
        const kept = [];
        for (const name of names || this.projectCustomNodes()) {
            const def = NodeDefinitions[name];
            if (!def || !def.isCustomNode) continue;
            def.customScope = 'library';
            library.set(name, def.customGLSL);
            kept.push(name);
        }
        if (!kept.length) return kept;
        this.saveCustomNodes();
        this.shell?.library.refresh();
        if (!quiet) UIHelpers.toast(kept.join(', '), 'success', { title: `Added ${kept.length} custom node${kept.length > 1 ? 's' : ''} to your library` });
        return kept;
    }

    /** After opening someone else's project or a file: offer to keep its custom nodes. */
    offerKeepCustomNodes() {
        const names = this.projectCustomNodes();
        if (!names.length) return;
        const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
        UIHelpers.toast(`${shown} ${names.length > 1 ? 'are' : 'is'} available while this project is open.`, 'info', {
            title: `This project brings ${names.length} custom node${names.length > 1 ? 's' : ''}`,
            duration: 7000,
            action: { label: 'Keep in my library', onClick: () => this.keepProjectCustomNodes({ names }) }
        });
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
        // Scratch layers of the graph canvas (faded cables, group transitions) follow now
        if (this.nodeGraph.graphRenderer) this.nodeGraph.graphRenderer.resizeLayers();

        this.nodeGraph.render();
    }

    async init() {
        this.resize();

        // Load custom nodes first
        this.loadCustomNodes();

        // Password reset link: https://<site>/#reset=<token> (older mails: ?reset=<token>).
        // Strip the token from the URL first (before anything else loads), keep the rest of
        // the URL, and restore the patch normally: resetting a password never touches it.
        const resetToken = this.takeResetToken();
        if (resetToken && this.apiClient.isEnabled()) {
            this.initDefaultProject();
            this.community.syncEditorUrl();
            AuthDialogs.showResetPassword(this.apiClient, resetToken);
            return;
        }

        // Share links (/p/<id>, legacy ?project=<id>), user pages (/u/<name>), /explore
        if (await this.community.handleInitialRoute()) return;

        // Normal initialization (check for a first visit before the first autosave)
        const welcome = DemoGallery.shouldWelcome();
        this.initDefaultProject();
        this.community.syncEditorUrl();
        if (welcome) this.demoGallery.open({ welcome: true });
    }

    /** Read and remove the reset token from the URL (fragment or query). */
    takeResetToken() {
        const url = new URL(window.location.href);
        const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
        const token = hash.get('reset') || url.searchParams.get('reset');
        if (!token) return null;
        hash.delete('reset');
        url.searchParams.delete('reset');
        const rest = hash.toString();
        url.hash = rest ? `#${rest}` : '';
        window.history.replaceState(window.history.state, document.title, url.pathname + url.search + url.hash);
        return token;
    }

    initDefaultProject() {
        // Try to load saved graph
        // (loadGraph always returns the editor states, [] for a first visit: an empty
        // canvas with the empty-canvas card, no default nodes)
        const editorStates = this.projectManager.loadGraph();
        this.restoreEditorStates(editorStates || []);

        // Initial compilation
        this.compilationManager.scheduleCompile();

        // Update account button state
        UIHelpers.updateAccountButton(this.apiClient);
    }
}

// Start the application
window.toy = new PatchToy();

// AI automation bridge for the MCP server (mcp/server.mjs): dev server only, or a production
// build after the explicit opt-in localStorage.patchtoyBridge = 'on' (a link alone can't enable
// it; the page also needs the pairing token). Loaded lazily so production builds don't pay for it.
if (import.meta.env?.DEV || (() => { try { return localStorage.getItem('patchtoyBridge') === 'on'; } catch (e) { return false; } })()) {
    import('./src/automation/BridgeClient.js')
        .then(m => m.initAutomationBridge(window.toy))
        .catch(err => console.warn('[bridge] failed to initialise:', err));
}
