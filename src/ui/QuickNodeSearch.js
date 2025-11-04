import { NodeDefinitions } from '../core/NodeDefinitions.js';
import { NodeFactory } from '../graph/NodeFactory.js';

/**
 * QuickNodeSearch - Handles the quick node search UI and ghost node placement
 * Extracted from NodeGraph to simplify the main class
 */
export class QuickNodeSearch {
    constructor(nodeGraph) {
        this.nodeGraph = nodeGraph;
        this.searchBox = null;
        this.ghostNode = null;
        this.infoPaneNode = null; // Track which node's info is shown
    }

    /**
     * Show the quick node search dialog
     */
    show(buttonElement) {
        // Don't open if already open
        if (this.searchBox) return;

        // Create search container
        const container = document.createElement('div');
        container.style.position = 'fixed';
        container.style.zIndex = '10000';
        container.style.background = '#2d2d2d';
        container.style.border = '1px solid #007acc';
        container.style.borderRadius = '4px';
        container.style.padding = '8px';
        container.style.width = '700px';
        container.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';

        // Position below button if provided, otherwise center
        if (buttonElement) {
            const rect = buttonElement.getBoundingClientRect();
            // Make sure it doesn't go off screen
            const leftPos = Math.min(rect.left, window.innerWidth - 700 - 20);
            container.style.left = leftPos + 'px';
            container.style.top = (rect.bottom + 4) + 'px';
        } else {
            container.style.left = '50%';
            container.style.top = '100px';
            container.style.marginLeft = '-350px'; // Half of 700px width
        }

        // Create search/button row
        const searchRow = document.createElement('div');
        searchRow.style.display = 'flex';
        searchRow.style.gap = '8px';
        searchRow.style.alignItems = 'center';

        // Create input
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Search nodes...';
        input.style.flex = '1';
        input.style.padding = '8px';
        input.style.background = '#1e1e1e';
        input.style.border = '1px solid #444';
        input.style.borderRadius = '3px';
        input.style.color = '#fff';
        input.style.fontSize = '14px';
        input.style.outline = 'none';

        // Create "+ Custom" button
        const customButton = document.createElement('button');
        customButton.textContent = '+ Custom';
        customButton.style.padding = '8px 12px';
        customButton.style.background = '#4caf50';
        customButton.style.border = 'none';
        customButton.style.borderRadius = '3px';
        customButton.style.color = '#fff';
        customButton.style.fontSize = '13px';
        customButton.style.fontWeight = 'bold';
        customButton.style.cursor = 'pointer';
        customButton.style.whiteSpace = 'nowrap';
        customButton.style.userSelect = 'none';

        customButton.addEventListener('mouseenter', () => {
            customButton.style.background = '#45a049';
        });

        customButton.addEventListener('mouseleave', () => {
            customButton.style.background = '#4caf50';
        });

        customButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.close();
            // Trigger the custom node dialog
            if (this.nodeGraph.onCustomNodeRequested) {
                this.nodeGraph.onCustomNodeRequested();
            }
        });

        searchRow.appendChild(input);
        searchRow.appendChild(customButton);

        // Create category tabs container (with wrapping)
        const tabsContainer = document.createElement('div');
        tabsContainer.style.display = 'flex';
        tabsContainer.style.flexWrap = 'wrap';
        tabsContainer.style.gap = '4px';
        tabsContainer.style.marginTop = '8px';
        tabsContainer.style.borderBottom = '1px solid #444';
        tabsContainer.style.paddingBottom = '4px';

        // Create main content area (results + info pane)
        const contentArea = document.createElement('div');
        contentArea.style.display = 'flex';
        contentArea.style.gap = '8px';
        contentArea.style.marginTop = '8px';
        contentArea.style.minHeight = '200px';

        // Create results list
        const resultsList = document.createElement('div');
        resultsList.style.flex = '1';
        resultsList.style.maxHeight = '400px';
        resultsList.style.overflowY = 'auto';

        // Create info pane (always visible, half the browser width)
        const infoPane = document.createElement('div');
        infoPane.style.flex = '1';
        infoPane.style.background = '#1e1e1e';
        infoPane.style.border = '1px solid #444';
        infoPane.style.borderRadius = '4px';
        infoPane.style.padding = '12px';
        infoPane.style.display = 'flex';
        infoPane.style.flexDirection = 'column';
        infoPane.style.gap = '12px';
        infoPane.style.maxHeight = '400px';
        infoPane.style.overflowY = 'auto';

        contentArea.appendChild(resultsList);
        contentArea.appendChild(infoPane);

        container.appendChild(searchRow);
        container.appendChild(tabsContainer);
        container.appendChild(contentArea);
        document.body.appendChild(container);

        this.searchBox = {
            container,
            input,
            customButton,
            tabsContainer,
            resultsList,
            infoPane,
            selectedIndex: 0,
            results: [],
            allNodes: {},
            activeCategory: 'all'
        };

        // Organize nodes by category
        Object.keys(NodeDefinitions).forEach(name => {
            const def = NodeDefinitions[name];
            const category = def.category || 'other';
            if (!this.searchBox.allNodes[category]) {
                this.searchBox.allNodes[category] = [];
            }
            this.searchBox.allNodes[category].push(name);
        });

        // Initial render with all nodes
        this.updateResults('');
        this.updateInfoPaneForSelection();

        // Handle input
        input.addEventListener('input', (e) => {
            const query = e.target.value;
            this.updateResults(query);

            // Hide/show custom button based on input
            if (query.trim().length > 0) {
                customButton.style.display = 'none';
            } else {
                customButton.style.display = '';
            }
        });

        // Handle keyboard
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.navigateDown();
                this.updateResults(input.value);
                this.updateInfoPaneForSelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateUp();
                this.updateResults(input.value);
                this.updateInfoPaneForSelection();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.selectCurrent();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });

        // Close on click outside
        const closeOnClickOutside = (e) => {
            if (!container.contains(e.target)) {
                this.close();
                document.removeEventListener('mousedown', closeOnClickOutside);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeOnClickOutside), 0);

        // Focus input
        input.focus();
    }

    navigateDown() {
        // Skip headers when navigating
        let newIndex = this.searchBox.selectedIndex + 1;
        while (newIndex < this.searchBox.results.length && this.searchBox.results[newIndex].isHeader) {
            newIndex++;
        }
        this.searchBox.selectedIndex = Math.min(newIndex, this.searchBox.results.length - 1);
    }

    navigateUp() {
        // Skip headers when navigating
        let newIndex = this.searchBox.selectedIndex - 1;
        while (newIndex >= 0 && this.searchBox.results[newIndex].isHeader) {
            newIndex--;
        }
        this.searchBox.selectedIndex = Math.max(newIndex, 0);
    }

    selectCurrent() {
        if (this.searchBox.results.length > 0) {
            const selectedItem = this.searchBox.results[this.searchBox.selectedIndex];
            if (selectedItem && !selectedItem.isHeader) {
                this.selectNode(selectedItem.name);
            }
        }
    }

    showInfoPane(nodeName) {
        const infoPane = this.searchBox.infoPane;
        infoPane.innerHTML = '';

        if (!nodeName) {
            // Show empty state
            const emptyText = document.createElement('div');
            emptyText.textContent = 'Select a node to view details';
            emptyText.style.color = '#666';
            emptyText.style.fontSize = '13px';
            emptyText.style.textAlign = 'center';
            emptyText.style.padding = '20px';
            infoPane.appendChild(emptyText);
            this.infoPaneNode = null;
            return;
        }

        const def = NodeDefinitions[nodeName];
        if (!def) return;

        this.infoPaneNode = nodeName;

        // Title with delete button for custom nodes
        const titleRow = document.createElement('div');
        titleRow.style.display = 'flex';
        titleRow.style.justifyContent = 'space-between';
        titleRow.style.alignItems = 'center';
        titleRow.style.gap = '8px';

        const title = document.createElement('div');
        title.textContent = def.displayTitle || nodeName;
        title.style.color = '#fff';
        title.style.fontSize = '16px';
        title.style.fontWeight = 'bold';
        titleRow.appendChild(title);

        // Add delete button for custom nodes
        if (def.isCustomNode) {
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.title = 'Delete custom node';
            deleteBtn.style.background = '#d32f2f';
            deleteBtn.style.border = 'none';
            deleteBtn.style.borderRadius = '3px';
            deleteBtn.style.color = '#fff';
            deleteBtn.style.fontSize = '12px';
            deleteBtn.style.padding = '4px 10px';
            deleteBtn.style.cursor = 'pointer';
            deleteBtn.style.transition = 'background 0.2s';
            deleteBtn.style.fontWeight = '500';

            deleteBtn.addEventListener('mouseenter', () => {
                deleteBtn.style.background = '#b71c1c';
            });

            deleteBtn.addEventListener('mouseleave', () => {
                deleteBtn.style.background = '#d32f2f';
            });

            deleteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Call the delete handler if available
                if (this.nodeGraph.onCustomNodeDelete) {
                    this.nodeGraph.onCustomNodeDelete(nodeName);
                }

                // Rebuild the node list to remove deleted node
                this.searchBox.allNodes = {};
                Object.keys(NodeDefinitions).forEach(name => {
                    const def = NodeDefinitions[name];
                    const category = def.category || 'other';
                    if (!this.searchBox.allNodes[category]) {
                        this.searchBox.allNodes[category] = [];
                    }
                    this.searchBox.allNodes[category].push(name);
                });

                // Clear the info pane and update results to remove the deleted node
                this.showInfoPane(null);
                const query = this.searchBox.input.value;
                this.updateResults(query);
            });

            titleRow.appendChild(deleteBtn);
        }

        infoPane.appendChild(titleRow);

        // Create and render actual node for preview (skip PreviewNodes to avoid WebGL context creation)
        const tempNode = !def.isPreviewNode ? this.createRealNode(nodeName) : null;
        if (tempNode) {
            // Calculate canvas dimensions with proper DPR
            const dpr = window.devicePixelRatio || 1;

            // Info pane is flex:1 in a 700px container with 8px gap and 16px total padding
            // So each half gets: (700 - 16 - 8) / 2 = 338px
            // Minus info pane's own padding: 338 - 24 = 314px available width
            const infoPaneWidth = 314;
            const padding = 20;
            const displayWidth = infoPaneWidth;

            // Center the node horizontally
            const nodeCenterX = (displayWidth - tempNode.width) / 2;
            tempNode.x = Math.max(padding, nodeCenterX);
            tempNode.y = padding;

            const canvasDisplayWidth = displayWidth;
            const canvasDisplayHeight = tempNode.height + padding * 2;

            // Canvas pixel dimensions (accounting for DPR)
            const canvasWidth = Math.floor(canvasDisplayWidth * dpr);
            const canvasHeight = Math.floor(canvasDisplayHeight * dpr);

            // Node preview canvas
            const previewCanvas = document.createElement('canvas');
            previewCanvas.width = canvasWidth;
            previewCanvas.height = canvasHeight;
            previewCanvas.style.width = canvasDisplayWidth + 'px';
            previewCanvas.style.height = canvasDisplayHeight + 'px';
            infoPane.appendChild(previewCanvas);

            // Render the node
            const ctx = previewCanvas.getContext('2d');
            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            tempNode.draw(ctx, { isSelected: false });
            ctx.restore();
        }

        // Description
        if (def.description) {
            const descSection = document.createElement('div');
            descSection.style.display = 'flex';
            descSection.style.flexDirection = 'column';
            descSection.style.gap = '4px';

            const descLabel = document.createElement('div');
            descLabel.textContent = 'Description';
            descLabel.style.color = '#888';
            descLabel.style.fontSize = '11px';
            descLabel.style.fontWeight = 'bold';
            descLabel.style.textTransform = 'uppercase';

            const descText = document.createElement('div');
            descText.textContent = def.description;
            descText.style.color = '#ccc';
            descText.style.fontSize = '12px';
            descText.style.lineHeight = '1.4';
            descText.style.whiteSpace = 'pre-wrap';

            descSection.appendChild(descLabel);
            descSection.appendChild(descText);
            infoPane.appendChild(descSection);
        }

        // Inputs/Outputs info
        if (def.inputs && def.inputs.length > 0) {
            const inputsSection = document.createElement('div');
            inputsSection.style.display = 'flex';
            inputsSection.style.flexDirection = 'column';
            inputsSection.style.gap = '4px';

            const inputsLabel = document.createElement('div');
            inputsLabel.textContent = 'Inputs';
            inputsLabel.style.color = '#888';
            inputsLabel.style.fontSize = '11px';
            inputsLabel.style.fontWeight = 'bold';
            inputsLabel.style.textTransform = 'uppercase';

            const inputsList = document.createElement('div');
            inputsList.style.color = '#ccc';
            inputsList.style.fontSize = '11px';
            inputsList.style.lineHeight = '1.4';

            def.inputs.forEach(input => {
                const inputItem = document.createElement('div');
                inputItem.textContent = `• ${input.name} (${input.type})`;
                inputsList.appendChild(inputItem);
            });

            inputsSection.appendChild(inputsLabel);
            inputsSection.appendChild(inputsList);
            infoPane.appendChild(inputsSection);
        }

        if (def.outputs && def.outputs.length > 0) {
            const outputsSection = document.createElement('div');
            outputsSection.style.display = 'flex';
            outputsSection.style.flexDirection = 'column';
            outputsSection.style.gap = '4px';

            const outputsLabel = document.createElement('div');
            outputsLabel.textContent = 'Outputs';
            outputsLabel.style.color = '#888';
            outputsLabel.style.fontSize = '11px';
            outputsLabel.style.fontWeight = 'bold';
            outputsLabel.style.textTransform = 'uppercase';

            const outputsList = document.createElement('div');
            outputsList.style.color = '#ccc';
            outputsList.style.fontSize = '11px';
            outputsList.style.lineHeight = '1.4';

            def.outputs.forEach(output => {
                const outputItem = document.createElement('div');
                outputItem.textContent = `• ${output.name || 'out'} (${output.type})`;
                outputsList.appendChild(outputItem);
            });

            outputsSection.appendChild(outputsLabel);
            outputsSection.appendChild(outputsList);
            infoPane.appendChild(outputsSection);
        }
    }

    updateInfoPaneForSelection() {
        // Update info pane based on current selection
        if (this.searchBox.results.length > 0) {
            const selectedItem = this.searchBox.results[this.searchBox.selectedIndex];
            if (selectedItem && !selectedItem.isHeader) {
                this.showInfoPane(selectedItem.name);
            } else {
                this.showInfoPane(null);
            }
        } else {
            this.showInfoPane(null);
        }
    }

    createRealNode(nodeType) {
        try {
            const def = NodeDefinitions[nodeType];
            if (!def) return null;

            // Create a real node instance using NodeFactory
            // We don't pass canvas/video for preview nodes - they'll handle it gracefully
            const node = NodeFactory.createNode(nodeType, 'preview', 0, 0, null, null, null);

            if (!node) return null;

            // Initialize default data if needed
            if (def.defaultData) {
                node.data = { ...def.defaultData };
            }

            return node;
        } catch (e) {
            console.error('Failed to create real node:', e);
            return null;
        }
    }

    updateResults(query) {
        const resultsList = this.searchBox.resultsList;
        const tabsContainer = this.searchBox.tabsContainer;
        resultsList.innerHTML = '';
        tabsContainer.innerHTML = '';

        const hasQuery = query.trim().length > 0;
        this.searchBox.results = [];

        if (hasQuery) {
            // Search mode: show tabs hidden, show results with category labels
            tabsContainer.style.display = 'none';

            const queryLower = query.toLowerCase();
            Object.keys(this.searchBox.allNodes).forEach(category => {
                const matchingNodes = this.searchBox.allNodes[category].filter(name =>
                    name.toLowerCase().includes(queryLower)
                );

                if (matchingNodes.length > 0) {
                    // Add category header
                    this.searchBox.results.push({ isHeader: true, category });
                    matchingNodes.forEach(name => {
                        this.searchBox.results.push({ isHeader: false, name, category });
                    });
                }
            });
        } else {
            // Category mode: show tabs, show nodes from active category
            tabsContainer.style.display = 'flex';

            // Create tabs
            const categories = ['all', ...Object.keys(this.searchBox.allNodes).sort()];
            categories.forEach(cat => {
                const tab = document.createElement('div');
                tab.textContent = cat;
                tab.style.padding = '4px 12px';
                tab.style.cursor = 'pointer';
                tab.style.fontSize = '11px';
                tab.style.textTransform = 'uppercase';
                tab.style.borderRadius = '3px';
                tab.style.color = this.searchBox.activeCategory === cat ? '#fff' : '#888';
                tab.style.background = this.searchBox.activeCategory === cat ? '#007acc' : 'transparent';
                tab.style.userSelect = 'none';

                tab.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.searchBox.activeCategory = cat;
                    this.searchBox.selectedIndex = 0;
                    this.updateResults('');
                });

                tabsContainer.appendChild(tab);
            });

            // Show nodes from active category
            if (this.searchBox.activeCategory === 'all') {
                Object.keys(this.searchBox.allNodes).forEach(category => {
                    this.searchBox.results.push({ isHeader: true, category });
                    this.searchBox.allNodes[category].forEach(name => {
                        this.searchBox.results.push({ isHeader: false, name, category });
                    });
                });
            } else {
                const nodes = this.searchBox.allNodes[this.searchBox.activeCategory] || [];
                nodes.forEach(name => {
                    this.searchBox.results.push({ isHeader: false, name, category: this.searchBox.activeCategory });
                });
            }
        }

        // Ensure selectedIndex is on a non-header item
        if (this.searchBox.results.length > 0 && this.searchBox.results[this.searchBox.selectedIndex]?.isHeader) {
            for (let i = 0; i < this.searchBox.results.length; i++) {
                if (!this.searchBox.results[i].isHeader) {
                    this.searchBox.selectedIndex = i;
                    break;
                }
            }
        }

        // Render results
        this.searchBox.results.forEach((item, index) => {
            const elem = document.createElement('div');

            if (item.isHeader) {
                // Category header
                elem.textContent = item.category.toUpperCase();
                elem.style.padding = '6px 8px';
                elem.style.fontSize = '10px';
                elem.style.color = '#888';
                elem.style.fontWeight = 'bold';
                elem.style.marginTop = index > 0 ? '8px' : '0';
                elem.style.userSelect = 'none';
            } else {
                // Node item
                elem.style.padding = '6px 8px';
                elem.style.cursor = 'pointer';
                elem.style.borderRadius = '3px';

                if (index === this.searchBox.selectedIndex) {
                    elem.style.background = '#007acc';
                }

                const def = NodeDefinitions[item.name];
                const displayName = def?.displayTitle || item.name;

                elem.textContent = displayName;
                elem.style.color = '#fff';
                elem.style.fontSize = '13px';

                elem.addEventListener('mouseenter', () => {
                    this.searchBox.selectedIndex = index;
                    this.updateResults(query);
                    this.updateInfoPaneForSelection();
                });

                elem.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.selectNode(item.name);
                });
            }

            resultsList.appendChild(elem);
        });
    }

    selectNode(nodeType) {
        this.close();

        // Create ghost node at mouse position - delegate to nodeGraph
        this.nodeGraph.createGhostNode(nodeType);
    }

    close() {
        if (this.searchBox) {
            this.searchBox.container.remove();
            this.searchBox = null;
            this.infoPaneNode = null;
        }
    }

    /**
     * Ghost node management
     */
    hasGhostNode() {
        return this.ghostNode !== null;
    }

    getGhostNode() {
        return this.ghostNode;
    }

    setGhostNode(node) {
        this.ghostNode = node;
    }

    placeGhostNode() {
        if (this.ghostNode) {
            const node = this.ghostNode;
            this.nodeGraph.nodes.push(node);
            this.ghostNode = null;

            // Auto-pair ForLoopStart with ForLoopEnd
            if (node.isForLoopStartNode) {
                // Create paired ForLoopEnd node to the right
                const pairX = node.x + 300;
                const pairY = node.y;
                const pairNode = this.nodeGraph.addNode('ForLoopEnd', pairX, pairY);

                if (pairNode) {
                    // Copy varTypes for initial creation
                    pairNode.data.varTypes = [...node.data.varTypes];

                    // Link them together
                    node.data.pairNodeId = pairNode.id;
                    pairNode.data.pairNodeId = node.id;

                    // Update pair's ports
                    pairNode.updatePorts();
                }
            }

            if (this.nodeGraph.onGraphChanged) {
                this.nodeGraph.onGraphChanged();
            }
            this.nodeGraph.render();
            return true;
        }
        return false;
    }

    updateGhostNodePosition(x, y) {
        if (this.ghostNode) {
            this.ghostNode.x = x;
            this.ghostNode.y = y;
            return true;
        }
        return false;
    }

    cancelGhostNode() {
        this.ghostNode = null;
        this.nodeGraph.render();
    }

    drawGhostNode(ctx) {
        if (this.ghostNode) {
            ctx.save();
            ctx.globalAlpha = 0.5;
            this.ghostNode.draw(ctx, {
                isSelected: false
            });
            ctx.restore();
        }
    }
}
