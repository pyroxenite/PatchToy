import { NodeDefinitions } from '../core/NodeDefinitions.js';

export class ProjectDialogs {
    /**
     * Show the main project menu with current project info and cloud projects list
     * @param {Object} options - Configuration object
     * @param {ApiClient} options.apiClient - API client instance
     * @param {string} options.projectTitle - Current project title
     * @param {string} options.currentProjectId - Current project ID (if any)
     * @param {Function} options.onProjectTitleChange - Callback when project title changes (newTitle)
     * @param {Function} options.onNewProject - Callback when New Project button is clicked
     * @param {Function} options.onLoadLocalClick - Callback when Load Local button is clicked
     * @param {Function} options.onLoadCloudProject - Callback when cloud project is clicked (projectId)
     * @param {Function} options.onShowCurrentProjectMenu - Callback to show current project menu (anchorBtn)
     * @param {Function} options.onShowProjectOptionsMenu - Callback to show project options menu (project, anchorBtn, listItem)
     */
    static showProjectMenu({
        apiClient,
        projectTitle,
        currentProjectId,
        onProjectTitleChange,
        onNewProject,
        onLoadLocalClick,
        onLoadCloudProject,
        onShowCurrentProjectMenu,
        onShowProjectOptionsMenu
    }) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: transparent; z-index: 10001;';

        const menu = document.createElement('div');
        menu.style.cssText = `
            position: absolute;
            top: 80px;
            left: 20px;
            background: rgba(45, 45, 45, 0.98);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(68, 68, 68, 0.5);
            border-radius: 8px;
            padding: 12px;
            width: 400px;
            max-width: calc(100vw - 40px);
            max-height: calc(100vh - 120px);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
            display: flex;
            flex-direction: column;
        `;

        // Header with current project title
        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid rgba(68, 68, 68, 0.5);';

        // Title input with options button
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';

        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.value = projectTitle;
        titleInput.placeholder = 'Current Project';
        titleInput.style.cssText = `
            flex: 1;
            padding: 8px 12px;
            background: rgba(30, 30, 30, 0.8);
            border: 1px solid #444;
            color: #fff;
            border-radius: 4px;
            font-size: 14px;
        `;
        titleInput.addEventListener('change', (e) => {
            const newTitle = e.target.value.trim() || 'Untitled Project';
            if (onProjectTitleChange) {
                onProjectTitleChange(newTitle);
            }
        });

