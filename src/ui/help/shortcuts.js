/**
 * The keyboard / mouse shortcut list shown by the cheat sheet (ShortcutSheet.js).
 *
 * The handlers live where they always did (NodeGraph.onKeyDown, AppShell.setupShortcuts,
 * NodeGroups.handleKey, ScenesSection.onKey, LibraryPanel, QuickNodeSearch, CommentNode,
 * FloatingCodeEditor, OutputWindow._onKey, HelpCenter). This is the one list that
 * documents them: when you add or change a shortcut there, update its entry here.
 * Every entry is exercised by the browser check in the onboarding report
 * (scratchpad help/verify-shortcuts.mjs); `check` names the handler it relies on.
 *
 * keys: array of alternatives; each alternative is an array of key caps.
 *   'Mod' renders as ⌘ on macOS and Ctrl elsewhere, 'Shift' as ⇧ / Shift, 'Alt' as ⌥ / Alt.
 * mouse: free text for pointer gestures (rendered in place of key caps).
 */

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

const CAPS = IS_MAC
    ? { Mod: '⌘', Shift: '⇧', Alt: '⌥', Backspace: '⌫', Delete: '⌦', Enter: '↩', Escape: 'Esc' }
    : { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Backspace: 'Backspace', Delete: 'Del', Enter: 'Enter', Escape: 'Esc' };

export function capLabel(k) {
    return CAPS[k] || k;
}

/** "⌘S" / "Ctrl+S" style text for tooltips and menus. */
export function comboText(combo) {
    const parts = combo.map(capLabel);
    return IS_MAC ? parts.join('') : parts.join('+');
}

export const SHORTCUT_AREAS = [
    { id: 'general', title: 'General' },
    { id: 'canvas', title: 'Canvas navigation' },
    { id: 'nodes', title: 'Nodes & selection' },
    { id: 'cables', title: 'Cables' },
    { id: 'groups', title: 'Groups' },
    { id: 'panels', title: 'Library, search & panels' },
    { id: 'scenes', title: 'Scenes, notes & code' },
    { id: 'output', title: 'Output window' },
];

