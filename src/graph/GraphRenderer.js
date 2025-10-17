export class GraphRenderer {
    constructor(canvas, ctx) {
        this.canvas = canvas;
        this.ctx = ctx;
    }

    render(state) {
        const { nodes, connections, selectedNodes, selectionBox, dragConnection, ghostNode, scale, offsetX, offsetY } = state;

        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;

        // Clear canvas
        ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

        // Apply transform
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);

        // Render connections
        this.renderConnections(connections);

        // Render drag connection (temporary)
        if (dragConnection) {
            this.renderDragConnection(dragConnection);
        }

        // Render nodes
        this.renderNodes(nodes, selectedNodes);

        // Render ghost node (being placed)
        if (ghostNode) {
            this.renderGhostNode(ghostNode);
        }

        ctx.restore();

        // Render selection box (in screen space)
        if (selectionBox) {
            this.renderSelectionBox(selectionBox);
        }
    }

    renderConnections(connections) {
        const ctx = this.ctx;

        for (const conn of connections) {
            const fromPos = conn.fromNode.getOutputPortPosition(conn.fromOutput);
            const toPos = conn.toNode.getInputPortPosition(conn.toInput);

            // Determine connection color based on type
            const outputDef = conn.fromNode.definition.outputs[conn.fromOutput];
            const color = this.getTypeColor(outputDef?.type);

            this.drawBezierCurve(fromPos, toPos, color);

            // Draw connection label (swizzle)
            const label = conn.getLabel();
            if (label) {
                const mid = conn.getMidpoint();
                this.drawConnectionLabel(mid.x, mid.y, label);
            }
        }
    }

    renderDragConnection(dragConnection) {
        const { fromPos, toPos } = dragConnection;
        this.drawBezierCurve(fromPos, toPos, '#888', true);
    }

    renderNodes(nodes, selectedNodes) {
        for (const node of nodes) {
            node.render(this.ctx, selectedNodes.has(node));
        }
    }

    renderGhostNode(ghostNode) {
        const ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha = 0.5;
        ghostNode.render(ctx, false);
        ctx.restore();
    }

    renderSelectionBox(box) {
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = '#007acc';
        ctx.fillStyle = 'rgba(0, 122, 204, 0.1)';
        ctx.lineWidth = 1;
        ctx.strokeRect(box.x, box.y, box.width, box.height);
        ctx.fillRect(box.x, box.y, box.width, box.height);
        ctx.restore();
    }

    drawBezierCurve(from, to, color = '#888', isDashed = false) {
        const ctx = this.ctx;

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;

        if (isDashed) {
            ctx.setLineDash([5, 5]);
        } else {
            ctx.setLineDash([]);
        }

        ctx.beginPath();
        ctx.moveTo(from.x, from.y);

        // Bezier control points
        const dx = Math.abs(to.x - from.x);
        const handleDistance = Math.min(dx * 0.5, 100);

        ctx.bezierCurveTo(
            from.x + handleDistance, from.y,
            to.x - handleDistance, to.y,
            to.x, to.y
        );

        ctx.stroke();

        // Draw port dots
        this.drawConnectionDot(from, color);
        this.drawConnectionDot(to, color);
    }

    drawConnectionDot(pos, color) {
        const ctx = this.ctx;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    drawConnectionLabel(x, y, text) {
        const ctx = this.ctx;

        ctx.save();
        ctx.font = '12px monospace';
        const metrics = ctx.measureText(text);
        const padding = 5;
        const width = metrics.width + padding * 2;
        const height = 18;

        // Background
        ctx.fillStyle = '#007acc';
        ctx.fillRect(x - width / 2, y - height / 2, width, height);

        // Text
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    getTypeColor(type) {
        const colorMap = {
            'float': '#4ec9b0',
            'vec2': '#9cdcfe',
            'vec3': '#c586c0',
            'vec4': '#ce9178',
            'sampler2D': '#dcdcaa',
            'bool': '#569cd6'
        };
        return colorMap[type] || '#888';
    }
}
