/**
 * MCP tools for the I/O bridge (OSC / serial / MIDI out / Art-Net; src/io,
 * mcp/lib/io-bridge.mjs). Added to the tool list by createTools (tools.mjs).
 *
 *   io_bridge  status of the app's I/O client and of every I/O node; for
 *              headless clients also pairing, per-session opt-in, allowlist,
 *              serial ports (the user's own tab is configured by the user only).
 */
import * as z from 'zod';

export function addIOTools(tools, s) {
    tools.push({
        name: 'io_bridge',
        title: 'I/O bridge (OSC / serial / MIDI / Art-Net)',
        description: "State of the app's I/O bridge client and I/O nodes (category 'io': OSCIn, OSCOut, SerialIn, SerialOut, MIDIOutCC, MIDIOutNote, ArtNetOut). The bridge is a separate local process (npm run io-bridge: WebSocket on 127.0.0.1, prints a pairing token). action 'status' (default): status (unpaired | probing | connecting | connected | down | auth-failed), opt_in, allow (allowed host:port destinations), serial_allow, requested (destinations nodes asked for but not allowed), osc_in ports, serial ports, counters, last in / out message, midi outputs and nodes [{id, type, state ok | wait | error | off, status, messages}]. 'list_serial' lists the serial ports the bridge sees. 'configure' {token, port, opt_in, allow:[\"127.0.0.1:9000\", \"host:7000-7010\", \"host:*\"], serial:[\"/dev/tty.usbmodem1101\"], lan} pairs and enables I/O, and 'unpair' forgets the token - both only on headless clients (auto-launched, no user): in the user's own tab pairing, permission and the allowlist are the user's decisions (ask them to use Output > I/O).",
        inputSchema: {
            action: z.enum(['status', 'configure', 'unpair', 'list_serial']).optional(),
            token: z.string().optional().describe('Pairing token printed by npm run io-bridge (configure)'),
            port: z.number().int().min(1).max(65535).optional().describe('Bridge WebSocket port (default 7879)'),
            opt_in: z.boolean().optional().describe('Enable I/O for this session (configure)'),
            allow: z.array(z.string()).optional().describe('Allowed destinations, replaces the list (configure)'),
            serial: z.array(z.string()).optional().describe('Allowed serial ports, replaces the list (configure)'),
            lan: z.boolean().optional().describe('OSC In listens on all interfaces instead of 127.0.0.1 (configure)'),
            wait_ms: z.number().int().min(0).max(15000).optional().describe('configure: wait up to this long for the connection (default 4000)'),
        },
        handler: async (args) => s.withClient(async (client) => ({ data: await s.call(client, 'ioBridge', args, 30000) })),
    });
    const listTypes = tools.find(t => t.name === 'list_node_types');
    if (listTypes) listTypes.description += " I/O nodes (category 'io': OSC In / Out, Serial In / Out, MIDI Out CC / Note, Art-Net Out) exchange control values with other apps and hardware through the local I/O bridge (npm run io-bridge) or Web MIDI; see io_bridge.";
    const getProject = tools.find(t => t.name === 'get_project');
    if (getProject) getProject.description += ' I/O nodes carry io {state ok | wait | error | off, status (connection state or last message), messages}; io summarizes the bridge link and opt-in.';
}