export const SHORTCUTS = [
    // ---- General ----
    { id: 'add-node', area: 'general', keys: [['Tab']], label: 'Search and add a node', check: 'NodeGraph.onKeyDown Tab' },
    { id: 'save', area: 'general', keys: [['Mod', 'S']], label: 'Save to the cloud (works while typing)', check: 'AppShell.setupShortcuts' },
    { id: 'open', area: 'general', keys: [['Mod', 'O']], label: 'Open: My projects, Community and demos (the top bar Open panel)', check: 'AppShell.setupShortcuts' },
    { id: 'open-file', area: 'general', keys: [['Shift', 'Mod', 'O']], label: 'Import a project file (.json)', check: 'AppShell.setupShortcuts' },
    { id: 'undo', area: 'general', keys: [['Mod', 'Z']], label: 'Undo (outside text fields)', check: 'History._onKeyDown' },
    { id: 'redo', area: 'general', keys: IS_MAC ? [['Shift', 'Mod', 'Z']] : [['Shift', 'Mod', 'Z'], ['Mod', 'Y']], label: 'Redo', check: 'History._onKeyDown' },
    { id: 'library', area: 'general', keys: [['\\']], label: 'Show / hide the library', check: 'AppShell.setupShortcuts' },
    { id: 'library-search', area: 'general', keys: [['/']], label: 'Search the library', check: 'AppShell.setupShortcuts' },
    { id: 'params', area: 'general', keys: [['P']], label: 'Show / hide the Parameters panel', check: 'AppShell.setupShortcuts' },
    { id: 'cheatsheet', area: 'general', keys: [['?']], label: 'This shortcut list', check: 'HelpCenter' },
    { id: 'node-help', area: 'general', keys: [['F1']], label: 'Help for the selected node (or the library item under the mouse)', check: 'HelpCenter' },

    // ---- Canvas ----
    { id: 'pan', area: 'canvas', mouse: 'Scroll / two-finger drag', label: 'Pan', check: 'NodeGraph.onWheel' },
    { id: 'pan-middle', area: 'canvas', mouse: 'Middle-drag', label: 'Pan', check: 'NodeGraph.beginButtonNav' },
    { id: 'zoom', area: 'canvas', keys: [['Mod', 'Scroll']], mouse: 'or pinch', label: 'Zoom toward the cursor', check: 'NodeGraph.onWheel' },
    { id: 'zoom-thumb', area: 'canvas', mouse: 'Mouse back / forward', label: 'Zoom out / in (hold and drag to scrub)', check: 'NodeGraph.endButtonNav' },
    { id: 'zoom-reset', area: 'canvas', mouse: 'Click the zoom % (status bar)', label: 'Reset zoom to 100%', check: 'AppShell.resetZoom' },

    // ---- Nodes ----
    { id: 'select', area: 'nodes', mouse: 'Click · Shift-click', label: 'Select · add to the selection', check: 'NodeGraph.onMouseDown' },
    { id: 'box-select', area: 'nodes', mouse: 'Drag on empty canvas', label: 'Box select (Shift adds)', check: 'NodeGraph.onMouseDown' },
    { id: 'select-all', area: 'nodes', keys: [['Mod', 'A']], label: 'Select all', check: 'NodeGraph.onKeyDown' },
    { id: 'delete', area: 'nodes', keys: [['Delete'], ['Backspace']], label: 'Delete the selection', check: 'NodeGraph.onKeyDown' },
    { id: 'copy', area: 'nodes', keys: [['Mod', 'C'], ['Mod', 'X']], label: 'Copy · cut', check: 'NodeGraph.onKeyDown' },
    { id: 'paste', area: 'nodes', keys: [['Mod', 'V']], label: 'Paste', check: 'NodeGraph.onKeyDown' },
    { id: 'deselect', area: 'nodes', keys: [['Escape']], label: 'Clear the selection · cancel a node being placed', check: 'NodeGraph.onKeyDown' },
    { id: 'edit-node', area: 'nodes', mouse: 'Double-click a node', label: 'Edit it: GLSL / JS code, color, note text; a Param opens in the panel', check: 'main.js onNodeRightClick' },
    { id: 'context', area: 'nodes', mouse: 'Right-click', label: 'Node / canvas menu (Help, group, duplicate…)', check: 'GroupUI.showContextMenu' },

    // ---- Cables ----
    { id: 'connect', area: 'cables', mouse: 'Drag output → input', label: 'Connect two ports', check: 'NodeGraph.handleAction' },
    { id: 'unplug', area: 'cables', mouse: 'Drag a connected input away', label: 'Unplug (or move) a cable', check: 'NodeGraph.handleInputPortClick' },
    { id: 'drop-preview', area: 'cables', mouse: 'Drop a cable on empty canvas', label: 'Add a Preview of that output', check: 'NodeGraph.onMouseUp' },
    { id: 'swizzle', area: 'cables', keys: [['x', 'y', 'z', 'w'], ['r', 'g', 'b', 'a']], mouse: 'while dragging', label: 'Type a swizzle or struct member for the cable', check: 'NodeGraph.handleSwizzleInput' },
    { id: 'swizzle-accept', area: 'cables', keys: [['Enter']], mouse: 'while dragging', label: 'Accept the suggested accessor (Backspace erases, Esc clears)', check: 'NodeGraph.onKeyDown' },

    // ---- Groups ----
    { id: 'group', area: 'groups', keys: [['Mod', 'G']], label: 'Group the selection', check: 'NodeGroups.handleKey' },
    { id: 'ungroup', area: 'groups', keys: [['Shift', 'Mod', 'G']], label: 'Ungroup', check: 'NodeGroups.handleKey' },
    { id: 'enter-group', area: 'groups', keys: [['Enter']], mouse: 'or double-click the box', label: 'Open the selected group', check: 'NodeGroups.handleKey' },
    { id: 'dive', area: 'groups', keys: [['Mod', 'Scroll']], mouse: 'into its preview', label: 'Zoom into a group box to dive in (out to leave)', check: 'NodeGroups.zoomGesture' },
    { id: 'exit-group', area: 'groups', keys: [['Escape'], ['Backspace']], mouse: 'or double-click empty space', label: 'Up one level (nothing selected)', check: 'NodeGraph.onKeyDown / onDoubleClick' },
    { id: 'rename-group', area: 'groups', mouse: 'Double-click the box title', label: 'Rename a group', check: 'NodeGroups.onDoubleClick' },

    // ---- Panels ----
    { id: 'lib-nav', area: 'panels', keys: [['↑'], ['↓'], ['Enter']], mouse: 'in the library', label: 'Move through results · add the node', check: 'LibraryPanel.bindEvents' },
    { id: 'lib-drag', area: 'panels', mouse: 'Drag a library item', label: 'Place the node exactly where you drop it', check: 'LibraryPanel.onDragEnd' },
    { id: 'qs-nav', area: 'panels', keys: [['↑'], ['↓'], ['Enter']], mouse: 'in Tab search', label: 'Pick a result · add it', check: 'QuickNodeSearch' },
    { id: 'qs-cat', area: 'panels', keys: [['Tab'], ['Shift', 'Tab']], mouse: 'empty Tab search', label: 'Cycle categories', check: 'QuickNodeSearch' },
    { id: 'close', area: 'panels', keys: [['Escape']], label: 'Close a menu, dialog, search or help panel', check: 'UIHelpers overlay stack' },
    { id: 'tap', area: 'panels', keys: [['Space'], ['Enter']], mouse: 'on the Tap button', label: 'Tap tempo', check: 'AudioPanel' },

    // ---- Scenes / notes / code ----
    { id: 'scenes', area: 'scenes', keys: [['1'], ['…'], ['9']], label: 'Switch scene (patches with a Scene Switcher)', check: 'ScenesSection.onKey' },
    { id: 'note-save', area: 'scenes', keys: [['Mod', 'Enter']], mouse: 'editing a note', label: 'Finish editing (Esc cancels)', check: 'CommentNode.beginEdit' },
    { id: 'code-save', area: 'scenes', keys: [['Mod', 'S']], mouse: 'in a code editor', label: 'Apply GLSL / JS code', check: 'FloatingCodeEditor' },

    // ---- Output window (keys go to the output window itself) ----
    { id: 'out-fs', area: 'output', keys: [['F']], mouse: 'or double-click', label: 'Fullscreen', check: 'OutputWindow._onKey' },
    { id: 'out-warp', area: 'output', keys: [['W']], label: 'Warp / calibration mode', check: 'OutputWindow._onKey' },
    { id: 'out-test', area: 'output', keys: [['T']], label: 'Cycle test patterns', check: 'OutputWindow._onKey' },
    { id: 'out-hud', area: 'output', keys: [['H'], ['?']], mouse: 'calibrating', label: 'Show / hide the calibration help', check: 'OutputWindow._onKey' },
    { id: 'out-modes', area: 'output', keys: [['G'], ['M'], ['B']], mouse: 'calibrating', label: 'Grid size · mask · edge blend', check: 'OutputWindow._onKey' },
    { id: 'out-points', area: 'output', keys: [['1'], ['…'], ['4'], ['Tab']], mouse: 'calibrating', label: 'Pick a corner · next point', check: 'OutputWindow._onKey' },
    { id: 'out-nudge', area: 'output', keys: [['←'], ['↑'], ['→'], ['↓']], mouse: 'calibrating', label: 'Nudge the point (⇧ fine, ⌥ coarse)', check: 'OutputWindow._onKey' },
    { id: 'out-reset', area: 'output', keys: [['R'], ['Shift', 'R']], mouse: 'calibrating', label: 'Reset the point · reset all', check: 'OutputWindow._onKey' },
    { id: 'out-esc', area: 'output', keys: [['Escape']], mouse: 'calibrating', label: 'Leave calibration', check: 'OutputWindow._onKey' },
];

export function shortcutsByArea() {
    return SHORTCUT_AREAS.map(a => ({ ...a, items: SHORTCUTS.filter(s => s.area === a.id) }))
        .filter(a => a.items.length);
}
