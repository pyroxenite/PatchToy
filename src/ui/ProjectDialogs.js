import { NodeDefinitions } from '../core/NodeDefinitions.js';
import { UIHelpers, h } from './UIHelpers.js';
import { icon } from './icons.js';
import { collectCustomNodes } from '../core/customNodes.js';
import { visibilityOf } from '../managers/ProjectManager.js';
import { comboText } from './help/shortcuts.js';

const THUMB_COLORS = ['#ff5c2b', '#f5c84b', '#4ade80', '#8ecbff', '#a78bfa', '#f472b6', '#2dd4bf', '#fb923c'];

function thumbFor(name = '') {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    const words = name.trim().split(/\s+/).filter(Boolean);
    const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
    return { letters, color: THUMB_COLORS[Math.abs(hash) % THUMB_COLORS.length] };
}

function relativeDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d)) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
    return d.toLocaleDateString();
}

export class ProjectDialogs {
    /**
     * Show the project popover (title, actions, cloud projects list) under the project button.
     * @param {Object} options
     * @param {ApiClient} options.apiClient
     * @param {string} options.projectTitle
     * @param {string} options.currentProjectId
     * @param {Object} [options.projectState] - ProjectManager.projectState (for meta line)
     * @param {Function} options.onProjectTitleChange - (newTitle)
     * @param {Function} options.onNewProject
     * @param {Function} options.onLoadLocalClick
     * @param {Function} [options.onDownload]
     * @param {Function} [options.onBrowseDemos] - open the demo gallery
     * @param {Function} [options.onSignIn]
     * @param {Function} [options.onBrowseProjects] - open the project browser on "My projects"
     * @param {Function} [options.onBrowseCommunity] - open the project browser on "Community"
     * @param {Function} [options.onShare] - share dialog for the current project
     * @param {Function} options.onLoadCloudProject - (projectId) (legacy list, unused with onBrowseProjects)
     * @param {Function} options.onShowCurrentProjectMenu - (anchorBtn)
     * @param {Function} options.onShowProjectOptionsMenu - (project, anchorBtn, listItem)
     */
    static showProjectMenu({
        apiClient,
        projectTitle,
        currentProjectId,
        projectState = null,
        onProjectTitleChange,
        onNewProject,
        onLoadLocalClick,
        onDownload,
        onBrowseDemos,
        onSignIn,
        onBrowseProjects,
        onBrowseCommunity,
        onShare,
        onLoadCloudProject,
        onShowCurrentProjectMenu,
        onShowProjectOptionsMenu
    }) {
        const anchor = document.getElementById('projectMenuBtn');
        const content = h('div', { className: 'pt-project-menu-inner', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } });
        let menu = null;

