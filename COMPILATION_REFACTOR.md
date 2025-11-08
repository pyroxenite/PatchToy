# Compilation System Refactor - In Progress

## Problem Statement

The compilation system had critical bugs related to node ID remapping and feedback loop rendering. This document tracks the refactoring effort to fix these issues.

## Original Issues

### 1. **Node ID Remapping Bug** (CRITICAL)
**Problem:** Each compilation pass created its own fresh `nodeIdRemap`, causing inconsistent variable names across shaders.

- Preview Node A compiles → Node 29 becomes `node_1`
- Preview Node B compiles → Node 29 becomes `node_3` (different!)
- Feedback Node compiles → Node 29 becomes `node_2` (also different!)
- Result: `findNodeByRemappedName()` fails, uniforms can't be looked up correctly

**Impact:** Uniforms from constant nodes couldn't be properly registered in UniformRegistry because the reverse lookup failed.

### 2. **Feedback Trails Not Working**
**Problem:** Feedback buffers initialized with opaque black (alpha=255) instead of transparent black (alpha=0).

**Impact:** Semi-transparent content couldn't accumulate properly - trails would show as solid fills.

### 3. **Code Duplication**
**Problem:** `compileFromOutputNode()` and `compileFromNodeAsOutput()` had ~60 lines of identical code.

**Impact:** Maintenance burden, risk of divergence.

## Steps Taken

### Step 1: Global Node ID Mapping System ✅

**Changed Files:**
- `src/managers/CompilationManager.js`
- `src/core/ShaderCompiler.js`
- `main.js`

**Changes:**
1. Added `createGlobalNodeIdMapping()` method to CompilationManager (lines 41-53)
   - Collects all node IDs and sorts them deterministically
   - Creates mapping once: `oldId → sequentialId`
   - Injects mapping into ShaderCompiler: `shaderCompiler.nodeIdRemap = this.globalNodeIdRemap`

2. Modified `main.js` onGraphChanged handler (line 347)
   - Calls `createGlobalNodeIdMapping()` BEFORE any compilation
   - Ensures feedback shaders and preview shaders use same mapping

3. Modified ShaderCompiler.reset() (lines 22-26)
   - Preserves injected `nodeIdRemap` instead of clearing it
   - Only initializes if not already set

4. Removed `renumberNodes()` calls from compilation functions
   - `compile()` (line 44)
   - `compileForPreviewNode()` (line 58)
   - `compileFromNodeAsOutput()` (line 65)

**Result:** All shaders in a compilation cycle now use consistent variable names.

### Step 2: Unify Duplicate Compilation Functions ✅

**Changed Files:**
- `src/core/ShaderCompiler.js`

**Changes:**
Rewrote `compileFromOutputNode()` (lines 137-175) to delegate to `compileFromNodeAsOutput()`:
```javascript
compileFromOutputNode(outputNode, nodeGraph) {
    const outputConnection = nodeGraph.connections.find(conn => conn.toNode === outputNode);

    if (!outputConnection) {
        // Return default magenta shader
    }

    // Delegate to unified compilation logic
    return this.compileFromNodeAsOutput(
        outputConnection.fromNode,
        outputConnection.fromOutput,
        nodeGraph
    );
}
```

**Result:** Single source of truth for compilation logic. Clean delegation chain:
`compileForPreviewNode` → `compileFromOutputNode` → `compileFromNodeAsOutput`

### Step 3: Fix Feedback Buffer Initialization ✅

**Changed Files:**
- `src/nodes/FeedbackNode.js`

**Changes:**
Line 58: Changed `pixels[i + 3] = 255` to `pixels[i + 3] = 0`

**Result:** Feedback buffers start transparent, allowing proper accumulation.

### Step 4: Deep Copy Uniform Values ✅

**Changed Files:**
- `src/core/ShaderCompiler.js`

**Changes:**
Lines 107-109: Added deep copy for array values
```javascript
uniform.value = Array.isArray(u.value) ? [...u.value] : u.value;
```

**Result:** Prevents shared references between uniform objects across compilations.

