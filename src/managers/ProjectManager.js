import { NodeDefinitions } from '../core/NodeDefinitions.js';
import { FloatingCodeEditor } from '../ui/FloatingCodeEditor.js';

export class ProjectManager {
    constructor(nodeGraph, apiClient) {
        this.nodeGraph = nodeGraph;
        this.apiClient = apiClient;
        this.projectTitle = 'Untitled Project';
        this.currentProjectId = null;
        this.viewingSharedProject = null; // { id, name, username, isOwner }

        // Enhanced project state
        this.projectState = {
            projectId: null,      // Cloud project ID (if exists)
            ownerId: null,        // Owner's user ID
            ownerUsername: null,  // Owner's username (for display)
            isOwner: false,       // Whether current user owns it
            isDirty: false,       // Has unsaved changes
            source: 'new',        // 'new', 'file', 'cloud'
            lastModified: null,   // Timestamp of last modification
            title: 'Untitled Project'
        };
    }

    saveGraph() {
        try {
            const data = {
                graph: this.nodeGraph.serialize(),
                projectTitle: this.projectTitle,
                currentProjectId: this.currentProjectId,
                editorStates: FloatingCodeEditor.getAllStates(),
                projectState: this.projectState
            };
            localStorage.setItem('patchtoy_graph', JSON.stringify(data));
        } catch (e) {
            console.error('Failed to save graph:', e);
        }
    }

    loadGraph() {
        try {
            const saved = localStorage.getItem('patchtoy_graph');
            if (saved) {
                const data = JSON.parse(saved);

                // Handle old format (just graph) and new format (with metadata)
                if (data.graph) {
                    this.nodeGraph.deserialize(data.graph);
                    this.projectTitle = data.projectTitle || 'Untitled Project';
                    this.currentProjectId = data.currentProjectId || null;
                    document.getElementById('projectTitleDisplay').textContent = this.projectTitle;

                    // Restore project state if present
                    if (data.projectState) {
                        this.projectState = { ...data.projectState };
                        this.updateOwnershipDisplay();
                    } else {
                        // Migrate old data to new format
                        this.projectState.title = this.projectTitle;
                        this.projectState.projectId = this.currentProjectId;
                        if (this.currentProjectId) {
                            this.projectState.source = 'cloud';
                            this.projectState.isOwner = true; // Assume ownership for old data
                        }
                    }

                    // Return editor states if present (caller will restore them)
                    return data.editorStates || [];
                } else {
                    // Old format - just the graph data
                    this.nodeGraph.deserialize(data);
                    return [];
                }
            } else {
                // No saved data - initialize with bare minimum
                console.log('No saved graph found, initializing empty project');
                this.initializeEmptyProject();
            }
        } catch (e) {
            console.error('Failed to load graph:', e);
            // On error, initialize with bare minimum
            this.initializeEmptyProject();
        }
        return [];
    }

    /**
     * Initialize an empty project with bare minimum data
     */
    initializeEmptyProject() {
        this.projectTitle = 'Untitled Project';
        this.currentProjectId = null;
        this.viewingSharedProject = null;

        this.projectState = {
            projectId: null,
            ownerId: null,
            ownerUsername: null,
            isOwner: false,
            isDirty: false,
            source: 'new',
            lastModified: null,
            title: 'Untitled Project'
        };

        const titleElement = document.getElementById('projectTitleDisplay');
        if (titleElement) {
            titleElement.textContent = this.projectTitle;
        }

        this.updateOwnershipDisplay();

        // Save initial empty state
        this.saveGraph();
    }

