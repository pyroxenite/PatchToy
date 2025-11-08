export class UIHelpers {
    static showAccountMenu(apiClient, onLogout) {
        const user = apiClient.getCurrentUser();

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: transparent; z-index: 10001;';

        const menu = document.createElement('div');
        menu.style.cssText = `
            position: absolute;
            top: 80px;
            right: 20px;
            background: rgba(45, 45, 45, 0.98);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(68, 68, 68, 0.5);
            border-radius: 8px;
            padding: 8px;
            min-width: 200px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        `;

        const createMenuItem = (icon, text, onClick, disabled = false) => {
            const item = document.createElement('button');
            item.textContent = `${icon} ${text}`;
            item.disabled = disabled;
            item.style.cssText = `
                width: 100%;
                padding: 10px 12px;
                background: transparent;
                border: none;
                color: ${disabled ? '#666' : '#fff'};
                text-align: left;
                cursor: ${disabled ? 'not-allowed' : 'pointer'};
                border-radius: 4px;
                font-size: 14px;
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 2px;
            `;
            if (!disabled) {
                item.addEventListener('mouseover', () => {
                    item.style.background = 'rgba(0, 122, 204, 0.2)';
                });
                item.addEventListener('mouseout', () => {
                    item.style.background = 'transparent';
                });
                item.addEventListener('click', () => {
                    overlay.remove();
                    onClick();
                });
            }
            return item;
        };

        // Username header
        const header = document.createElement('div');
        header.textContent = `@${user?.username || 'user'}`;
        header.style.cssText = 'padding: 10px 12px; color: #fff; font-weight: 600; border-bottom: 1px solid rgba(68, 68, 68, 0.5); margin-bottom: 4px;';
        menu.appendChild(header);

        // Menu items
        menu.appendChild(createMenuItem('👤', 'Profile', () => {
            alert('Profile feature coming soon!');
        }, true));

        menu.appendChild(createMenuItem('⚙️', 'Settings', () => {
            alert('Settings feature coming soon!');
        }, true));

        // Separator
        const separator = document.createElement('div');
        separator.style.cssText = 'height: 1px; background: rgba(68, 68, 68, 0.5); margin: 4px 0;';
        menu.appendChild(separator);

        menu.appendChild(createMenuItem('🚪', 'Logout', onLogout));

        overlay.appendChild(menu);
        document.body.appendChild(overlay);

        // Close on click outside
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });
    }

    static updateAccountButton(apiClient) {
        const btn = document.getElementById('accountBtn');
        const saveBtn = document.getElementById('saveCloudBtn');

        // Add null checks for buttons
        if (!btn) {
            console.warn('Account button not found');
            return;
        }

        if (!saveBtn) {
            console.warn('Save button not found in DOM');
            return;
        }

        if (!apiClient.isEnabled()) {
            btn.disabled = true;
            btn.title = 'Backend not configured';
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
            saveBtn.style.display = 'none';
            return;
        }

        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';

        if (apiClient.isLoggedIn()) {
            saveBtn.style.display = 'flex'; // Show save button when logged in
            const user = apiClient.getCurrentUser();
            btn.title = `Logged in as @${user?.username || 'user'}`;
        } else {
            saveBtn.style.display = 'none'; // Hide save button when not logged in
            btn.title = 'Login / Register';
        }
    }

    static async enableAllMicrophones(nodeGraph) {
        // Find all microphone nodes in the graph
        const micNodes = nodeGraph.nodes.filter(n => n.isMicrophoneNode);

        if (micNodes.length === 0) {
            console.log('No microphone nodes found in graph');
            return;
        }

        const btn = document.getElementById('micBtn');

        try {
            // Enable all microphone nodes
            for (const micNode of micNodes) {
                if (!micNode.isActive) {
                    await micNode.enable();
                }
            }

            // Update button state
            btn.style.background = '#007acc';
            btn.style.borderColor = '#007acc';
            btn.title = 'Microphone Active';

            console.log(`Enabled ${micNodes.length} microphone node(s)`);
        } catch (error) {
            console.error('Failed to enable microphones:', error);
            btn.style.background = '#f44336';
            btn.style.borderColor = '#f44336';
            btn.title = 'Microphone Error: ' + error.message;
        }
    }

    static async enableMIDI() {
        // Import and enable MIDI service
        const { midiService } = await import('../services/MIDIService.js');

        const btn = document.getElementById('midiBtn');

        try {
            const success = await midiService.enable();

            if (success) {
                // Update button state
                btn.style.background = '#007acc';
                btn.style.borderColor = '#007acc';
                btn.title = 'MIDI Active';

                const devices = midiService.getDevices();
                console.log(`[MIDI] Enabled successfully. Found ${devices.length} device(s):`, devices);
            } else {
                throw new Error('Failed to enable MIDI');
            }
        } catch (error) {
            console.error('[MIDI] Failed to enable:', error);
            btn.style.background = '#f44336';
            btn.style.borderColor = '#f44336';
            btn.title = 'MIDI Error: ' + error.message;
        }
    }

    static async enableAllCameras(nodeGraph) {
        // Find all camera nodes in the graph
        const cameraNodes = nodeGraph.nodes.filter(n => n.isCameraNode);

        if (cameraNodes.length === 0) {
            console.log('No camera nodes found in graph');
            return;
        }

        const btn = document.getElementById('cameraBtn');

        try {
            // Enable all camera nodes
            for (const cameraNode of cameraNodes) {
                if (!cameraNode.isActive) {
                    await cameraNode.enable();
                }
            }

            // Update button state
            btn.style.background = '#007acc';
            btn.style.borderColor = '#007acc';
            btn.title = 'Camera Active';

            console.log(`Enabled ${cameraNodes.length} camera node(s)`);
        } catch (error) {
            console.error('Failed to enable cameras:', error);
            btn.style.background = '#f44336';
            btn.style.borderColor = '#f44336';
            btn.title = 'Camera Error: ' + error.message;
        }
    }

    static togglePreviewFullscreen(previewPanel, resizeCallback) {
        previewPanel.classList.toggle('fullscreen-preview');

        // Resize after toggle
        setTimeout(() => {
            resizeCallback();
        }, 0);

        // Add escape key handler when in fullscreen
        if (previewPanel.classList.contains('fullscreen-preview')) {
            const escapeHandler = (e) => {
                if (e.key === 'Escape') {
                    previewPanel.classList.remove('fullscreen-preview');
                    resizeCallback();
                    document.removeEventListener('keydown', escapeHandler);
                }
            };
            document.addEventListener('keydown', escapeHandler);
        }
    }

    static showPreviewNodeFullscreen(node, onClose) {
        if (!node.previewInstance) return;

        const previewInstance = node.previewInstance;

        // Get the display canvas (handles both legacy and shared context modes)
        const srcCanvas = node.getDisplayCanvas ? node.getDisplayCanvas() : previewInstance.canvas;
        if (!srcCanvas) return;

        // Store original size for restoration
        const originalWidth = previewInstance.width || srcCanvas.width;
        const originalHeight = previewInstance.height || srcCanvas.height;

        // Pause all other preview nodes to maximize performance
        const nodeGraph = node.graph;
        const otherPreviewNodes = nodeGraph ? nodeGraph.nodes.filter(n => n.isPreviewNode && n !== node) : [];
        const pausedAnimations = [];

        // Stop rendering other preview nodes
        for (const otherNode of otherPreviewNodes) {
            if (otherNode.previewInstance && otherNode.previewInstance.animationId) {
                pausedAnimations.push({
                    node: otherNode,
                    animationId: otherNode.previewInstance.animationId
                });
                otherNode.previewInstance.stopRendering();
            }
        }

        // Pause background renderer if active
        let backgroundWasPaused = false;
        if (nodeGraph && nodeGraph.backgroundRenderer && nodeGraph.backgroundRenderer.shaderPreview) {
            const bgShaderPreview = nodeGraph.backgroundRenderer.shaderPreview;
            if (bgShaderPreview.animationId) {
                backgroundWasPaused = true;
                bgShaderPreview.stopRendering();
            }
        }

        // IMPORTANT: Pause the NodeGraph rendering itself!
        let nodeGraphWasPaused = false;
        if (nodeGraph) {
            nodeGraphWasPaused = true;
            // Store the original render function
            nodeGraph._originalRender = nodeGraph.render;
            // Replace with a no-op during fullscreen
            nodeGraph.render = () => {};
        }

        // Create fullscreen overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #000; z-index: 10000; display: flex; align-items: center; justify-content: center;';

        // Create a dedicated ShaderPreview for fullscreen rendering (avoids framebuffer copy overhead)
        const displayCanvas = document.createElement('canvas');
        displayCanvas.style.maxWidth = '100%';
        displayCanvas.style.maxHeight = '100%';
        displayCanvas.style.objectFit = 'contain';
        overlay.appendChild(displayCanvas);

        document.body.appendChild(overlay);

        // Create a new ShaderPreview instance that renders directly to the display canvas
        // This avoids the expensive gl.readPixels() call in getDisplayCanvas()
        const dpr = window.devicePixelRatio || 1;
        const fullscreenWidth = Math.floor(window.innerWidth * dpr);
        const fullscreenHeight = Math.floor(window.innerHeight * dpr);

        displayCanvas.width = fullscreenWidth;
        displayCanvas.height = fullscreenHeight;
        displayCanvas.style.width = window.innerWidth + 'px';
        displayCanvas.style.height = window.innerHeight + 'px';

        // Import ShaderPreview - already imported in main.js, so use direct import
        import('../rendering/ShaderPreview.js').then(module => {
            const ShaderPreview = module.ShaderPreview;
            const fullscreenPreview = new ShaderPreview(
                displayCanvas,
                previewInstance.videoElement,
                { offscreen: false }
            );

            // Pass graph reference so it can find video nodes
            if (nodeGraph) {
                fullscreenPreview.graph = nodeGraph;
            }

            // Load the current shader
            if (previewInstance.currentShaderSource) {
                fullscreenPreview.loadShader(previewInstance.currentShaderSource);
            }

            // Copy custom uniform values
            if (previewInstance.customUniformValues) {
                fullscreenPreview.customUniformValues = previewInstance.customUniformValues;
            }

            // Store reference for cleanup
            overlay._fullscreenPreview = fullscreenPreview;

            // Request fullscreen
            overlay.requestFullscreen().catch(err => {
                console.warn('Fullscreen request failed:', err);
            });
        });

        // Track if fullscreen exit is in progress
        let isExiting = false;

        // Close handlers
        const closeFullscreen = () => {
            if (isExiting) return;
            isExiting = true;

            // Destroy the fullscreen ShaderPreview instance
            if (overlay._fullscreenPreview) {
                overlay._fullscreenPreview.destroy();
            }

            // Exit fullscreen if active (with error handling)
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(err => {
                    // Ignore "operation cancelled" errors
                    if (!err.message.includes('cancelled')) {
                        console.warn('Error exiting fullscreen:', err);
                    }
                });
            }

            // Resume other preview nodes
            for (const paused of pausedAnimations) {
                if (paused.node.previewInstance) {
                    paused.node.previewInstance.animate();
                }
            }

            // Resume background renderer if it was paused
            if (backgroundWasPaused && nodeGraph && nodeGraph.backgroundRenderer && nodeGraph.backgroundRenderer.shaderPreview) {
                nodeGraph.backgroundRenderer.shaderPreview.animate();
            }

            // Resume NodeGraph rendering
            if (nodeGraphWasPaused && nodeGraph && nodeGraph._originalRender) {
                nodeGraph.render = nodeGraph._originalRender;
                delete nodeGraph._originalRender;
                // Trigger a render to refresh the display
                nodeGraph.render();
            }

            // Remove overlay
            overlay.remove();

            // Call onClose callback
            if (onClose) onClose();

            // Clean up event listeners
            document.removeEventListener('fullscreenchange', fullscreenChangeHandler);
            document.removeEventListener('keydown', escapeHandler);
        };

        // Handle fullscreen changes (including user pressing ESC)
        const fullscreenChangeHandler = () => {
            if (!document.fullscreenElement && !isExiting) {
                closeFullscreen();
            }
        };
        document.addEventListener('fullscreenchange', fullscreenChangeHandler);

        // Close on escape key (backup for non-fullscreen mode)
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (!document.fullscreenElement) {
                    closeFullscreen();
                }
            }
        };
        document.addEventListener('keydown', escapeHandler);

        // Close on click
        overlay.addEventListener('click', () => {
            closeFullscreen();
        });
    }

    static updatePreviewNodesCameraState(nodeGraph, cameraEnabled) {
        // Update all preview nodes to know about camera state
        for (const [nodeId, previewInstance] of nodeGraph.previewNodes) {
            previewInstance.cameraEnabled = cameraEnabled;
        }
    }
}