### Step 5: Suppress Noisy Warnings ✅

**Changed Files:**
- `src/rendering/ShaderPreview.js`

**Changes:**
Lines 475-478: Removed warning for missing uniforms (expected behavior)

**Result:** Cleaner console output.

## Current Status: ERRORS REMAIN

Despite the above fixes, there are still compilation errors. The user needs to document what errors are occurring.

### Known Issues to Investigate

1. **Uniform Mismatch Still Occurring?**
   - Need to verify if uniforms are being correctly isolated per shader
   - Check if `injectFeedbackTextures()` is causing cross-contamination

2. **Compilation Errors**
   - User reported "still some errors" but didn't specify
   - Need to capture exact error messages
   - Check browser console for shader compilation errors

3. **Feedback Trails Status**
   - Unknown if trails are visible after transparent buffer fix
   - May need higher feedback gain values (0.9-0.95 instead of 0.01)

## Architecture Overview

### Compilation Flow

```
User changes graph
    ↓
main.js: onGraphChanged()
    ↓
CompilationManager.createGlobalNodeIdMapping()  ← Creates mapping ONCE
    ↓
FeedbackRenderer.compileFeedbackShaders()       ← Uses global mapping
    ↓
CompilationManager.scheduleCompile()
    ↓
CompilationManager.compile()
    ↓
For each Preview Node:
    ShaderCompiler.compileForPreviewNode()      ← Uses global mapping
        ↓
    injectFeedbackTextures()
        ↓
    ShaderPreview.loadShader()
    ↓
UniformRegistry population (reverse lookup)
```

### Key Design Principles

1. **Global ID Mapping:** Created ONCE per compilation cycle, shared across ALL compilations
2. **Deterministic Sorting:** `nodeIds.sort((a, b) => a - b)` ensures consistent ordering
3. **Injection Pattern:** CompilationManager injects mapping into ShaderCompiler
4. **Preservation:** ShaderCompiler.reset() preserves injected mapping
5. **Unified Logic:** All compilation paths use `compileFromNodeAsOutput()` internally

## Next Steps (When Resuming)

1. **Capture Current Errors**
   - Check browser console
   - Look for shader compilation errors
   - Check for WebGL errors
   - Document exact error messages

2. **Debug Uniform System**
   - Add console.log to track which uniforms are in each shader's `uniformValues`
   - Verify `customUniformValues` is correctly set per shader
   - Check if `injectFeedbackTextures()` is modifying the wrong arrays

3. **Test Feedback Trails**
   - Verify feedback buffers are rendering
   - Check if transparent initialization fixed the issue
   - Try different feedback gain values (0.9, 0.95)
   - Examine compiled feedback shader GLSL

4. **Potential Additional Fixes**
   - May need to ensure `uniformValues` arrays are completely isolated
   - May need to clone shader objects before calling `injectFeedbackTextures()`
   - May need to track which uniforms belong to which shader more explicitly

## Files Modified

### Core System
- `src/managers/CompilationManager.js` - Global ID mapping, compilation orchestration
- `src/core/ShaderCompiler.js` - Unified compilation, preserve mapping in reset()
- `main.js` - Call createGlobalNodeIdMapping() before any compilation

### Rendering
- `src/nodes/FeedbackNode.js` - Transparent buffer initialization
- `src/rendering/ShaderPreview.js` - Suppress noisy warnings

## Testing Checklist (TODO)

- [ ] Verify node IDs are consistent across all shaders in one cycle
- [ ] Verify `findNodeByRemappedName()` works correctly
- [ ] Verify constant node uniforms update correctly
- [ ] Verify feedback loops render without errors
- [ ] Verify feedback trails accumulate (motion blur effect)
- [ ] Verify no shader compilation errors
- [ ] Verify no WebGL errors
- [ ] Test with multiple preview nodes
- [ ] Test with multiple feedback nodes
- [ ] Test with complex graphs (loops, branches)

## Related Documentation

- See `ARCHITECTURE.md` for overall system architecture
- See `TODO.md` for other pending work
- See previous conversation summary for polymorphic math nodes implementation