    saveProjectToFile() {
        try {
            // Collect all custom nodes
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

            // Create project data
            const projectData = {
                version: '1.0',
                graph: this.nodeGraph.serialize(),
                customNodes: customNodes,
                editorStates: FloatingCodeEditor.getAllStates(),
                timestamp: new Date().toISOString()
            };

            // Convert to JSON and download
            const json = JSON.stringify(projectData, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `patchtoy-project-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log('Project saved to file');
        } catch (e) {
            console.error('Failed to save project to file:', e);
            alert('Failed to save project: ' + e.message);
        }
    }

    async loadProjectFromFile(file, onCreateCustomNode, onSaveCustomNodes) {
        if (!file) return;

        try {
            const text = await file.text();
            const projectData = JSON.parse(text);

            // Validate project data
            if (!projectData.graph) {
                throw new Error('Invalid project file: missing graph data');
            }

            // Handle custom nodes
            const customNodesToLoad = projectData.customNodes || {};
            const conflictingNodes = [];

            // Check for conflicts with existing custom nodes
            for (const [name, nodeData] of Object.entries(customNodesToLoad)) {
                const existing = NodeDefinitions[name];
                if (existing && existing.isCustomNode) {
                    // Check if GLSL is different
                    if (existing.customGLSL !== nodeData.customGLSL) {
                        conflictingNodes.push({ name, existing, incoming: nodeData });
                    }
                } else if (!existing) {
                    // New custom node - load it
                    onCreateCustomNode(name, nodeData.customGLSL, true);
                }
            }

            // Handle conflicts
            if (conflictingNodes.length > 0) {
                const resolved = await this.resolveCustomNodeConflicts(conflictingNodes, onCreateCustomNode);
                if (!resolved) {
                    console.log('Load cancelled by user');
                    return;
                }
            }

            // Load the graph
            this.nodeGraph.deserialize(projectData.graph);

            // Update project state - loaded from file has no cloud ID
            this.projectState = {
                projectId: null,
                ownerId: null,
                ownerUsername: null,
                isOwner: false,
                isDirty: false,
                source: 'file',
                lastModified: new Date().toISOString(),
                title: this.projectTitle
            };

            // Clear URL since this is a local file
            this.clearProjectUrl();
            this.updateOwnershipDisplay();

            // Save to localStorage (skip project copy since loaded from file)
            this.saveGraph();
            onSaveCustomNodes();

            console.log('Project loaded from file');

            // Return editor states for restoration
            return {
                success: true,
                editorStates: projectData.editorStates || []
            };
        } catch (e) {
            console.error('Failed to load project from file:', e);
            alert('Failed to load project: ' + e.message);
            return false;
        }
    }

    async resolveCustomNodeConflicts(conflicts, onCreateCustomNode) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;';

            const dialog = document.createElement('div');
            dialog.style.cssText = 'background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 20px; width: 600px; max-width: 90vw; max-height: 80vh; overflow-y: auto;';

            const title = document.createElement('h2');
            title.textContent = 'Custom Node Conflicts';
            title.style.cssText = 'margin: 0 0 15px 0; color: #fff; font-size: 18px;';
            dialog.appendChild(title);

            const description = document.createElement('p');
            description.textContent = 'The following custom nodes already exist with different code. Choose which version to keep:';
            description.style.cssText = 'color: #ccc; margin-bottom: 20px;';
            dialog.appendChild(description);

            const choices = {};

            for (const conflict of conflicts) {
                const conflictDiv = document.createElement('div');
                conflictDiv.style.cssText = 'margin-bottom: 20px; padding: 15px; background: #1e1e1e; border-radius: 4px;';

                const nodeName = document.createElement('div');
                nodeName.textContent = `Node: ${conflict.name}`;
                nodeName.style.cssText = 'color: #4ec9b0; font-weight: bold; margin-bottom: 10px;';
                conflictDiv.appendChild(nodeName);

                const optionLocal = document.createElement('label');
                optionLocal.style.cssText = 'display: block; color: #ccc; margin: 5px 0; cursor: pointer;';
                const radioLocal = document.createElement('input');
                radioLocal.type = 'radio';
                radioLocal.name = `conflict_${conflict.name}`;
                radioLocal.value = 'local';
                radioLocal.checked = true;
                radioLocal.style.marginRight = '8px';
                optionLocal.appendChild(radioLocal);
                optionLocal.appendChild(document.createTextNode('Keep local version (currently in editor)'));
                conflictDiv.appendChild(optionLocal);

                const optionIncoming = document.createElement('label');
                optionIncoming.style.cssText = 'display: block; color: #ccc; margin: 5px 0; cursor: pointer;';
                const radioIncoming = document.createElement('input');
                radioIncoming.type = 'radio';
                radioIncoming.name = `conflict_${conflict.name}`;
                radioIncoming.value = 'incoming';
                radioIncoming.style.marginRight = '8px';
                optionIncoming.appendChild(radioIncoming);
                optionIncoming.appendChild(document.createTextNode('Use version from file'));
                conflictDiv.appendChild(optionIncoming);

                dialog.appendChild(conflictDiv);

                choices[conflict.name] = { radioLocal, radioIncoming, conflict };
            }

            const buttonContainer = document.createElement('div');
            buttonContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'padding: 8px 16px; background: #444; border: 1px solid #666; border-radius: 4px; color: #fff; cursor: pointer;';
            cancelBtn.addEventListener('click', () => {
                overlay.remove();
                resolve(false);
            });

            const continueBtn = document.createElement('button');
            continueBtn.textContent = 'Continue';
            continueBtn.style.cssText = 'padding: 8px 16px; background: #007acc; border: 1px solid #007acc; border-radius: 4px; color: #fff; cursor: pointer;';
            continueBtn.addEventListener('click', () => {
                // Apply choices
                for (const [name, choice] of Object.entries(choices)) {
                    if (choice.radioIncoming.checked) {
                        // Use incoming version - recreate the node
                        onCreateCustomNode(name, choice.conflict.incoming.customGLSL, true);
                    }
                    // If radioLocal is checked, do nothing (keep existing)
                }
                overlay.remove();
                resolve(true);
            });

            buttonContainer.appendChild(cancelBtn);
            buttonContainer.appendChild(continueBtn);
            dialog.appendChild(buttonContainer);

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
        });
    }

    async saveToCloud() {
        if (!this.apiClient.isLoggedIn()) {
            alert('Please login first');
            return { needsLogin: true };
        }

        try {
            // Collect all custom nodes
            const customNodes = {};
            for (const [nodeName, def] of Object.entries(NodeDefinitions)) {
                if (def.isCustomNode) {
                    customNodes[nodeName] = {
                        category: def.category,
                        inputs: def.inputs,
                        outputs: def.outputs,
                        customGLSL: def.customGLSL
                    };
                }
            }

            // Create project data with custom nodes
            const projectData = {
                version: '1.0',
                graph: this.nodeGraph.serialize(),
                customNodes: customNodes,
                editorStates: FloatingCodeEditor.getAllStates(),
                timestamp: new Date().toISOString()
            };

            const { source, isOwner, projectId } = this.projectState;

            // Determine save behavior based on project state
            if (source === 'new' || source === 'file') {
                // Create new cloud project
                return { needsName: true, projectData };
            } else if (source === 'cloud' && isOwner) {
                // Update existing project
                await this.apiClient.updateProject(projectId, {
                    name: this.projectTitle,
                    data: projectData
                });

                // Update state
                this.projectState.lastModified = projectData.timestamp;
                this.markClean();

                // Save both to localStorage and project-specific copy
                this.saveGraph();
                this.saveLocalProjectCopy(projectId, {
                    graph: projectData.graph,
                    projectTitle: this.projectTitle,
                    currentProjectId: projectId,
                    editorStates: projectData.editorStates,
                    projectState: this.projectState,
                    customNodes: projectData.customNodes
                });

                console.log('Project updated:', this.projectTitle);
                return { success: true };
            } else if (source === 'cloud' && !isOwner) {
                // Fork: Create copy of someone else's project
                return {
                    needsName: true,
                    projectData,
                    isFork: true,
                    originalName: this.projectState.title
                };
            }
        } catch (err) {
            alert('Failed to save project: ' + err.message);
            return { error: err };
        }
    }

    async saveNewProject(name, projectData) {
        try {
            const currentUser = this.apiClient.getCurrentUser();
            const result = await this.apiClient.saveProject(name, projectData);

            // Update legacy fields
            this.currentProjectId = result.id;
            this.projectTitle = name;
            this.viewingSharedProject = null;

            // Update project state - now it's our cloud project
            this.projectState = {
                projectId: result.id,
                ownerId: currentUser?.userId || null,
                ownerUsername: currentUser?.username || null,
                isOwner: true,
                isDirty: false,
                source: 'cloud',
                lastModified: projectData.timestamp || new Date().toISOString(),
                title: name
            };

            // Update UI
            document.getElementById('projectTitleDisplay').textContent = name;
            this.updateOwnershipDisplay();

            // Set URL to new project
            this.setProjectUrl(result.id);

            // Save to localStorage
            this.saveGraph();

            return true;
        } catch (err) {
            throw err;
        }
    }

    async loadCloudProject(projectId, onCreateCustomNode) {
        try {
            // IMPORTANT: Save current project's local copy before switching
            // This must happen BEFORE we change projectState
            if (this.projectState.projectId && this.projectState.isDirty) {
                const currentData = {
                    graph: this.nodeGraph.serialize(),
                    projectTitle: this.projectTitle,
                    currentProjectId: this.currentProjectId,
                    editorStates: FloatingCodeEditor.getAllStates(),
                    projectState: this.projectState
                };
                this.saveLocalProjectCopy(this.projectState.projectId, currentData);
                console.log(`Saved local copy of project ${this.projectState.projectId} before switching`);
            }

            const project = await this.apiClient.getProject(projectId);
            console.log('Loaded project from API:', project);
            const currentUser = this.apiClient.getCurrentUser();

            // Check if we have a local copy
            const localCopy = this.getLocalProjectCopy(projectId);

            // Compare timestamps if both exist
            let useLocalCopy = false;
            let dataToLoad = project.data;

            if (localCopy && localCopy.localTimestamp && project.data.timestamp) {
                const localTime = new Date(localCopy.localTimestamp);
                const cloudTime = new Date(project.data.timestamp);

                if (localTime > cloudTime) {
                    useLocalCopy = true;
                    console.log('Using local copy (more recent than cloud version)');

                    // Local copy has the full localStorage structure, extract the project data
                    // Need to reconstruct it in the same format as project.data
                    dataToLoad = {
                        version: '1.0',
                        graph: localCopy.graph,
                        customNodes: localCopy.customNodes || {},
                        editorStates: localCopy.editorStates || [],
                        timestamp: localCopy.localTimestamp
                    };
                }
            }

            // Handle new format (with version, graph, customNodes)
            if (dataToLoad.graph) {
                // New format: {version, graph, customNodes, ...}
                // Load custom nodes first
                if (dataToLoad.customNodes) {
                    for (const [nodeName, nodeData] of Object.entries(dataToLoad.customNodes)) {
                        onCreateCustomNode(nodeName, nodeData.customGLSL);
                    }
                }

                // Then deserialize the graph
                this.nodeGraph.deserialize(dataToLoad.graph);
            } else if (dataToLoad.nodes) {
                // Very old format - graph data directly with nodes/connections
                this.nodeGraph.deserialize(dataToLoad);
            } else {
                throw new Error('Invalid project data format');
            }

            // Update legacy fields
            this.projectTitle = project.name;
            this.currentProjectId = projectId;

            // Update project state
            const isOwner = project.isOwner || (currentUser && project.userId === currentUser.userId);
            this.projectState = {
                projectId: projectId,
                ownerId: project.userId,
                ownerUsername: project.username,
                isOwner: isOwner,
                isDirty: useLocalCopy, // Mark as dirty if using local (newer) copy
                source: 'cloud',
                lastModified: useLocalCopy ? localCopy.localTimestamp : (project.data.timestamp || new Date().toISOString()),
                title: project.name
            };

            // Update legacy viewingSharedProject for compatibility
            if (!isOwner) {
                this.viewingSharedProject = {
                    id: projectId,
                    name: project.name,
                    username: project.username,
                    isOwner: false
                };
            } else {
                this.viewingSharedProject = null;
            }

            // Update UI
            document.getElementById('projectTitleDisplay').textContent = project.name;
            this.updateOwnershipDisplay();

            // Set URL
            this.setProjectUrl(projectId);

            // Save to localStorage (but skip project copy to avoid overwriting)
            this.saveGraph();

            console.log(`Loaded project: ${project.name}${useLocalCopy ? ' (from local copy)' : ''}`);

            // Return editor states if present
            return {
                success: true,
                editorStates: dataToLoad.editorStates || []
            };
        } catch (err) {
            console.error('Load error:', err);
            alert('Failed to load project: ' + err.message);
            return false;
        }
    }

    setProjectTitle(title) {
        this.projectTitle = title || 'Untitled Project';
        this.projectState.title = this.projectTitle;
        document.getElementById('projectTitleDisplay').textContent = this.projectTitle;
        // Mark as dirty since title changed
        this.markDirty();
    }

    clearProject() {
        this.currentProjectId = null;
        this.projectTitle = 'Untitled Project';
        document.getElementById('projectTitleDisplay').textContent = this.projectTitle;

        // Reset project state
        this.projectState = {
            projectId: null,
            ownerId: null,
            ownerUsername: null,
            isOwner: false,
            isDirty: false,
            source: 'new',
            lastModified: null,
            title: 'Untitled Project'
        };

        this.clearProjectUrl();
        // Save to localStorage only (no project copy for cleared project)
        this.saveGraph();
    }

    /**
     * Set URL to reflect current project
     */
    setProjectUrl(projectId) {
        if (!projectId) return;
        const url = new URL(window.location);
        url.searchParams.set('project', projectId);
        window.history.replaceState({}, '', url);
    }

    /**
     * Clear project from URL
     */
    clearProjectUrl() {
        window.history.replaceState({}, '', window.location.pathname);
    }

    /**
     * Mark project as dirty (has unsaved changes)
     */
    markDirty() {
        this.projectState.isDirty = true;
        this.projectState.lastModified = new Date().toISOString();
        this.saveGraph(); // Auto-save to localStorage
    }

    /**
     * Mark project as clean (saved)
     */
    markClean() {
        this.projectState.isDirty = false;
    }

    /**
     * Get local copy of a project by ID
     */
    getLocalProjectCopy(projectId) {
        try {
            const key = `patchtoy_project_${projectId}`;
            const saved = localStorage.getItem(key);
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.error('Failed to get local project copy:', e);
        }
        return null;
    }

    /**
     * Save local copy of a project by ID
     */
    saveLocalProjectCopy(projectId, projectData) {
        try {
            const key = `patchtoy_project_${projectId}`;
            const data = {
                ...projectData,
                localTimestamp: new Date().toISOString()
            };
            localStorage.setItem(key, JSON.stringify(data));
        } catch (e) {
            console.error('Failed to save local project copy:', e);
        }
    }

    /**
     * Update ownership display in UI
     */
    updateOwnershipDisplay() {
        const titleElement = document.getElementById('projectTitleDisplay');

        // Guard against missing DOM elements (e.g., during initialization)
        if (!titleElement) {
            return;
        }

        let ownershipElement = document.getElementById('projectOwnershipDisplay');

        if (!ownershipElement && titleElement.parentElement) {
            // Create ownership display element if it doesn't exist
            const container = titleElement.parentElement;
            const newElement = document.createElement('div');
            newElement.id = 'projectOwnershipDisplay';
            newElement.style.cssText = 'font-size: 11px; color: #888; margin-top: 2px;';
            container.appendChild(newElement);
            ownershipElement = newElement;
        }

        if (!ownershipElement) {
            return;
        }

        if (this.projectState && this.projectState.ownerUsername && !this.projectState.isOwner) {
            ownershipElement.textContent = `by @${this.projectState.ownerUsername}`;
            ownershipElement.style.display = 'block';
        } else {
            ownershipElement.style.display = 'none';
        }
    }
}
