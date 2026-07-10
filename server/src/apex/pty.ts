import type { WebSocket } from '@fastify/websocket';
import * as pty from 'node-pty';
import { config } from './config.js';

/**
 * Client -> sidecar control messages, sent as JSON text frames.
 * Raw (non-JSON) text frames are treated as stdin for convenience.
 */
type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' };

/** Sidecar -> client frames. */
type ServerMessage =
  | { type: 'ready'; pid: number; shell: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number; signal?: number }
  | { type: 'error'; message: string };

const WS_OPEN = 1; // ws.readyState OPEN — stable numeric per the WS spec.
function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(msg));
}

/**
 * Bridge a WebSocket to a freshly-spawned PTY. The command is chosen from the
 * `?cmd=` query param (space-split, first token is the binary), defaulting to
 * the user's login shell. This is the load-bearing spine: spawn -> stream ->
 * input -> resize -> kill.
 */
export function attachPty(socket: WebSocket, query: Record<string, unknown>): void {
  const cmdParam = typeof query.cmd === 'string' && query.cmd.trim() ? query.cmd.trim() : '';
  const cols = Number(query.cols) || 80;
  const rows = Number(query.rows) || 24;

  const [file, ...args] = cmdParam ? cmdParam.split(/\s+/) : [config.defaultShell];

  let term: pty.IPty;
  try {
    term = pty.spawn(file, args, {
      name: 'xterm-color',
      cols,
      rows,
      cwd: process.env.HOME ?? process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });
  } catch (e) {
    send(socket, { type: 'error', message: `Failed to spawn "${file}": ${String(e)}` });
    socket.close();
    return;
  }

  send(socket, { type: 'ready', pid: term.pid, shell: file });

  const onData = term.onData((data) => send(socket, { type: 'output', data }));
  const onExit = term.onExit(({ exitCode, signal }) => {
    send(socket, { type: 'exit', code: exitCode, signal });
    socket.close();
  });

  socket.on('message', (raw: Buffer) => {
    const text = raw.toString();
    let msg: ClientMessage | null = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        msg = parsed as ClientMessage;
      }
    } catch {
      // Not JSON: treat the frame as raw stdin.
      term.write(text);
      return;
    }
    if (!msg) return;
    switch (msg.type) {
      case 'input':
        term.write(msg.data);
        break;
      case 'resize':
        if (msg.cols > 0 && msg.rows > 0) term.resize(msg.cols, msg.rows);
        break;
      case 'kill':
        term.kill();
        break;
    }
  });

  const cleanup = () => {
    onData.dispose();
    onExit.dispose();
    try {
      term.kill();
    } catch {
      /* already dead */
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}
