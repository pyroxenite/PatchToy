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
        if (!node.previewInstance || !node.previewInstance.canvas) return;

        const previewInstance = node.previewInstance;
        const srcCanvas = previewInstance.canvas;

        // Store original size
        const originalWidth = srcCanvas.width;
        const originalHeight = srcCanvas.height;

        // Create fullscreen overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #000; z-index: 10000; display: flex; align-items: center; justify-content: center;';

        // Add the actual preview canvas to the overlay
        overlay.appendChild(srcCanvas);
        srcCanvas.style.maxWidth = '100%';
        srcCanvas.style.maxHeight = '100%';
        srcCanvas.style.objectFit = 'contain';

        document.body.appendChild(overlay);

        // Close handlers
        const closeFullscreen = () => {
            // Exit fullscreen if active
            if (document.fullscreenElement) {
                document.exitFullscreen();
            }

            // Restore original size
            srcCanvas.width = originalWidth;
            srcCanvas.height = originalHeight;

            // Remove from overlay and put back in the node
            overlay.remove();
            srcCanvas.style.maxWidth = '';
            srcCanvas.style.maxHeight = '';
            srcCanvas.style.objectFit = '';

            // Call onClose callback
            if (onClose) onClose();

            // Clean up event listeners
            document.removeEventListener('fullscreenchange', fullscreenChangeHandler);
            document.removeEventListener('keydown', escapeHandler);
        };

        // Handle fullscreen changes (including user pressing ESC)
        const fullscreenChangeHandler = () => {
            if (!document.fullscreenElement) {
                closeFullscreen();
            }
        };
        document.addEventListener('fullscreenchange', fullscreenChangeHandler);

        // Close on escape key (backup for non-fullscreen mode)
        const escapeHandler = (e) => {
            if (e.key === 'Escape' && !document.fullscreenElement) {
                closeFullscreen();
            }
        };
        document.addEventListener('keydown', escapeHandler);

        // Close on click
        overlay.addEventListener('click', () => {
            closeFullscreen();
        });

        // Request fullscreen and resize canvas
        overlay.requestFullscreen().then(() => {
            // Wait a frame for fullscreen to complete, then get actual overlay dimensions
            requestAnimationFrame(() => {
                const dpr = window.devicePixelRatio || 1;
                const newWidth = overlay.clientWidth * dpr;
                const newHeight = overlay.clientHeight * dpr;
                srcCanvas.width = newWidth;
                srcCanvas.height = newHeight;
            });
        }).catch(err => {
            console.warn('Fullscreen request failed, using fullwindow mode:', err);
            // Fallback to window dimensions if fullscreen is denied
            const dpr = window.devicePixelRatio || 1;
            const newWidth = window.innerWidth * dpr;
            const newHeight = window.innerHeight * dpr;
            srcCanvas.width = newWidth;
            srcCanvas.height = newHeight;
        });
    }

    static updatePreviewNodesCameraState(nodeGraph, cameraEnabled) {
        // Update all preview nodes to know about camera state
        for (const [nodeId, previewInstance] of nodeGraph.previewNodes) {
            previewInstance.cameraEnabled = cameraEnabled;
        }
    }
}
