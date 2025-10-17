import { NodeDefinitions } from '../core/NodeDefinitions.js';

/**
 * QuickNodeSearch - Handles the quick node search UI and ghost node placement
 * Extracted from NodeGraph to simplify the main class
 */
export class QuickNodeSearch {
    constructor(nodeGraph) {
        this.nodeGraph = nodeGraph;
        this.searchBox = null;
        this.ghostNode = null;
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
        container.style.minWidth = '350px';
        container.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';

        // Position below button if provided, otherwise center
        if (buttonElement) {
            const rect = buttonElement.getBoundingClientRect();
            container.style.left = rect.left + 'px';
            container.style.top = (rect.bottom + 4) + 'px';
        } else {
            container.style.left = '50%';
            container.style.top = '100px';
            container.style.transform = 'translateX(-50%)';
        }

        // Create input
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Search nodes...';
        input.style.width = '100%';
        input.style.padding = '8px';
        input.style.background = '#1e1e1e';
        input.style.border = '1px solid #444';
        input.style.borderRadius = '3px';
        input.style.color = '#fff';
        input.style.fontSize = '14px';
        input.style.outline = 'none';

        // Create category tabs container
        const tabsContainer = document.createElement('div');
        tabsContainer.style.display = 'flex';
        tabsContainer.style.gap = '4px';
        tabsContainer.style.marginTop = '8px';
        tabsContainer.style.borderBottom = '1px solid #444';
        tabsContainer.style.paddingBottom = '4px';

        // Create results list
        const resultsList = document.createElement('div');
        resultsList.style.marginTop = '8px';
        resultsList.style.maxHeight = '300px';
        resultsList.style.overflowY = 'auto';

        container.appendChild(input);
        container.appendChild(tabsContainer);
        container.appendChild(resultsList);
        document.body.appendChild(container);

        this.searchBox = {
            container,
            input,
            tabsContainer,
            resultsList,
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

        // Handle input
        input.addEventListener('input', (e) => {
            this.updateResults(e.target.value);
        });

        // Handle keyboard
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.navigateDown();
                this.updateResults(input.value);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateUp();
                this.updateResults(input.value);
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
                elem.textContent = item.name;
                elem.style.padding = '6px 8px';
                elem.style.cursor = 'pointer';
                elem.style.color = '#fff';
                elem.style.fontSize = '13px';
                elem.style.borderRadius = '3px';

                if (index === this.searchBox.selectedIndex) {
                    elem.style.background = '#007acc';
                }

                elem.addEventListener('mouseenter', () => {
                    this.searchBox.selectedIndex = index;
                    this.updateResults(query);
                });

                elem.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.selectNode(item.name);
                });
            }

            resultsList.appendChild(elem);
        });

        // Add "Custom GLSL..." button at the bottom
        const customButton = document.createElement('div');
        customButton.textContent = 'Custom GLSL...';
        customButton.style.padding = '8px';
        customButton.style.cursor = 'pointer';
        customButton.style.color = '#4caf50';
        customButton.style.fontSize = '13px';
        customButton.style.textAlign = 'center';
        customButton.style.marginTop = '8px';
        customButton.style.borderTop = '1px solid #444';
        customButton.style.fontWeight = 'bold';
        customButton.style.userSelect = 'none';

        customButton.addEventListener('mouseenter', () => {
            customButton.style.background = '#007acc';
        });

        customButton.addEventListener('mouseleave', () => {
            customButton.style.background = 'transparent';
        });

        customButton.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.close();
            // Trigger the custom node dialog
            if (this.nodeGraph.onCustomNodeRequested) {
                this.nodeGraph.onCustomNodeRequested();
            }
        });

        resultsList.appendChild(customButton);
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
            this.nodeGraph.nodes.push(this.ghostNode);
            this.ghostNode = null;
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
