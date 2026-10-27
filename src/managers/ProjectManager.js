import { NodeDefinitions } from '../core/NodeDefinitions.js';
import { FloatingCodeEditor } from '../ui/FloatingCodeEditor.js';
import { UIHelpers, h } from '../ui/UIHelpers.js';
import { navigate, paths } from '../core/router.js';
import { collectCustomNodes, sanitizeCustomNodeMap } from '../core/customNodes.js';
import { contentGate } from '../core/contentGate.js';

const AUTOSAVE_KEY = 'patchtoy_graph';
/** Raw copy of an autosave that failed to restore (never overwritten by a later autosave). */
const AUTOSAVE_BACKUP_KEY = 'patchtoy_graph_corrupt';

/** Client-side visibility of a project card / state ('private' | 'unlisted' | 'public'). */
export function visibilityOf(p) {
    if (!p) return 'private';
    if (p.visibility === 'public' || p.visibility === 'unlisted' || p.visibility === 'private') return p.visibility;
    return p.isPublic ? 'unlisted' : 'private';
}

export class ProjectManager {
    constructor(nodeGraph, apiClient) {
        this.nodeGraph = nodeGraph;
        this.apiClient = apiClient;
        this.projectTitle = 'Untitled Project';
        this.currentProjectId = null;
        this.viewingSharedProject = null; // { id, name, username, isOwner }
        /** Set by main.js: register a custom node scoped to the opened project / forget them. */
        this.registerProjectCustomNode = null;
        this.releaseCustomNodes = null;
        /** False while a restore failed: autosaving would overwrite what couldn't be read. */
        this.autosaveEnabled = true;

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

    /**
     * Register a project's embedded custom nodes, scoped to that project. Invalid ones
     * (bad names, built-in names like "UV", "__proto__") are skipped with one warning.
     */
    registerCustomNodes(customNodes, onCreateCustomNode = null, { quiet = false } = {}) {
        const dropped = [];
        const valid = sanitizeCustomNodeMap(customNodes, (name, why) => dropped.push({ name, why }));
        const register = this.registerProjectCustomNode || onCreateCustomNode;
        for (const [name, glsl] of valid) {
            const ok = register ? register(name, glsl) : false;
            if (!ok) dropped.push({ name, why: 'its GLSL could not be parsed' });
        }
        if (dropped.length) {
            for (const d of dropped) console.warn(`[custom nodes] skipped ${JSON.stringify(String(d.name).slice(0, 60))}: ${d.why}`);
            if (!quiet) {
                UIHelpers.notify(
                    dropped.map(d => `“${String(d.name).slice(0, 40)}”: ${d.why}`).slice(0, 4).join('\n'),
                    'warning',
                    { title: `${dropped.length} custom node${dropped.length > 1 ? 's' : ''} in this project ${dropped.length > 1 ? 'were' : 'was'} ignored` }
                );
            }
        }
        return dropped;
    }

    /** Warn about nodes that couldn't be restored (kept in the project data, see NodeGraph.deserialize). */
    reportMissingNodes() {
        const missing = this.nodeGraph.missingNodes || [];
        if (!missing.length) return;
        const types = [...new Set(missing.map(n => n.type))].slice(0, 5).join(', ');
        UIHelpers.notify(`Unknown node types: ${types}. They are kept in the project but not shown.`, 'warning', {
            title: `${missing.length} node${missing.length > 1 ? 's' : ''} couldn’t be restored`
        });
    }

    saveGraph() {
        if (!this.autosaveEnabled) return;
        try {
            const graph = this.nodeGraph.serialize();
            const data = {
                graph,
                // The custom nodes this patch needs travel with the autosave (scoped to it)
                customNodes: collectCustomNodes(graph),
                projectTitle: this.projectTitle,
                currentProjectId: this.currentProjectId,
                editorStates: FloatingCodeEditor.getAllStates(),
                projectState: this.projectState
            };
            localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
        } catch (e) {
            console.error('Failed to save graph:', e);
        }
    }

    loadGraph() {
        let saved = null;
        try {
            saved = localStorage.getItem(AUTOSAVE_KEY);
            if (saved) {
                const data = JSON.parse(saved);

                // Handle old format (just graph) and new format (with metadata)
                if (data.graph) {
                    // Set metadata first: deserialize() fires onGraphChanged -> saveGraph(),
                    // which would otherwise persist the default title over the saved one.
                    this.projectTitle = data.projectTitle || 'Untitled Project';
                    this.currentProjectId = data.currentProjectId || null;
                    document.getElementById('projectTitleDisplay').textContent = this.projectTitle;

                    // Custom nodes embedded in the autosave (2.0+), scoped to this patch
                    if (data.customNodes) this.registerCustomNodes(data.customNodes, null, { quiet: true });

                    // Restore project state if present
                    const wasDirty = data.projectState ? !!data.projectState.isDirty : false;
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

                    // Someone else's project (restored after a reload): remote media waits for consent
                    const ps = this.projectState;
                    contentGate.setRestricted(ps.source === 'cloud' && !!ps.projectId && !ps.isOwner);
                    this.nodeGraph.deserialize(data.graph);
                    this.reportMissingNodes();
                    // Loading isn't an edit: keep the saved dirty flag (and persist it, since
                    // deserialize() just autosaved isDirty=true via onGraphChanged)
                    this.projectState.isDirty = wasDirty;
                    this.saveGraph();

                    // Return editor states if present (caller will restore them)
                    return data.editorStates || [];
                } else {
                    // Old format - just the graph data
                    this.nodeGraph.deserialize(data);
                    return [];
                }
            } else {
                // No saved data - initialize with bare minimum
                this.initializeEmptyProject();
            }
        } catch (e) {
            console.error('Failed to load graph:', e);
            // Never overwrite an autosave that couldn't be read: keep a raw copy, start empty
            // without saving, and tell the user
            try {
                if (saved) localStorage.setItem(AUTOSAVE_BACKUP_KEY, saved);
            } catch (err) { /* quota */ }
            this.autosaveEnabled = false;
            try {
                try { this.nodeGraph.deserialize({ nodes: [], connections: [], nextNodeId: 0 }); } catch (err) { /* ignore */ }
                this.initializeEmptyProject();
            } finally {
                this.autosaveEnabled = true;
            }
            UIHelpers.notify(
                `Your last patch couldn’t be restored (${e.message}). A copy is kept in this browser (localStorage “${AUTOSAVE_BACKUP_KEY}”).`,
                'error',
                { title: 'Autosave not restored' }
            );
        }
        return [];
    }

    /**
     * Initialize an empty project with bare minimum data
     */
    initializeEmptyProject() {
        contentGate.setRestricted(false);
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
            // The custom nodes the graph uses
            const graph = this.nodeGraph.serialize();
            const customNodes = collectCustomNodes(graph);

            // Create project data
            const projectData = {
                version: '1.0',
                graph,
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

        } catch (e) {
            console.error('Failed to save project to file:', e);
            UIHelpers.notify(e.message, 'error', { title: 'Failed to save project' });
        }
    }

    /**
     * @param {{releaseCustomNodes?: boolean}} [options] - releaseCustomNodes: false when the caller
     *   already registered this project's custom nodes (automation)
     */
    async loadProjectFromFile(file, onCreateCustomNode, onSaveCustomNodes, { releaseCustomNodes = true } = {}) {
        if (!file) return;

        try {
            const text = await file.text();
            const projectData = JSON.parse(text);

            // Validate project data
            if (!projectData.graph) {
                throw new Error('Invalid project file: missing graph data');
            }

            // Custom nodes: the project's own versions, scoped to it. The user's library is
            // never changed and same-named library nodes come back when another project opens,
            // so projects with different versions of a node (demos) open in any order.
            if (releaseCustomNodes) this.releaseCustomNodes?.();
            this.registerCustomNodes(projectData.customNodes || {}, onCreateCustomNode);

            // Files you open yourself load their media directly
            contentGate.setRestricted(false);

            // Load the graph
            this.nodeGraph.deserialize(projectData.graph);
            this.reportMissingNodes();

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
            onSaveCustomNodes?.();


            // Return editor states for restoration
            return {
                success: true,
                editorStates: projectData.editorStates || []
            };
        } catch (e) {
            console.error('Failed to load project from file:', e);
            UIHelpers.notify(e.message, 'error', { title: 'Failed to load project' });
            return false;
        }
    }

    async resolveCustomNodeConflicts(conflicts, onCreateCustomNode) {
        return new Promise((resolve) => {
            let result = false;
            const m = UIHelpers.createModal({
                title: 'Custom node conflicts',
                subtitle: 'These custom nodes already exist with different code. Choose which version to keep.',
                className: 'pt-modal--wide',
                onClose: () => resolve(result)
            });

            const choices = {};

            for (const conflict of conflicts) {
                const card = h('div', { className: 'pt-choice-card' });
                card.appendChild(h('div', { className: 'pt-choice-title', text: conflict.name }));

                const group = `conflict_${conflict.name}`;
                const radioLocal = h('input', { type: 'radio', name: group, value: 'local' });
                radioLocal.checked = true;
                const radioIncoming = h('input', { type: 'radio', name: group, value: 'incoming' });

                card.appendChild(h('label', { className: 'pt-radio' }, [radioLocal, 'Keep my version (currently in this browser)']));
                card.appendChild(h('label', { className: 'pt-radio' }, [radioIncoming, 'Use the version from the file']));
                m.body.appendChild(card);

                choices[conflict.name] = { radioLocal, radioIncoming, conflict };
            }

            const cancelBtn = UIHelpers.button('Cancel', { variant: 'ghost', onClick: () => m.close() });
            const continueBtn = UIHelpers.button('Continue', {
                variant: 'primary',
                onClick: () => {
                    for (const [name, choice] of Object.entries(choices)) {
                        if (choice.radioIncoming.checked) {
                            // Use incoming version - recreate the node
                            onCreateCustomNode(name, choice.conflict.incoming.customGLSL, true);
                        }
                        // If radioLocal is checked, do nothing (keep existing)
                    }
                    result = true;
                    m.close();
                }
            });
            m.footer.append(cancelBtn, continueBtn);
        });
    }

    /** The open patch as cloud project data (graph, the custom nodes it uses, editor states). */
    currentProjectData() {
        const graph = this.nodeGraph.serialize();
        return {
            version: '1.0',
            graph,
            customNodes: collectCustomNodes(graph),
            editorStates: FloatingCodeEditor.getAllStates(),
            timestamp: new Date().toISOString()
        };
    }

    async saveToCloud() {
        if (!this.apiClient.isLoggedIn()) {
            return { needsLogin: true };
        }

        try {
            const projectData = this.currentProjectData();

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

                return { success: true };
            } else if (source === 'cloud' && !isOwner) {
                // Fork: Create copy of someone else's project
                return {
                    needsName: true,
                    projectData,
                    isFork: true,
                    forkedFrom: projectId,
                    originalName: this.projectState.title,
                    originalOwner: this.projectState.ownerUsername
                };
            }
        } catch (err) {
            UIHelpers.notify(err.message, 'error', { title: 'Failed to save project' });
            return { error: err };
        }
    }

