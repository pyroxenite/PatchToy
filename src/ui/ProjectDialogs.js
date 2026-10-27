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
     * Show the project popover under the project button: title, status and the actions
     * on the open project (opening / browsing other projects lives in the Open panel).
     * @param {Object} options
     * @param {ApiClient} options.apiClient
     * @param {string} options.projectTitle
     * @param {Object} [options.projectState] - ProjectManager.projectState (for meta line)
     * @param {Function} options.onProjectTitleChange - (newTitle)
     * @param {Function} options.onSave - save to the cloud (a copy when viewing someone else's project)
     * @param {Function} [options.onDuplicate] - save a cloud copy of the open project
     * @param {Function} [options.onShare] - share dialog for the open project
     * @param {Function} [options.onPublish] - publish to / unpublish from Community
     * @param {Function} options.onDownload - download as .json
     */
    static showProjectMenu({
        apiClient,
        projectTitle,
        projectState = null,
        onProjectTitleChange,
        onSave,
        onDuplicate,
        onShare,
        onPublish,
        onDownload
    }) {
        const anchor = document.getElementById('projectMenuBtn');
        const content = h('div', { className: 'pt-project-menu-inner', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } });
        let menu = null;

        // ---- Head: title
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
        titleRow.append(titleInput);
        head.appendChild(titleRow);

        // Meta line
        const meta = h('div', { className: 'pm-meta' });
        const source = projectState?.source || 'new';
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

        // ---- Actions on the open project
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
        const cloudOn = apiClient.isEnabled();
        const viewing = source === 'cloud' && projectState && !projectState.isOwner;
        const visibility = source === 'cloud' ? visibilityOf(projectState) : 'private';

        if (cloudOn) action(viewing ? 'fork' : 'cloud', viewing ? 'Save a copy' : 'Save', comboText(['Mod', 'S']), onSave);
        if (cloudOn && onDuplicate && !viewing) action('copy', 'Duplicate', '', onDuplicate);
        if (cloudOn && onShare) {
            action('link', viewing ? 'Copy link' : 'Share link…', viewing ? '' : ({ public: 'public', unlisted: 'link only', private: source === 'cloud' ? 'private' : '' }[visibility]), onShare);
        }
        if (cloudOn && onPublish && !viewing) {
            action('globe', visibility === 'public' ? 'Unpublish from Community' : 'Publish to Community', '', onPublish);
        }
        action('download', 'Download as .json', '', onDownload);
        content.appendChild(actions);

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
