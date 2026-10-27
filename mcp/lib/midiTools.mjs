/**
 * MCP tools for MIDI mappings (MIDI learn): midi_map, midi_unmap, simulate_midi.
 * Browser side: src/automation/midiAutomation.js, src/services/MidiMapper.js.
 * Added to the tool list by tools.mjs (addMidiTools).
 */
import * as z from 'zod';

const nodeId = z.union([z.number().int(), z.string()]);
const byte = z.number().int().min(0).max(255);

export function addMidiTools(tools, session) {
    const s = session;
    const call = (client, method, params, timeout) => s.call(client, method, params, timeout);

    const listParams = tools.find(t => t.name === 'list_params');
    if (listParams) listParams.description += " Mapped params carry midi: [{id, type (cc|note|pitchbend|aftertouch), number, note, channel, device, target, mode, pickup, picked_up, pickup_waiting, invert, min, max, slew, hires, feedback, label ('CC 21 · ch1')}] (see midi_map).";
    const listScenes = tools.find(t => t.name === 'list_scenes');
    if (listScenes) listScenes.description += ' Switchers with MIDI mappings carry midi: [{type, number, channel, target (scene | next | prev | select), option (scene index)}].';

    const options = z.object({
        target: z.string().optional().describe("What the control drives. vec2/3/4: 'x' | 'y' | 'z' | 'w' (one mapping per component); color: 'hue' (default) | 'sat' | 'bright' | 'r' | 'g' | 'b' | 'a'; enum: 'value' (CC buckets across the options) | 'option' (this note / button selects options.option) | 'step' (next option per press)"),
        option: z.number().int().optional().describe("enum target 'option': the option index"),
        mode: z.enum(['absolute', 'relative-2c', 'relative-64', 'relative-sb']).optional().describe("CC encoding: absolute knob/fader (default), or endless encoder: relative-2c (two's complement: 1 = +1, 127 = -1), relative-64 (64-centred: 65 = +1, 63 = -1), relative-sb (signed bit: 1 = +1, 65 = -1)"),
        pickup: z.boolean().optional().describe('Soft takeover (default true for absolute CCs): the value does not jump until the control passes through the current value'),
        invert: z.boolean().optional(),
        min: z.number().optional().describe("Range trim: the value at the control's minimum (default: the Param's min)"),
        max: z.number().optional().describe("Range trim: the value at the control's maximum (default: the Param's max)"),
        slew: z.number().min(0).max(30).optional().describe('Smoothing: seconds to glide to the control value (0 = immediate)'),
        press: z.enum(['toggle', 'momentary', 'velocity']).optional().describe("bool: 'toggle' (default for notes) | 'momentary' (default for CCs: on while >= 64 / held); float/int from a note: 'velocity' (default) | 'toggle' | 'momentary'"),
        hires: z.boolean().optional().describe('14-bit CC: number (0..31) = MSB, number + 32 = LSB'),
        sens: z.number().optional().describe('Relative encoders: 1 = 1/128 of the range per tick'),
        feedback: z.boolean().optional().describe('MIDI out: send the value back to the controller (LED rings / motor faders) when it changes'),
    }).partial();

    tools.push(
        {
            name: 'midi_map',
            title: 'Map MIDI control',
            description: "Map a MIDI controller onto a Param (as MIDI learn in the Parameters panel does), or onto a SceneSwitcher action. param = Param id or label; or scene_node = SceneSwitcher id with action 'scene' (+ scene: index or name; e.g. pad notes -> scenes) | 'next' | 'prev' | 'select' (a knob picks the scene by buckets). type: cc | note | pitchbend | aftertouch, number = CC number or note (60 or 'C3', C3 = 60), channel 1..16 (0 = any, default 1), device = input name ('' = any). Semantics: CC/bend/aftertouch -> float/int over min..max (log scale respected), soft takeover on by default for absolute CCs; note/CC -> bool (toggle or momentary) and trigger (pulse on note-on / CC >= 64); enum: CC buckets or one note per option; vec2: one mapping per component (target 'x' then 'y'); color: hue or one channel. A new mapping replaces the param's mapping with the same target unless add: true. learn: true arms MIDI learn instead (the next message, e.g. from simulate_midi, is mapped; vec / enum notes learn one control per component / option). Saved in the project (Param data.midi), matched by device name + channel so it survives reconnects. Creates an undo step when undo is available.",
            inputSchema: {
                param: z.union([z.number().int(), z.string()]).optional().describe('Param node id or label'),
                scene_node: nodeId.optional().describe('SceneSwitcher node id (instead of param)'),
                action: z.enum(['scene', 'next', 'prev', 'select']).optional().describe('SceneSwitcher mapping action'),
                scene: z.union([z.number().int(), z.string()]).optional().describe("action 'scene': scene index or name"),
                type: z.enum(['cc', 'note', 'pitchbend', 'aftertouch']).optional(),
                number: z.union([z.number().int().min(0).max(127), z.string()]).optional().describe("CC number, or note number / name ('C3' = 60)"),
                channel: z.number().int().min(0).max(16).optional().describe('MIDI channel 1..16, 0 = any (default 1)'),
                device: z.string().optional().describe("Input device name ('' = any device)"),
                options: options.optional(),
                add: z.boolean().optional().describe('Keep the existing mappings of the same target (e.g. two notes on one trigger)'),
                learn: z.boolean().optional().describe('Arm MIDI learn instead of mapping explicitly'),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'midiMap', args) }), { mutating: true }),
        },
        {
            name: 'midi_unmap',
            title: 'Remove MIDI mapping',
            description: "Remove MIDI mappings from a Param (param = id or label) or a SceneSwitcher (scene_node): all of them, or only those matching id ('m1'), type, number, channel, action / scene.",
            inputSchema: {
                param: z.union([z.number().int(), z.string()]).optional(),
                scene_node: nodeId.optional(),
                id: z.string().optional().describe("Mapping id (from list_params midi[].id)"),
                type: z.enum(['cc', 'note', 'pitchbend', 'aftertouch']).optional(),
                number: z.union([z.number().int(), z.string()]).optional(),
                channel: z.number().int().min(0).max(16).optional(),
                action: z.enum(['scene', 'next', 'prev', 'select']).optional(),
                scene: z.union([z.number().int(), z.string()]).optional(),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'midiUnmap', args) }), { mutating: true }),
        },
        {
            name: 'simulate_midi',
            title: 'Simulate MIDI input',
            description: 'Feed MIDI bytes into the app as if a controller sent them (headless browsers have no Web MIDI): reaches mappings, MIDI learn and the MIDI CC / Note nodes. status + data1 + data2 for one message, or messages [[status, data1, data2], ...] in order. Status = type + channel - 1: 176 (0xB0) CC, 144 (0x90) note on, 128 (0x80) note off, 224 (0xE0) pitch bend (data1 = LSB, data2 = MSB), 208 (0xD0) aftertouch. Returns effects [{node_id, mapping, value | pulse | scene | pickup: "waiting"}] and the touched nodes with their values and mappings. wait_ms waits before answering (smoothing).',
            inputSchema: {
                status: byte.optional(),
                data1: z.number().int().min(0).max(127).optional(),
                data2: z.number().int().min(0).max(127).optional(),
                messages: z.array(z.array(z.number().int().min(0).max(255)).min(1).max(3)).max(512).optional(),
                device: z.string().optional().describe('Device name the messages come from (default: none = matches any mapping)'),
                wait_ms: z.number().int().min(0).max(5000).optional(),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'simulateMidi', args, 20000) }), { mutating: true }),
        },
    );
    return tools;
}