        // ---- Head: title + more
        const head = h('div', { className: 'pm-head' });
        head.appendChild(h('span', { className: 'pt-label', text: 'Project' }));
        const titleRow = h('div', { className: 'pm-title-row' });
        const titleInput = h('input', {
            type: 'text',
            className: 'pt-input',
            placeholder: 'Untitled Project',
            spellcheck: 'false',
            'aria-label': 'Project title'
        });
        titleInput.value = projectTitle;
        titleInput.addEventListener('change', (e) => {
            const newTitle = e.target.value.trim() || 'Untitled Project';
            onProjectTitleChange?.(newTitle);
        });
        titleInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                titleInput.blur();
                menu?.close();
            }
        });

        const moreBtn = h('button', { className: 'pt-icon-btn', 'aria-label': 'Project options', 'data-tip': 'More', html: icon('more') });
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onShowCurrentProjectMenu?.(moreBtn);
        });
        titleRow.append(titleInput, moreBtn);
        head.appendChild(titleRow);

        // Meta line
        const meta = h('div', { className: 'pm-meta' });
        const source = projectState?.source || (currentProjectId ? 'cloud' : 'new');
        const sourceLabel = { cloud: 'Cloud', file: 'From file', new: 'Local' }[source] || 'Local';
        meta.appendChild(h('span', { className: 'pt-badge', text: sourceLabel }));
        if (source === 'cloud' && projectState?.isOwner) {
            meta.appendChild(h('span', { className: 'pt-badge', text: { public: 'Public', unlisted: 'Link only', private: 'Private' }[visibilityOf(projectState)] }));
        }
        if (projectState?.ownerUsername && !projectState.isOwner) {
            meta.appendChild(h('span', { text: `by @${projectState.ownerUsername} · saving creates your copy` }));
        } else if (projectState?.isDirty) {
            meta.appendChild(h('span', { text: source === 'cloud' ? 'Unsaved changes' : 'Autosaved in this browser' }));
        } else if (source === 'cloud') {
            meta.appendChild(h('span', { text: 'Saved to cloud' }));
        } else {
            meta.appendChild(h('span', { text: 'Autosaved in this browser' }));
        }
        head.appendChild(meta);
        content.appendChild(head);

        // ---- Actions
        const actions = h('div', { className: 'pm-actions' });
        const action = (iconName, label, hint, onClick) => {
            const b = h('button', { className: 'pt-menu-item', role: 'menuitem' });
            b.innerHTML = `${icon(iconName)}<span class="pt-menu-item-label"></span>${hint ? '<span class="pt-menu-item-hint"></span>' : ''}`;
            b.querySelector('.pt-menu-item-label').textContent = label;
            if (hint) b.querySelector('.pt-menu-item-hint').textContent = hint;
            b.addEventListener('click', () => {
                menu?.close();
                onClick?.();
            });
            actions.appendChild(b);
        };
        action('filePlus', 'New project', '', onNewProject);
        action('folder', 'Open project file…', comboText(['Shift', 'Mod', 'O']), onLoadLocalClick);
        if (onBrowseDemos) action('gallery', 'Browse demos', '', onBrowseDemos);
        if (onBrowseCommunity && apiClient.isEnabled()) action('globe', 'Community projects', '', onBrowseCommunity);
        if (onBrowseProjects && apiClient.isLoggedIn()) action('cloud', 'My projects', '', onBrowseProjects);
        if (onShare && apiClient.isEnabled()) {
            const viewing = source === 'cloud' && projectState && !projectState.isOwner;
            action('link', viewing ? 'Copy link' : 'Share…', source === 'cloud' ? (viewing ? '' : ({ public: 'public', unlisted: 'link only', private: 'private' }[visibilityOf(projectState)])) : '', onShare);
        }
        if (onDownload) action('download', 'Download as .json', '', onDownload);
        content.appendChild(actions);

        // ---- Cloud projects (the full list lives in the project browser: onBrowseProjects)
        const cloud = h('div', { className: 'pm-cloud' });
        if (apiClient.isLoggedIn() && !onBrowseProjects) {
            const user = apiClient.getCurrentUser();
            const cloudHead = h('div', { className: 'pm-cloud-head' }, [
                h('span', { className: 'pt-label', text: 'Cloud projects' }),
                h('span', { className: 'pm-cloud-user', text: `@${user?.username || 'user'}` })
            ]);
            cloud.appendChild(cloudHead);

            const list = h('div', { className: 'pm-list', role: 'list' });
            for (let i = 0; i < 3; i++) list.appendChild(h('div', { className: 'pt-skeleton' }));
            cloud.appendChild(list);

            (async () => {
                try {
                    const result = await apiClient.listProjects();
                    const projects = (result.projects || []).slice().sort((a, b) =>
                        new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
                    list.innerHTML = '';

                    if (projects.length === 0) {
                        list.appendChild(h('div', { className: 'pm-empty', html: 'No cloud projects yet.<br>Save this one with <kbd>⌘S</kbd>.' }));
                        menu?.reposition();
                        return;
                    }

                    for (const project of projects) {
                        const isCurrent = currentProjectId === project.id;
                        const item = h('div', { className: `pm-item${isCurrent ? ' is-current' : ''}`, role: 'listitem', tabindex: '0' });
                        const t = thumbFor(project.name);
                        const thumb = h('div', { className: 'pm-item-thumb', text: t.letters });
                        thumb.style.color = t.color;
                        thumb.style.borderColor = `${t.color}55`;

                        const info = h('div', { className: 'pm-item-info' });
                        info.appendChild(h('div', { className: 'pm-item-name', text: project.name }));
                        const metaRow = h('div', { className: 'pm-item-meta' });
                        metaRow.appendChild(h('span', { text: relativeDate(project.updatedAt) }));
                        if (project.isPublic) metaRow.appendChild(h('span', { className: 'pt-badge', text: visibilityOf(project) === 'public' ? 'Public' : 'Link only' }));
                        if (isCurrent) metaRow.appendChild(h('span', { className: 'pt-badge', text: 'Open' }));
                        info.appendChild(metaRow);

                        const optBtn = h('button', { className: 'pt-icon-btn pt-icon-btn--sm', 'aria-label': 'Project options', html: icon('more') });
                        optBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            onShowProjectOptionsMenu?.(project, optBtn, item);
                        });

                        const open = async () => {
                            menu?.close();
                            if (onLoadCloudProject) await onLoadCloudProject(project.id);
                        };
                        item.addEventListener('click', open);
                        item.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter') open();
                        });

                        item.append(thumb, info, optBtn);
                        list.appendChild(item);
                    }
                    menu?.reposition();
                } catch (err) {
                    list.innerHTML = '';
                    list.appendChild(h('div', { className: 'pm-empty is-error', text: `Couldn’t load projects: ${err.message || 'network error'}` }));
                }
            })();
        } else if (!apiClient.isLoggedIn() && apiClient.isEnabled()) {
            const signin = h('div', { className: 'pm-signin' });
            signin.appendChild(h('span', { className: 'pt-label', text: 'Cloud projects' }));
            signin.appendChild(h('p', { text: 'Sign in to save projects to the cloud, open them anywhere and share them with a link.' }));
            const btn = UIHelpers.button('Sign in', { size: 'sm', icon: 'user' });
            btn.addEventListener('click', () => {
                menu?.close();
                onSignIn?.();
            });
            signin.appendChild(btn);
            cloud.appendChild(signin);
        }
        if (cloud.childElementCount) content.appendChild(cloud);

        menu = UIHelpers.openMenu({
            anchor,
            content,
            className: 'pt-project-menu',
            offset: 6
        });
        return menu;
    }

    /**
     * Options menu for a cloud project (download, duplicate, share, delete)
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
        anchorBtn.classList.add('is-active');
        return UIHelpers.openMenu({
            anchor: anchorBtn,
            align: 'end',
            className: 'project-options-menu',
            onClose: () => anchorBtn.classList.remove('is-active'),
            items: [
                {
                    icon: 'download', label: 'Download .json', onClick: async () => {
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
                            UIHelpers.notify(err.message, 'error', { title: 'Download failed' });
                        }
                    }
                },
                {
                    icon: 'copy', label: 'Duplicate', onClick: async () => {
                        try {
                            const fullProject = await apiClient.getProject(project.id);
                            const newName = `${project.name} (Copy)`;
                            await apiClient.saveProject(newName, fullProject.data);
                            UIHelpers.toast(`Duplicated as “${newName}”`, 'success');
                            onProjectDuplicated?.(newName);
                        } catch (err) {
                            UIHelpers.notify(err.message, 'error', { title: 'Duplicate failed' });
                        }
                    }
                },
                {
                    icon: 'link', label: project.isPublic ? 'Make private' : 'Share link…', onClick: async () => {
                        try {
                            // "Share link" = anyone with the link (unlisted), not published to Community
                            const newVisibility = !project.isPublic;
                            await apiClient.setProjectVisibility(project.id, newVisibility ? 'unlisted' : 'private');
                            project.isPublic = newVisibility;
                            project.visibility = newVisibility ? 'unlisted' : 'private';

                            if (newVisibility) {
                                ProjectDialogs.showShareDialog(project);
                            } else {
                                UIHelpers.toast(`“${project.name}” is now private`, 'success');
                            }
                        } catch (err) {
                            UIHelpers.notify(err.message, 'error', { title: 'Could not change visibility' });
                        }
                    }
                },
                { separator: true },
                {
                    icon: 'trash', label: 'Delete', danger: true, onClick: async () => {
                        const ok = await UIHelpers.confirm({
                            title: `Delete “${project.name}”?`,
                            message: 'This permanently removes the project from the cloud. This cannot be undone.',
                            confirmLabel: 'Delete project',
                            danger: true
                        });
                        if (!ok) return;
                        try {
                            await apiClient.deleteProject(project.id);
                            listItem?.remove();
                            UIHelpers.toast(`Deleted “${project.name}”`, 'success');
                            if (currentProjectId === project.id && onProjectDeleted) {
                                onProjectDeleted(project.id);
                            }
                        } catch (err) {
                            UIHelpers.notify(err.message, 'error', { title: 'Delete failed' });
                        }
                    }
                }
            ]
        });
    }

    static showShareDialog(project) {
        const shareUrl = `${window.location.origin}/p/${encodeURIComponent(project.id)}`;
        const m = UIHelpers.createModal({
            title: 'Share project',
            subtitle: `Anyone with this link can open “${project.name}”.`,
            className: 'pt-modal--wide'
        });
        const row = h('div', { className: 'pt-copy-row' });
        const input = h('input', { type: 'text', className: 'pt-input pt-input--mono', readOnly: true });
        input.value = shareUrl;
        const copyBtn = UIHelpers.button('Copy link', { variant: 'primary', icon: 'copy' });
        copyBtn.addEventListener('click', () => {
            navigator.clipboard?.writeText(shareUrl).then(() => {
                copyBtn.setLabel('Copied');
                setTimeout(() => copyBtn.setLabel('Copy link'), 1800);
            }, () => {
                input.select();
                UIHelpers.toast('Press ⌘C to copy the selected link', 'info');
            });
        });
        row.append(input, copyBtn);
        m.body.appendChild(row);
        m.body.style.paddingBottom = '20px';
        m.footer.appendChild(UIHelpers.button('Done', { onClick: () => m.close() }));
        setTimeout(() => input.select(), 0);
        return m;
    }

    /**
     * Options menu for the current project
     */
    static showCurrentProjectMenu({ anchorBtn, onDownload }) {
        return UIHelpers.openMenu({
            anchor: anchorBtn,
            align: 'end',
            className: 'current-project-menu',
            items: [
                { icon: 'download', label: 'Download as .json', onClick: () => onDownload?.() }
            ]
        });
    }

    /**
     * Dialog to save the project to the cloud
     */
    static showSaveProjectDialog({
        apiClient,
        projectTitle,
        currentProjectId,
        serializeGraph,
        onSaveSuccess
    }) {
        const m = UIHelpers.createModal({
            title: 'Save to cloud',
            subtitle: 'Give your patch a name. You can rename it any time.'
        });
        const name = UIHelpers.field({
            label: 'Project name',
            placeholder: 'My Awesome Shader',
            value: projectTitle || `Project ${new Date().toLocaleDateString()}`
        });
        m.body.appendChild(name.field);

        const cancelBtn = UIHelpers.button('Cancel', { variant: 'ghost', onClick: () => m.close() });
        const saveBtn = UIHelpers.button('Save', { variant: 'primary', icon: 'cloud' });
        m.footer.append(cancelBtn, saveBtn);

        saveBtn.addEventListener('click', async () => {
            const projectName = name.input.value.trim();
            if (!projectName) {
                m.setError('Project name is required.');
                return;
            }

            try {
                saveBtn.disabled = true;
                saveBtn.setLabel('Saving…');

                const graphData = serializeGraph ? serializeGraph() : {};
                const customNodes = collectCustomNodes(graphData);
                const projectData = {
                    version: '1.0',
                    graph: graphData,
                    customNodes: customNodes,
                    timestamp: new Date().toISOString()
                };

                let result;
                if (currentProjectId) {
                    result = await apiClient.updateProject(currentProjectId, { name: projectName, data: projectData });
                } else {
                    result = await apiClient.saveProject(projectName, projectData);
                }

                m.close();
                onSaveSuccess?.(result.id || currentProjectId, projectName);
                UIHelpers.toast(`Saved “${projectName}” to the cloud`, 'success');
            } catch (err) {
                m.setError(err.message || 'Failed to save project');
                saveBtn.disabled = false;
                saveBtn.setLabel('Save');
            }
        });

        name.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn.click();
        });

        setTimeout(() => name.input.select(), 0);
        return m;
    }
}
