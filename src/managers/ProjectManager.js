import { NodeDefinitions } from '../core/NodeDefinitions.js';

export class ProjectManager {
    constructor(nodeGraph, apiClient) {
        this.nodeGraph = nodeGraph;
        this.apiClient = apiClient;
        this.projectTitle = 'Untitled Project';
        this.currentProjectId = null;
        this.viewingSharedProject = null; // { id, name, username, isOwner }
    }

    saveGraph() {
        try {
            const data = {
                graph: this.nodeGraph.serialize(),
                projectTitle: this.projectTitle,
                currentProjectId: this.currentProjectId
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
                } else {
                    // Old format - just the graph data
                    this.nodeGraph.deserialize(data);
                }
                return true;
            }
        } catch (e) {
            console.error('Failed to load graph:', e);
        }
        return false;
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

            // Save to localStorage
            this.saveGraph();
            onSaveCustomNodes();

            console.log('Project loaded from file');
            return true;
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
                timestamp: new Date().toISOString()
            };

            // Check if viewing someone else's shared project
            if (this.viewingSharedProject && !this.viewingSharedProject.isOwner) {
                // Fork: Always create new project
                return { needsName: true, projectData, isFork: true, originalName: this.viewingSharedProject.name };
            }

            if (this.currentProjectId) {
                // Update existing project
                await this.apiClient.updateProject(this.currentProjectId, {
                    name: this.projectTitle,
                    data: projectData
                });
                console.log('Project updated:', this.projectTitle);
                return { success: true };
            } else {
                // Create new project - caller should show dialog
                return { needsName: true, projectData };
            }
        } catch (err) {
            alert('Failed to save project: ' + err.message);
            return { error: err };
        }
    }

    async saveNewProject(name, projectData) {
        try {
            const result = await this.apiClient.saveProject(name, projectData);
            this.currentProjectId = result.id;
            this.projectTitle = name;
            document.getElementById('projectTitleDisplay').textContent = name;
            this.saveGraph();
            return true;
        } catch (err) {
            throw err;
        }
    }

    async loadCloudProject(projectId, onCreateCustomNode) {
        try {
            const project = await this.apiClient.getProject(projectId);

            // Handle new format (with version, graph, customNodes)
            if (project.data.version && project.data.graph) {
                // Load custom nodes first
                if (project.data.customNodes) {
                    for (const [nodeName, nodeData] of Object.entries(project.data.customNodes)) {
                        onCreateCustomNode(nodeName, nodeData.customGLSL);
                    }
                }

                // Then deserialize the graph
                this.nodeGraph.deserialize(project.data.graph);
            } else {
                // Old format - just the graph data directly
                this.nodeGraph.deserialize(project.data);
            }

            this.projectTitle = project.name;
            this.currentProjectId = projectId;
            document.getElementById('projectTitleDisplay').textContent = project.name;
            console.log(`Loaded project: ${project.name}`);
            return true;
        } catch (err) {
            console.error('Load error:', err);
            alert('Failed to load project: ' + err.message);
            return false;
        }
    }

    setProjectTitle(title) {
        this.projectTitle = title || 'Untitled Project';
        document.getElementById('projectTitleDisplay').textContent = this.projectTitle;
        this.saveGraph();
    }

    clearProject() {
        this.currentProjectId = null;
        this.projectTitle = 'Untitled Project';
        document.getElementById('projectTitleDisplay').textContent = this.projectTitle;
        this.saveGraph();
    }
}