        // Current project options button
        const currentProjectMenuBtn = document.createElement('button');
        currentProjectMenuBtn.textContent = '⋮';
        currentProjectMenuBtn.style.cssText = 'padding: 8px 12px; background: rgba(30, 30, 30, 0.8); border: 1px solid #444; border-radius: 4px; color: #888; cursor: pointer; font-size: 16px; font-weight: bold;';
        currentProjectMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onShowCurrentProjectMenu) {
                onShowCurrentProjectMenu(currentProjectMenuBtn);
            }
        });

        titleRow.appendChild(titleInput);
        titleRow.appendChild(currentProjectMenuBtn);
        header.appendChild(titleRow);

        menu.appendChild(header);

        // Projects header with New Project and Load Local buttons (below divider)
        const projectsHeader = document.createElement('div');
        projectsHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;';

        const projectsTitle = document.createElement('div');
        projectsTitle.textContent = 'Projects';
        projectsTitle.style.cssText = 'color: #fff; font-size: 14px; font-weight: 600;';

        const buttonsContainer = document.createElement('div');
        buttonsContainer.style.cssText = 'display: flex; gap: 8px;';

        const newProjectBtn = document.createElement('button');
        newProjectBtn.textContent = 'New';
        newProjectBtn.style.cssText = `
            padding: 6px 12px;
            background: transparent;
            border: 1px solid #444;
            color: #fff;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
        `;
        newProjectBtn.addEventListener('mouseover', () => {
            newProjectBtn.style.background = 'rgba(0, 122, 204, 0.2)';
            newProjectBtn.style.borderColor = '#007acc';
        });
        newProjectBtn.addEventListener('mouseout', () => {
            newProjectBtn.style.background = 'transparent';
            newProjectBtn.style.borderColor = '#444';
        });
        newProjectBtn.addEventListener('click', () => {
            overlay.remove();
            if (onNewProject) {
                onNewProject();
            }
        });

        const loadLocalBtn = document.createElement('button');
        loadLocalBtn.textContent = 'Load Local';
        loadLocalBtn.style.cssText = `
            padding: 6px 12px;
            background: transparent;
            border: 1px solid #444;
            color: #fff;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
        `;
        loadLocalBtn.addEventListener('mouseover', () => {
            loadLocalBtn.style.background = 'rgba(0, 122, 204, 0.2)';
            loadLocalBtn.style.borderColor = '#007acc';
        });
        loadLocalBtn.addEventListener('mouseout', () => {
            loadLocalBtn.style.background = 'transparent';
            loadLocalBtn.style.borderColor = '#444';
        });
        loadLocalBtn.addEventListener('click', () => {
            overlay.remove();
            if (onLoadLocalClick) {
                onLoadLocalClick();
            }
        });

        buttonsContainer.appendChild(newProjectBtn);
        buttonsContainer.appendChild(loadLocalBtn);

        projectsHeader.appendChild(projectsTitle);
        projectsHeader.appendChild(buttonsContainer);
        menu.appendChild(projectsHeader);

        // Cloud projects list (if logged in)
        if (apiClient.isLoggedIn()) {
            const cloudSection = document.createElement('div');
            cloudSection.style.cssText = 'flex: 1; overflow: hidden; display: flex; flex-direction: column;';

            const cloudHeader = document.createElement('div');
            cloudHeader.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';

            const cloudTitle = document.createElement('div');
            cloudTitle.textContent = 'Cloud Projects';
            cloudTitle.style.cssText = 'color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;';

            const user = apiClient.getCurrentUser();
            const username = document.createElement('div');
            username.textContent = `@${user?.username || 'user'}`;
            username.style.cssText = 'color: #666; font-size: 11px;';

            cloudHeader.appendChild(cloudTitle);
            cloudHeader.appendChild(username);
            cloudSection.appendChild(cloudHeader);

            // Loading state
            const loading = document.createElement('div');
            loading.textContent = 'Loading...';
            loading.style.cssText = 'color: #888; padding: 20px; text-align: center; font-size: 13px;';
            cloudSection.appendChild(loading);

            menu.appendChild(cloudSection);

            // Load projects asynchronously (don't block menu display)
            (async () => {
                try {
                    const result = await apiClient.listProjects();
                    const projects = result.projects || [];

                    loading.remove();

                if (projects.length === 0) {
                    const empty = document.createElement('div');
                    empty.textContent = 'No cloud projects yet';
                    empty.style.cssText = 'color: #666; padding: 20px; text-align: center; font-size: 13px;';
                    cloudSection.appendChild(empty);
                } else {
                    const projectList = document.createElement('div');
                    projectList.style.cssText = 'flex: 1; overflow-y: auto; margin-right: -8px; padding-right: 8px;';

                    for (const project of projects) {
                        const isCurrent = currentProjectId === project.id;

                        const item = document.createElement('div');
                        item.style.cssText = `
                            background: ${isCurrent ? 'rgba(0, 122, 204, 0.15)' : 'transparent'};
                            padding: 12px;
                            margin-bottom: 4px;
                            border-radius: 6px;
                            cursor: pointer;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            transition: all 0.2s;
                            border-left: 3px solid ${isCurrent ? '#007acc' : 'transparent'};
                        `;

                        item.addEventListener('click', async () => {
                            if (onLoadCloudProject) {
                                await onLoadCloudProject(project.id);
                            }
                            overlay.remove();
                        });

                        item.addEventListener('mouseenter', () => {
                            if (!isCurrent) {
                                item.style.background = 'rgba(255, 255, 255, 0.05)';
                            } else {
                                item.style.background = 'rgba(0, 122, 204, 0.25)';
                            }
                        });
                        item.addEventListener('mouseleave', () => {
                            if (!isCurrent) {
                                item.style.background = 'transparent';
                            } else {
                                item.style.background = 'rgba(0, 122, 204, 0.15)';
                            }
                        });

                        const info = document.createElement('div');
                        info.style.cssText = 'flex: 1; pointer-events: none;';

                        const topRow = document.createElement('div');
                        topRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';

                        const projectName = document.createElement('div');
                        projectName.textContent = project.name;
                        projectName.style.cssText = `color: ${isCurrent ? '#fff' : '#ccc'}; font-size: 13px; font-weight: ${isCurrent ? '600' : '400'};`;

                        // TODO: Add public/private icon when backend supports it
                        // const visibilityIcon = document.createElement('span');
                        // visibilityIcon.textContent = '🔒'; // or 🌐 for public
                        // visibilityIcon.style.cssText = 'font-size: 11px; opacity: 0.6;';

                        topRow.appendChild(projectName);
                        // topRow.appendChild(visibilityIcon);

                        const projectMeta = document.createElement('div');
                        const date = new Date(project.updatedAt).toLocaleDateString();
                        projectMeta.textContent = date;
                        projectMeta.style.cssText = 'color: #666; font-size: 11px;';

                        info.appendChild(topRow);
                        info.appendChild(projectMeta);

                        // Options menu button
                        const menuBtn = document.createElement('button');
                        menuBtn.textContent = '⋮';
                        menuBtn.style.cssText = `padding: 4px 8px; background: transparent; border: 1px solid ${isCurrent ? '#007acc' : '#444'}; border-radius: 4px; color: ${isCurrent ? '#007acc' : '#888'}; cursor: pointer; font-size: 14px; font-weight: bold;`;
                        menuBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (onShowProjectOptionsMenu) {
                                onShowProjectOptionsMenu(project, menuBtn, item);
                            }
                        });
                        menuBtn.addEventListener('mouseenter', () => {
                            menuBtn.style.background = 'rgba(0, 122, 204, 0.2)';
                            menuBtn.style.borderColor = '#007acc';
                            menuBtn.style.color = '#fff';
                        });
                        menuBtn.addEventListener('mouseleave', () => {
                            menuBtn.style.background = 'transparent';
                            menuBtn.style.borderColor = isCurrent ? '#007acc' : '#444';
                            menuBtn.style.color = isCurrent ? '#007acc' : '#888';
                        });

                        item.appendChild(info);
                        item.appendChild(menuBtn);

                        projectList.appendChild(item);
                    }

                    cloudSection.appendChild(projectList);
                }
            } catch (err) {
                loading.textContent = 'Error loading projects';
                loading.style.color = '#f44336';
            }
        })();
        }

        overlay.appendChild(menu);
        document.body.appendChild(overlay);

        // Close on click outside
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });

        // Focus the title input
        setTimeout(() => titleInput.select(), 0);
    }

    /**
     * Show options menu for a cloud project (download, duplicate, delete)
     * @param {Object} options - Configuration object
     * @param {Object} options.project - Project object from cloud
     * @param {HTMLElement} options.anchorBtn - Button element to anchor menu to
     * @param {HTMLElement} options.listItem - List item element (for removal on delete)
     * @param {ApiClient} options.apiClient - API client instance
     * @param {string} options.currentProjectId - Current project ID
     * @param {Function} options.onProjectDeleted - Callback when project is deleted
     * @param {Function} options.onProjectDuplicated - Callback when project is duplicated
     */
    static showProjectOptionsMenu({
        project,
        anchorBtn,
        listItem,
        apiClient,
        currentProjectId,
        onProjectDeleted,
        onProjectDuplicated
    }) {
        // Remove any existing menu
        const existingMenu = document.querySelector('.project-options-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'project-options-menu';
        menu.style.cssText = `
            position: absolute;
            background: rgba(45, 45, 45, 0.98);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(68, 68, 68, 0.5);
            border-radius: 6px;
            padding: 6px;
            min-width: 160px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
            z-index: 10002;
        `;

        const createOption = (icon, text, onClick) => {
            const option = document.createElement('button');
            option.textContent = `${icon} ${text}`;
            option.style.cssText = `
                width: 100%;
                padding: 8px 12px;
                background: transparent;
                border: none;
                color: #fff;
                text-align: left;
                cursor: pointer;
                border-radius: 4px;
                font-size: 13px;
                display: flex;
                align-items: center;
                gap: 8px;
            `;
            option.addEventListener('mouseenter', () => {
                option.style.background = 'rgba(0, 122, 204, 0.2)';
            });
            option.addEventListener('mouseleave', () => {
                option.style.background = 'transparent';
            });
            option.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.remove();
                await onClick();
            });
            return option;
        };

        // Download option
        menu.appendChild(createOption('⬇️', 'Download', async () => {
            try {
                const fullProject = await apiClient.getProject(project.id);
                const projectData = JSON.stringify(fullProject.data, null, 2);
                const blob = new Blob([projectData], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${project.name}.json`;
                a.click();
                URL.revokeObjectURL(url);
            } catch (err) {
                alert('Failed to download project: ' + err.message);
            }
        }));

        // Duplicate option
        menu.appendChild(createOption('📋', 'Duplicate', async () => {
            try {
                const fullProject = await apiClient.getProject(project.id);
                const newName = `${project.name} (Copy)`;
                await apiClient.saveProject(newName, fullProject.data);
                alert(`Project duplicated as "${newName}"`);

                // Notify parent to refresh
                if (onProjectDuplicated) {
                    onProjectDuplicated(newName);
                }
            } catch (err) {
                alert('Failed to duplicate project: ' + err.message);
            }
        }));

        // Share option
        menu.appendChild(createOption('🔗', project.isPublic ? 'Make Private' : 'Share Link', async () => {
            try {
                const newVisibility = !project.isPublic;
                await apiClient.toggleProjectVisibility(project.id, newVisibility);
                project.isPublic = newVisibility; // Update local state

                if (newVisibility) {
                    // Show share link dialog
                    const shareUrl = `${window.location.origin}?project=${project.id}`;
                    const overlay = document.createElement('div');
                    overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.5); z-index: 10003; display: flex; align-items: center; justify-content: center;';

                    const dialog = document.createElement('div');
                    dialog.style.cssText = 'background: rgba(45, 45, 45, 0.98); border: 1px solid rgba(68, 68, 68, 0.5); border-radius: 8px; padding: 24px; max-width: 500px; width: calc(100vw - 40px);';

                    const title = document.createElement('div');
                    title.textContent = 'Share Project';
                    title.style.cssText = 'color: #fff; font-size: 16px; font-weight: 600; margin-bottom: 16px;';

                    const message = document.createElement('div');
                    message.textContent = 'Anyone with this link can view your project:';
                    message.style.cssText = 'color: #ccc; font-size: 13px; margin-bottom: 12px;';

                    const linkContainer = document.createElement('div');
                    linkContainer.style.cssText = 'display: flex; gap: 8px; margin-bottom: 16px;';

                    const linkInput = document.createElement('input');
                    linkInput.type = 'text';
                    linkInput.value = shareUrl;
                    linkInput.readOnly = true;
                    linkInput.style.cssText = 'flex: 1; padding: 8px 12px; background: rgba(30, 30, 30, 0.8); border: 1px solid #444; color: #fff; border-radius: 4px; font-size: 13px;';

                    const copyBtn = document.createElement('button');
                    copyBtn.textContent = 'Copy';
                    copyBtn.style.cssText = 'padding: 8px 16px; background: #007acc; border: none; color: #fff; cursor: pointer; border-radius: 4px; font-size: 13px;';
                    copyBtn.addEventListener('click', () => {
                        navigator.clipboard.writeText(shareUrl);
                        copyBtn.textContent = 'Copied!';
                        setTimeout(() => copyBtn.textContent = 'Copy', 2000);
                    });

                    const closeBtn = document.createElement('button');
                    closeBtn.textContent = 'Close';
                    closeBtn.style.cssText = 'width: 100%; padding: 8px; background: rgba(30, 30, 30, 0.8); border: 1px solid #444; color: #fff; cursor: pointer; border-radius: 4px; font-size: 13px;';
                    closeBtn.addEventListener('click', () => overlay.remove());

                    linkContainer.appendChild(linkInput);
                    linkContainer.appendChild(copyBtn);
                    dialog.appendChild(title);
                    dialog.appendChild(message);
                    dialog.appendChild(linkContainer);
                    dialog.appendChild(closeBtn);
                    overlay.appendChild(dialog);
                    document.body.appendChild(overlay);

                    // Auto-select the link
                    linkInput.select();
                } else {
                    alert('Project is now private');
                }
            } catch (err) {
                alert('Failed to toggle visibility: ' + err.message);
            }
        }));

        // Delete option
        menu.appendChild(createOption('🗑️', 'Delete', async () => {
            if (confirm(`Delete "${project.name}"? This cannot be undone.`)) {
                try {
                    await apiClient.deleteProject(project.id);
                    listItem.remove();

                    // Notify parent if current project was deleted
                    if (currentProjectId === project.id && onProjectDeleted) {
                        onProjectDeleted(project.id);
                    }
                } catch (err) {
                    alert('Failed to delete project: ' + err.message);
                }
            }
        }));

        // Position the menu
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 5}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;

        document.body.appendChild(menu);

        // Close menu when clicking outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== anchorBtn) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }

    /**
     * Show options menu for current project (download)
     * @param {Object} options - Configuration object
     * @param {HTMLElement} options.anchorBtn - Button element to anchor menu to
     * @param {Function} options.onDownload - Callback when download is clicked
     */
    static showCurrentProjectMenu({ anchorBtn, onDownload }) {
        // Remove any existing menu
        const existingMenu = document.querySelector('.current-project-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'current-project-menu';
        menu.style.cssText = `
            position: absolute;
            background: rgba(45, 45, 45, 0.98);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(68, 68, 68, 0.5);
            border-radius: 6px;
            padding: 6px;
            min-width: 160px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
            z-index: 10002;
        `;

        const createOption = (icon, text, onClick) => {
            const option = document.createElement('button');
            option.textContent = `${icon} ${text}`;
            option.style.cssText = `
                width: 100%;
                padding: 8px 12px;
                background: transparent;
                border: none;
                color: #fff;
                text-align: left;
                cursor: pointer;
                border-radius: 4px;
                font-size: 13px;
                display: flex;
                align-items: center;
                gap: 8px;
            `;
            option.addEventListener('mouseenter', () => {
                option.style.background = 'rgba(0, 122, 204, 0.2)';
            });
            option.addEventListener('mouseleave', () => {
                option.style.background = 'transparent';
            });
            option.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.remove();
                await onClick();
            });
            return option;
        };

        // Download current project
        menu.appendChild(createOption('⬇️', 'Download', () => {
            if (onDownload) {
                onDownload();
            }
        }));

        // Position the menu
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 5}px`;
        menu.style.left = `${rect.left}px`;

        document.body.appendChild(menu);

        // Close menu when clicking outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== anchorBtn) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }

    /**
     * Show dialog to save project to cloud
     * @param {Object} options - Configuration object
     * @param {ApiClient} options.apiClient - API client instance
     * @param {string} options.projectTitle - Current project title
     * @param {string} options.currentProjectId - Current project ID (if updating)
     * @param {Function} options.serializeGraph - Function that returns serialized graph data
     * @param {Function} options.onSaveSuccess - Callback when save succeeds (projectId, projectName)
     */
    static showSaveProjectDialog({
        apiClient,
        projectTitle,
        currentProjectId,
        serializeGraph,
        onSaveSuccess
    }) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background: #2d2d2d; border: 1px solid #444; border-radius: 8px; padding: 20px; width: 400px; max-width: 90vw;';

        const title = document.createElement('h2');
        title.textContent = 'Save Project to Cloud';
        title.style.cssText = 'margin: 0 0 20px 0; color: #fff; font-size: 18px;';
        dialog.appendChild(title);

        const label = document.createElement('label');
        label.textContent = 'Project Name';
        label.style.cssText = 'display: block; color: #ccc; margin-bottom: 5px;';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'My Awesome Shader';
        input.value = projectTitle || `Project ${new Date().toLocaleDateString()}`;
        input.style.cssText = 'width: 100%; padding: 8px; background: #1e1e1e; border: 1px solid #444; color: #fff; border-radius: 4px; margin-bottom: 20px; box-sizing: border-box;';

        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color: #f44336; margin-bottom: 15px; display: none;';

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 10px;';

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.style.cssText = 'flex: 1; padding: 10px; background: #007acc; border: none; border-radius: 4px; color: #fff; cursor: pointer; font-size: 14px;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'flex: 1; padding: 10px; background: #333; border: none; border-radius: 4px; color: #fff; cursor: pointer; font-size: 14px;';

        saveBtn.addEventListener('click', async () => {
            const name = input.value.trim();
            if (!name) {
                errorMsg.textContent = 'Project name is required';
                errorMsg.style.display = 'block';
                return;
            }

            try {
                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';

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

                // Get serialized graph data
                const graphData = serializeGraph ? serializeGraph() : {};

                // Create project data with custom nodes
                const projectData = {
                    version: '1.0',
                    graph: graphData,
                    customNodes: customNodes,
                    timestamp: new Date().toISOString()
                };

                let result;
                if (currentProjectId) {
                    // Update existing project
                    result = await apiClient.updateProject(currentProjectId, { name, data: projectData });
                } else {
                    // Create new project
                    result = await apiClient.saveProject(name, projectData);
                }

                overlay.remove();

                // Notify parent of successful save
                if (onSaveSuccess) {
                    onSaveSuccess(result.id || currentProjectId, name);
                }

                alert('Project saved to cloud!');
            } catch (err) {
                errorMsg.textContent = err.message || 'Failed to save project';
                errorMsg.style.display = 'block';
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        });

        cancelBtn.addEventListener('click', () => overlay.remove());

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') saveBtn.click();
        });

        dialog.appendChild(label);
        dialog.appendChild(input);
        dialog.appendChild(errorMsg);
        buttonContainer.appendChild(saveBtn);
        buttonContainer.appendChild(cancelBtn);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        setTimeout(() => input.select(), 0);
    }
}
