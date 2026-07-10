import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { ptyUrl } from '@/lib/api';

type Status = 'connecting' | 'connected' | 'closed' | 'error';

/**
 * The load-bearing pane: an xterm.js terminal wired to the sidecar `/pty`
 * WebSocket. Proves spawn -> stream -> input -> resize -> kill end to end.
 */
export function TerminalPane() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [pid, setPid] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace',
      theme: { background: '#0a0f1a', foreground: '#e2e8f0' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const ws = new WebSocket(ptyUrl(term.cols, term.rows));

    const sendResize = () => {
      // Only fit once the host actually has a laid-out box, otherwise xterm's
      // renderer has no dimensions yet and syncScrollArea throws.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* renderer not ready yet — a later resize will retry */
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }),
        );
      }
    };

    // Defer the first fit past layout so the renderer has real dimensions.
    const raf = requestAnimationFrame(sendResize);

    ws.onopen = () => setStatus('connected');
    ws.onclose = () => setStatus('closed');
    ws.onerror = () => setStatus('error');
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      switch (msg.type) {
        case 'ready':
          setPid(msg.pid);
          sendResize();
          break;
        case 'output':
          term.write(msg.data);
          break;
        case 'exit':
          term.write(`\r\n\x1b[90m[process exited: code ${msg.code}]\x1b[0m\r\n`);
          break;
        case 'error':
          term.write(`\r\n\x1b[31m[sidecar error: ${msg.message}]\x1b[0m\r\n`);
          break;
      }
    };

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      onData.dispose();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'kill' }));
      }
      ws.close();
      term.dispose();
    };
  }, []);

  const dot =
    status === 'connected'
      ? 'bg-emerald-400'
      : status === 'connecting'
        ? 'bg-amber-400'
        : 'bg-red-400';

  return (
    <div className="flex h-full flex-col bg-[#0a0f1a]">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <span>PTY {status}</span>
        {pid !== null && <span className="text-muted-foreground/70">· pid {pid}</span>}
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 p-1" />
    </div>
  );
}