    /**
     * Create a cloud project from the current graph.
     * @param {{forkedFrom?: string, description?: string}} [extra] - forkedFrom: id of the project copied
     */
    async saveNewProject(name, projectData, extra = {}) {
        try {
            const currentUser = this.apiClient.getCurrentUser();
            const description = extra.description ?? this.projectState.description ?? '';
            const result = await this.apiClient.saveProject(name, projectData, { forkedFrom: extra.forkedFrom, description });

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
                title: name,
                isPublic: !!result.isPublic,
                visibility: visibilityOf(result),
                description: result.description || description || '',
                forkedFrom: result.forkedFrom || null,
                thumbUrl: null
            };

            // Your project now: its media loads directly
            contentGate.setRestricted(false);

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

    /**
     * Load a cloud project (own or public). Errors are reported with a toast, or
     * rethrown with `throwErrors` (the caller shows its own message).
     */
    async loadCloudProject(projectId, onCreateCustomNode, { throwErrors = false } = {}) {
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
            }

            const project = await this.apiClient.getProject(projectId);
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

            if (!dataToLoad || !(dataToLoad.graph || dataToLoad.nodes)) throw new Error('Invalid project data format');
            const isOwnerEarly = project.isOwner || (currentUser && project.userId === currentUser.userId);
            // Someone else's project: remote media waits for consent (src/core/contentGate.js)
            contentGate.setRestricted(!isOwnerEarly);
            this.releaseCustomNodes?.();

            // Handle new format (with version, graph, customNodes)
            if (dataToLoad.graph) {
                // New format: {version, graph, customNodes, ...}
                // Custom nodes first, scoped to this project (never written to the user's library)
                if (dataToLoad.customNodes) this.registerCustomNodes(dataToLoad.customNodes, onCreateCustomNode);

                // Then deserialize the graph
                this.nodeGraph.deserialize(dataToLoad.graph);
            } else {
                // Very old format - graph data directly with nodes/connections
                this.nodeGraph.deserialize(dataToLoad);
            }
            this.reportMissingNodes();

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
                title: project.name,
                isPublic: project.isPublic === true,
                visibility: visibilityOf(project),
                description: project.description || '',
                forkedFrom: project.forkedFrom || null,
                thumbUrl: project.thumbUrl || null,
                views: project.views || 0
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


            // Return editor states if present
            return {
                success: true,
                editorStates: dataToLoad.editorStates || []
            };
        } catch (err) {
            console.error('Load error:', err);
            if (throwErrors) throw err;
            UIHelpers.notify(err.message, 'error', { title: 'Failed to load project' });
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
        this.updateOwnershipDisplay();
        // Save to localStorage only (no project copy for cleared project)
        this.saveGraph();
    }

    /**
     * Set URL to reflect current project
     */
    setProjectUrl(projectId) {
        if (!projectId) return;
        // Share links are /p/<id> (src/core/router.js). Opened from the project browser
        // (/explore, /u/<name>), keep that page in the history so Back returns to it.
        const fromBrowser = /^\/(explore|u)(\/|$)/.test(window.location.pathname);
        navigate(paths.project(projectId), { replace: !fromBrowser, silent: true });
    }

    /**
     * Clear project from URL
     */
    clearProjectUrl() {
        if (/^\/(p|u|explore)(\/|$)/.test(window.location.pathname) || new URLSearchParams(window.location.search).has('project')) {
            navigate(paths.home(), { replace: true, silent: true });
        }
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
            newElement.className = 'tb-project-owner';
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
        // Community chrome (viewing banner, "Save a copy", URL / title) follows the project state
        window.dispatchEvent(new CustomEvent('patchtoy:project-state'));
    }
}
