# MIDI CC Node Implementation

## Overview

Added MIDI support to PatchToy with a MIDI CC (Control Change) node that outputs MIDI controller values as float uniforms with optional smoothing.

## Features

- **MIDI CC Input**: Read any MIDI CC value from any channel
- **Configurable Parameters**:
  - Channel: 1-16
  - CC Number: 0-127
  - Smoothing: 0.0-1.0 (first-order low-pass filter)
- **Real-time Updates**: Values update every frame in shaders
- **Multiple Devices**: Supports multiple MIDI input devices simultaneously

## Architecture

### 1. MIDIService (Singleton)
**File**: `src/services/MIDIService.js`

Manages Web MIDI API access and broadcasts CC changes to subscribers.

**Key Methods**:
- `enable()` - Request MIDI access from browser
- `getCC(channel, ccNumber)` - Get current CC value (normalized 0.0-1.0)
- `subscribe(nodeId, callback)` - Subscribe to CC updates
- `getDevices()` - List available MIDI devices

**Features**:
- Tracks all CC values in Map: `"channel_cc" → { value, normalized, timestamp }`
- Automatic device connect/disconnect handling
- Broadcasts to all subscribers on CC change

### 2. MidiCCNode
**File**: `src/nodes/MidiCCNode.js`

Node class that subscribes to MIDI service and provides smoothed output.

**Properties**:
- `data.channel` - MIDI channel (1-16)
- `data.ccNumber` - CC number (0-127)
- `data.smoothing` - Smoothing factor (0.0-1.0)
- `rawValue` - Direct from MIDI
- `smoothedValue` - After first-order filter

**Smoothing Algorithm**:
```javascript
smoothedValue = smoothedValue * smoothing + rawValue * (1.0 - smoothing)
```
- `smoothing = 0.0` → No smoothing (instant response)
- `smoothing = 0.99` → Heavy smoothing (slow, smooth response)

### 3. Node Definition
**File**: `src/core/NodeDefinitions.js` (lines 359-379)

```javascript
'MIDI CC': {
    category: 'input',
    inputs: [],
    outputs: [{ name: 'value', type: 'float' }],
    data: { channel: 1, ccNumber: 1, smoothing: 0.0 },
    hasInputFields: true,
    fieldType: 'float',
    isMidiCCNode: true,
    glsl: (node) => {
        return {
            code: `float ${node.varName} = ${node.varName}_value;`,
            output: node.varName,
            uniforms: [{
                name: `${node.varName}_value`,
                type: 'float',
                value: 0.0,
                midiCCNodeId: node.id
            }]
        };
    }
}
```

### 4. Uniform Injection
Similar to microphone nodes, MIDI CC nodes use a special uniform flag `midiCCNodeId` to identify uniforms that need per-frame updates.

**Files Modified**:
- `src/rendering/FeedbackRenderer.js`
  - Lines 160-169: Inject MIDI CC node reference during shader compilation
  - Lines 263, 277-280: Update uniform value each frame

- `src/rendering/ShaderPreview.js`
  - Lines 456-459: Update uniform value each frame during rendering

## Usage

### 1. Enable MIDI
Click the 🎹 button in the toolbar. This requests MIDI access and lists available devices.

### 2. Add MIDI CC Node
Add a "MIDI CC" node from the node menu (category: input).

### 3. Configure Node
The node has three editable text inputs:
- **CH** (channel): MIDI channel 1-16
- **CC** (ccNumber): CC number 0-127
- **SM** (smoothing): 0.0-1.0 (0 = no smoothing, higher = more smoothing)

**MIDI Learn (Easy Mode):**
Instead of manually typing channel and CC numbers, use MIDI Learn:
1. Click the "MIDI Learn" button at the bottom of the node
2. The button turns orange and displays "Learning..."
3. Move any control on your MIDI controller (twist knob, move fader, press button, etc.)
4. The node automatically detects and sets the channel and CC number
5. Learning mode disarms automatically
6. The text inputs update to show the learned values

This is especially useful when you have many MIDI CC nodes and want to quickly assign them to your controller!

### 4. Connect Output
Connect the float output to any shader parameter (e.g., colors, positions, scaling factors).

### 5. Send MIDI
Twist a knob or move a fader on your MIDI controller. The shader will update in real-time!

## Common MIDI CC Numbers

- **1**: Modulation Wheel
- **7**: Volume
- **10**: Pan
- **11**: Expression
- **64**: Sustain Pedal
- **71-74**: Filter controls (cutoff, resonance, attack, release)

Most MIDI controllers allow mapping any physical control to any CC number.

## Example Use Cases

1. **Color Control**:
   - MIDI CC 1 (Modulation) → Hue shift
   - MIDI CC 7 (Volume) → Brightness
   - MIDI CC 10 (Pan) → Saturation

2. **Animation**:
   - MIDI CC 71 → Rotation speed
   - MIDI CC 72 → Scale
   - MIDI CC 73 → Position X

3. **Effects**:
   - MIDI CC 74 → Feedback amount
   - MIDI CC 64 (Sustain) → Freeze frame toggle
   - MIDI CC 11 (Expression) → Blur amount

## Implementation Notes

### Smoothing
The smoothing uses an exponential moving average (first-order low-pass filter). This is computationally cheap and provides natural-feeling response.

Higher smoothing values create lag but eliminate jitter from MIDI controllers with noisy outputs.

### Performance
- MIDI service uses a single global instance
- Callbacks fire only when CC values change
- Frame-rate updates happen via direct `getValue()` calls (no polling)
- Minimal overhead even with many MIDI CC nodes

### Browser Compatibility
Web MIDI API is supported in:
- Chrome/Edge (full support)
- Firefox (partial, requires flag)
- Safari (not supported as of 2024)

## Files Created

1. `src/services/MIDIService.js` - MIDI service singleton
2. `src/nodes/MidiCCNode.js` - MIDI CC node class

## Files Modified

1. `src/core/NodeDefinitions.js` - Added MIDI CC node definition
2. `src/graph/NodeFactory.js` - Added MIDI CC node factory logic
3. `src/rendering/FeedbackRenderer.js` - MIDI uniform injection and updates
4. `src/rendering/ShaderPreview.js` - MIDI uniform updates
5. `index.html` - Added MIDI button
6. `src/ui/UIHelpers.js` - Added `enableMIDI()` helper
7. `main.js` - Added MIDI button click handler

## Future Enhancements

- [x] MIDI learn mode (click to auto-detect channel/CC from next MIDI message) ✅
- [ ] MIDI note input nodes
- [ ] MIDI clock sync for animations
- [ ] Per-node MIDI device selection (useful with multiple controllers)
- [ ] Value range mapping (e.g., map 0-127 to -1.0 to 1.0)
- [ ] Log scale mode for smoothing parameter
- [ ] Visual MIDI activity indicator on node
- [ ] Save/load MIDI mappings with project
