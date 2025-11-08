import { Node } from '../nodes/Node.js';
import { PreviewNode } from '../nodes/PreviewNode.js';
import { ConstantNode } from '../nodes/ConstantNode.js';
import { ColorNode } from '../nodes/ColorNode.js';
import { MapNode } from '../nodes/MapNode.js';
import { JSNode } from '../nodes/JSNode.js';
import { FeedbackNode } from '../nodes/FeedbackNode.js';
import { ForLoopStartNode } from '../nodes/ForLoopStartNode.js';
import { ForLoopEndNode } from '../nodes/ForLoopEndNode.js';
import { MicrophoneNode } from '../nodes/MicrophoneNode.js';
import { MidiCCNode } from '../nodes/MidiCCNode.js';
import { CameraNode } from '../nodes/CameraNode.js';
import { ScreenCaptureNode } from '../nodes/ScreenCaptureNode.js';
import { VideoURLNode } from '../nodes/VideoURLNode.js';
import { UVNode } from '../nodes/UVNode.js';
import { OperatorNode } from '../nodes/OperatorNode.js';
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
        } else if (definition.isMidiCCNode) {
            node = new MidiCCNode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.isCameraNode) {
            node = new CameraNode(id, type, x, y);
        } else if (definition.isScreenCaptureNode) {
            node = new ScreenCaptureNode(id, type, x, y);
        } else if (definition.isVideoURLNode) {
            node = new VideoURLNode(id, type, x, y);
        } else if (type === 'Color') {
            node = new ColorNode(id, type, x, y);
        } else if (type === 'UV') {
            node = new UVNode(id, type, x, y);
            node.updateDimensions();
        } else if (type === 'Add') {
            node = new OperatorNode(id, type, x, y, '+');
        } else if (type === 'Subtract') {
            node = new OperatorNode(id, type, x, y, '-');
        } else if (type === 'Multiply') {
            node = new OperatorNode(id, type, x, y, '×');
        } else if (type === 'Divide') {
            node = new OperatorNode(id, type, x, y, '÷');
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
        } else if (definition.isMidiCCNode) {
            node = new MidiCCNode(json.id, json.type, json.x, json.y);
            // Restore saved values if available
            if (json.rawValue !== undefined) {
                node.rawValue = json.rawValue;
                console.log(`[NodeFactory] Restored rawValue for MIDI node ${json.id}: ${json.rawValue}`);
            }
            if (json.smoothedValue !== undefined) {
                node.smoothedValue = json.smoothedValue;
                console.log(`[NodeFactory] Restored smoothedValue for MIDI node ${json.id}: ${json.smoothedValue}`);
            }
            // Dimensions are recalculated, not restored
        } else if (definition.isCameraNode) {
            node = new CameraNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (definition.isScreenCaptureNode) {
            node = new ScreenCaptureNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (definition.isVideoURLNode) {
            node = new VideoURLNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (json.type === 'Color') {
            node = new ColorNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (json.type === 'UV') {
            node = new UVNode(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        } else if (json.type === 'Add') {
            node = new OperatorNode(json.id, json.type, json.x, json.y, '+');
        } else if (json.type === 'Subtract') {
            node = new OperatorNode(json.id, json.type, json.x, json.y, '-');
        } else if (json.type === 'Multiply') {
            node = new OperatorNode(json.id, json.type, json.x, json.y, '×');
        } else if (json.type === 'Divide') {
            node = new OperatorNode(json.id, json.type, json.x, json.y, '÷');
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
