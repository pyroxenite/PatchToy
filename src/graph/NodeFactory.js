import { Node } from '../nodes/Node.js';
import { PreviewNode } from '../nodes/PreviewNode.js';
import { ConstantNode } from '../nodes/ConstantNode.js';
import { MapNode } from '../nodes/MapNode.js';
import { JSNode } from '../nodes/JSNode.js';
import { FeedbackNode } from '../nodes/FeedbackNode.js';
import { ForLoopStartNode } from '../nodes/ForLoopStartNode.js';
import { ForLoopEndNode } from '../nodes/ForLoopEndNode.js';
import { MicrophoneNode } from '../nodes/MicrophoneNode.js';
import { UVNode } from '../nodes/UVNode.js';
import { NodeDefinitions } from '../core/NodeDefinitions.js';

export class NodeFactory {
    static createNode(type, id, x, y, canvas, videoElement, sharedGL = null) {
        const definition = NodeDefinitions[type];
        if (!definition) {
            console.error(`Unknown node type: ${type}`);
            return null;
        }

        let node;

        if (definition.isPreviewNode) {
            node = new PreviewNode(id, type, x, y, canvas, videoElement, sharedGL);
        } else if (definition.isConstantNode) {
            node = new ConstantNode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.isMapNode) {
            node = new MapNode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.isJSNode) {
            node = new JSNode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.isFeedbackNode) {
            node = new FeedbackNode(id, type, x, y);
        } else if (definition.isForLoopStartNode) {
            node = new ForLoopStartNode(id, type, x, y);
        } else if (definition.isForLoopEndNode) {
            node = new ForLoopEndNode(id, type, x, y);
        } else if (definition.isMicrophoneNode) {
            node = new MicrophoneNode(id, type, x, y);
        } else if (type === 'UV') {
            node = new UVNode(id, type, x, y);
            node.updateDimensions();
        } else {
            node = new Node(id, type, x, y);
            node.updateDimensions();
        }

        return node;
    }

    static deserializeNode(json, canvas, videoElement, sharedGL = null) {
        const definition = NodeDefinitions[json.type];
        if (!definition) {
            console.error(`Unknown node type: ${json.type}`);
            return null;
        }

        let node;

        // Create appropriate node type
        if (definition.isPreviewNode) {
            node = new PreviewNode(json.id, json.type, json.x, json.y, canvas, videoElement, sharedGL);
            // Restore dimensions for preview nodes only
            if (json.width !== undefined) node.width = json.width;
            if (json.height !== undefined) node.height = json.height;
            if (json.isBackground !== undefined) node.isBackground = json.isBackground;
            // Resize framebuffer/canvas to match deserialized dimensions
            if (json.width !== undefined || json.height !== undefined) {
                node.resizeCanvas();
            }
        } else if (definition.isConstantNode) {
            node = new ConstantNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (definition.isMapNode) {
            node = new MapNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (definition.isJSNode) {
            node = new JSNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (definition.isFeedbackNode) {
            node = new FeedbackNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (definition.isForLoopStartNode) {
            node = new ForLoopStartNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (definition.isForLoopEndNode) {
            node = new ForLoopEndNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (definition.isMicrophoneNode) {
            node = new MicrophoneNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (json.type === 'UV') {
            node = new UVNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else {
            node = new Node(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        }

        // Restore data
        if (json.data) {
            node.data = { ...json.data };
            node.rebuildTextInputs();
        }

        return node;
    }
}
