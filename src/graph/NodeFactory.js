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
import { LibraryNode } from '../nodes/LibraryNode.js';
import { OptionNode } from '../nodes/OptionNode.js';
import { ControlNode, SampleNode } from '../nodes/ControlNode.js';
import { IONode } from '../nodes/IONode.js';
import { AudioTextureNode } from '../nodes/AudioTextureNode.js';
import { KeyboardNode } from '../nodes/KeyboardNode.js';
import { CommentNode } from '../nodes/CommentNode.js';
import { XYPadNode } from '../nodes/XYPadNode.js';
import { MidiNoteNode } from '../nodes/MidiNoteNode.js';
import { ParamNode } from '../nodes/ParamNode.js';
import { SceneSwitcherNode, ScenePresenceNode } from '../nodes/SceneSwitcherNode.js';
import { probeNodeClass } from '../nodes/ProbeNode.js';
import { NodeDefinitions } from '../core/NodeDefinitions.js';
import { featureNodeClass } from '../render3d/registry.js'; // Render 3D node classes (src/render3d)

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
        } else if (featureNodeClass(definition)) {
            node = new (featureNodeClass(definition))(id, type, x, y);
            node.updateDimensions();
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
        } else if (definition.isCommentNode) {
            node = new CommentNode(id, type, x, y);
        } else if (definition.isKeyboardNode) {
            node = new KeyboardNode(id, type, x, y);
        } else if (definition.isXYPadNode) {
            node = new XYPadNode(id, type, x, y);
        } else if (definition.isMidiNoteNode) {
            node = new MidiNoteNode(id, type, x, y);
        } else if (definition.isParamNode) {
            node = new ParamNode(id, type, x, y);
        } else if (definition.isSceneSwitcher) {
            node = new SceneSwitcherNode(id, type, x, y);
        } else if (definition.isScenePresence) {
            node = new ScenePresenceNode(id, type, x, y);
        } else if (definition.isAudioTextureNode) {
            node = new AudioTextureNode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.isSampleNode) {
            node = new SampleNode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.isIONode) {
            node = new IONode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.rate === 'control' && !definition.isProbeNode) {
            node = new ControlNode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.isLibraryNode && definition.optionPills) {
            node = new OptionNode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.isLibraryNode) {
            node = new LibraryNode(id, type, x, y);
            node.updateDimensions();
        } else if (definition.isProbeNode) {
            node = new (probeNodeClass(definition))(id, type, x, y);
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
        } else if (featureNodeClass(definition)) {
            node = new (featureNodeClass(definition))(json.id, json.type, json.x, json.y);
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
            }
            if (json.smoothedValue !== undefined) {
                node.smoothedValue = json.smoothedValue;
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
        } else if (definition.isCommentNode) {
            node = new CommentNode(json.id, json.type, json.x, json.y);
        } else if (definition.isKeyboardNode) {
            node = new KeyboardNode(json.id, json.type, json.x, json.y);
        } else if (definition.isXYPadNode) {
            node = new XYPadNode(json.id, json.type, json.x, json.y);
        } else if (definition.isMidiNoteNode) {
            node = new MidiNoteNode(json.id, json.type, json.x, json.y);
        } else if (definition.isParamNode) {
            node = new ParamNode(json.id, json.type, json.x, json.y);
        } else if (definition.isSceneSwitcher) {
            node = new SceneSwitcherNode(json.id, json.type, json.x, json.y);
        } else if (definition.isScenePresence) {
            node = new ScenePresenceNode(json.id, json.type, json.x, json.y);
        } else if (definition.isAudioTextureNode) {
            node = new AudioTextureNode(json.id, json.type, json.x, json.y);
        } else if (definition.isSampleNode) {
            node = new SampleNode(json.id, json.type, json.x, json.y);
        } else if (definition.isIONode) {
            node = new IONode(json.id, json.type, json.x, json.y);
        } else if (definition.rate === 'control' && !definition.isProbeNode) {
            node = new ControlNode(json.id, json.type, json.x, json.y);
        } else if (definition.isLibraryNode && definition.optionPills) {
            node = new OptionNode(json.id, json.type, json.x, json.y);
        } else if (definition.isLibraryNode) {
            node = new LibraryNode(json.id, json.type, json.x, json.y);
        } else if (definition.isProbeNode) {
            node = new (probeNodeClass(definition))(json.id, json.type, json.x, json.y);
        } else {
            node = new Node(json.id, json.type, json.x, json.y);
            // Dimensions are recalculated, not restored
        }

        // Restore data
        if (json.data) {
            // Saved data from before an input rename (e.g. Grain amount -> intensity)
            const saved = typeof definition.migrateData === 'function' ? definition.migrateData(json.data) : json.data;
            // Library nodes: keep inline defaults for fields added after the project was saved
            node.data = definition.isLibraryNode
                ? { ...(definition.data || {}), ...saved }
                : { ...saved };
            node.rebuildTextInputs();
        }

        return node;
    }
}
