import { CheckCircle2, ChevronRight, CircleDot, Pencil, Play, Ticket as TicketIcon, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/apex/status-badge';
import {
  api,
  stepUrl,
  type GateDecision,
  type Run,
  type Stage,
  type Task,
  type Ticket,
} from '@/apex/api';

// No hardcoded repo — the user selects/adds one via the UI (from the discovered
// GitHub org's repos). Empty until chosen.
const DEFAULT_REPO = '';

// The linear happy-path stages, for the timeline. `failed` is shown inline.
const STAGES: Stage[] = [
  'ingested',
  'specifying',
  'gate:spec_review',
  'planning',
  'gate:plan_review',
  'executing',
  'gate:pr_review',
  'done',
];

const isGate = (s: Stage) => s.startsWith('gate:');
const label = (s: Stage) => s.replace('gate:', '').replace(/_/g, ' ');

function taskVariant(s: Task['status']) {
  if (s === 'passed') return 'success' as const;
  if (s === 'failed') return 'danger' as const;
  if (s === 'running') return 'info' as const;
  return 'default' as const;
}

// --- Stage timeline ---------------------------------------------------------
function Timeline({ run }: { run: Run }) {
  const failed = run.stage === 'failed';
  const currentIdx = STAGES.indexOf(run.stage);
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]">
      {STAGES.map((s, i) => {
        const done = currentIdx > i && currentIdx !== -1;
        const current = run.stage === s;
        const cls = current
          ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
          : done
            ? 'bg-emerald-500/10 text-emerald-400/80 border-transparent'
            : 'bg-muted text-muted-foreground/60 border-transparent';
        return (
          <span key={s} className="flex items-center gap-1">
            <span className={`rounded border px-1.5 py-0.5 ${cls}`}>{label(s)}</span>
            {i < STAGES.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground/30" />}
          </span>
        );
      })}
      {failed && (
        <span className="ml-1 rounded border border-red-500/40 bg-red-500/20 px-1.5 py-0.5 text-red-300">
          failed
        </span>
      )}
    </div>
  );
}

// --- Gate action bar --------------------------------------------------------
function GateActions({
  run,
  onDecide,
  busy,
}: {
  run: Run;
  onDecide: (d: GateDecision) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');

  const artifact = run.stage === 'gate:spec_review' ? run.spec : run.stage === 'gate:plan_review' ? run.plan : undefined;

  if (!isGate(run.stage)) return null;

  return (
    <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
      <div className="mb-2 text-xs font-medium text-sky-300">
        HITL gate — {label(run.stage)}
      </div>
      {editing && artifact ? (
        <div className="space-y-2">
          <textarea
            className="h-40 w-full rounded border bg-background p-2 font-mono text-xs"
            defaultValue={artifact.body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => {
                onDecide({ kind: 'edit', body: body || artifact.body });
                setEditing(false);
              }}
              className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              Save edit
            </button>
            <button onClick={() => setEditing(false)} className="rounded border px-3 py-1 text-xs">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            disabled={busy}
            onClick={() => onDecide({ kind: 'approve' })}
            className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> Approve
          </button>
          {artifact && (
            <button
              disabled={busy}
              onClick={() => setEditing(true)}
              className="flex items-center gap-1 rounded border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          )}
          <div className="ml-auto flex items-center gap-1">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="reject reason"
              className="w-32 rounded border bg-background px-2 py-1 text-xs"
            />
            <button
              disabled={busy}
              onClick={() => onDecide({ kind: 'reject', reason: reason || 'rejected' })}
              className="flex items-center gap-1 rounded border border-red-500/40 px-3 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
            >
              <XCircle className="h-3.5 w-3.5" /> Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Artifact block ---------------------------------------------------------
function ArtifactBlock({ title, artifact }: { title: string; artifact?: Run['spec'] }) {
  if (!artifact) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium">
        {title}
        {artifact.tokens != null && (
          <span className="text-[10px] text-muted-foreground">
            {artifact.tokens.toLocaleString()} tok
            {artifact.costUsd != null && ` · $${artifact.costUsd.toFixed(3)}`}
          </span>
        )}
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border bg-background p-2 text-[11px] leading-relaxed">
        {artifact.body}
      </pre>
    </div>
  );
}

export function PipelinePane() {
  const [repo, setRepo] = useState(DEFAULT_REPO);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketsNote, setTicketsNote] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [streamLog, setStreamLog] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  const selected = runs.find((r) => r.runId === selectedId) ?? null;

  const reloadRuns = useCallback(async () => {
    const { runs } = await api.pipelineRuns();
    setRuns(runs);
  }, []);

  useEffect(() => {
    reloadRuns().catch(() => {});
  }, [reloadRuns]);

  const upsertRun = useCallback((run: Run) => {
    setRuns((prev) => {
      const i = prev.findIndex((r) => r.runId === run.runId);
      if (i === -1) return [run, ...prev];
      const next = [...prev];
      next[i] = run;
      return next;
    });
    setSelectedId(run.runId);
  }, []);

  async function loadTickets() {
    const res = await api.pipelineTickets(repo);
    setTickets(res.tickets);
    setTicketsNote(res.tickets.length === 0 ? (res.note ?? 'No open tickets.') : null);
  }

  async function ingest(t: Ticket) {
    setBusy(true);
    try {
      const { run } = await api.pipelineIngest(t.repo, t.number);
      upsertRun(run);
    } catch (e) {
      setStreamLog(`ingest failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function step(runId: string) {
    setStreaming(true);
    setStreamLog('');
    const ws = new WebSocket(stepUrl(runId));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === 'data') setStreamLog((s) => s + msg.chunk);
      else if (msg.type === 'done') upsertRun(msg.run as Run);
      else if (msg.type === 'error') setStreamLog((s) => s + `\n[error] ${msg.message}\n`);
    };
    ws.onerror = () => setStreamLog((s) => s + '\n[ws error]\n');
    ws.onclose = () => {
      setStreaming(false);
      reloadRuns().catch(() => {});
    };
  }

  async function decide(runId: string, decision: GateDecision) {
    setBusy(true);
    try {
      const { run } = await api.pipelineDecide(runId, decision);
      upsertRun(run);
    } catch (e) {
      setStreamLog(`decide failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [streamLog]);

  const canStep = selected && !streaming && !isGate(selected.stage) && selected.stage !== 'done' && selected.stage !== 'failed';

  return (
    <div className="grid h-full grid-cols-[280px_1fr] overflow-hidden">
      {/* Left: tickets + runs */}
      <div className="flex flex-col overflow-hidden border-r">
        <div className="border-b p-2">
          <div className="mb-1 flex gap-1">
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
              placeholder="owner/name"
            />
            <button onClick={loadTickets} className="shrink-0 rounded border px-2 py-1 text-xs hover:bg-muted">
              Load
            </button>
          </div>
          {ticketsNote && <p className="text-[10px] text-muted-foreground">{ticketsNote}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {tickets.length > 0 && (
            <div className="p-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">Open tickets</div>
              <ul className="space-y-1">
                {tickets.map((t) => (
                  <li key={t.id} className="flex items-start gap-1 text-xs">
                    <span className="min-w-0 flex-1 truncate" title={t.title}>
                      #{t.number} {t.title}
                    </span>
                    <button
                      disabled={busy}
                      onClick={() => ingest(t)}
                      className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50"
                    >
                      ingest
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">Runs</div>
            {runs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No runs yet. Ingest a ticket to start.</p>
            ) : (
              <ul className="space-y-1">
                {runs.map((r) => (
                  <li key={r.runId}>
                    <button
                      onClick={() => setSelectedId(r.runId)}
                      className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs ${
                        r.runId === selectedId ? 'bg-muted' : 'hover:bg-muted/50'
                      }`}
                    >
                      {r.stage === 'done' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      ) : r.stage === 'failed' ? (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                      ) : (
                        <CircleDot className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                      )}
                      <span className="min-w-0 flex-1 truncate" title={r.ticket.title}>
                        {r.ticket.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Right: selected run */}
      <div className="min-h-0 overflow-auto p-4">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <div className="text-center">
              <TicketIcon className="mx-auto mb-2 h-6 w-6 opacity-40" />
              Select or ingest a ticket to drive it through the gates.
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader className="space-y-2">
                <CardTitle className="flex items-center justify-between gap-2">
                  <a href={selected.ticket.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                    {selected.ticket.title}
                  </a>
                  <StatusBadge variant={selected.stage === 'failed' ? 'danger' : selected.stage === 'done' ? 'success' : 'info'}>
                    {label(selected.stage)}
                  </StatusBadge>
                </CardTitle>
                <Timeline run={selected} />
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <button
                    disabled={!canStep}
                    onClick={() => selected && step(selected.runId)}
                    className="flex items-center gap-1 rounded bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90 disabled:opacity-40"
                  >
                    <Play className="h-3.5 w-3.5" /> {streaming ? 'Running…' : 'Step'}
                  </button>
                  <span className="text-[11px] text-muted-foreground">
                    {isGate(selected.stage)
                      ? 'Waiting on your decision'
                      : selected.stage === 'done'
                        ? 'Complete'
                        : selected.stage === 'failed'
                          ? selected.failure?.message
                          : 'Ready to advance'}
                  </span>
                </div>

                <GateActions run={selected} onDecide={(d) => decide(selected.runId, d)} busy={busy} />

                {(streaming || streamLog) && (
                  <pre
                    ref={logRef}
                    className="max-h-56 overflow-auto whitespace-pre-wrap rounded border bg-[#0a0f1a] p-2 font-mono text-[11px] leading-relaxed text-slate-200"
                  >
                    {streamLog || '…'}
                  </pre>
                )}
              </CardContent>
            </Card>

            {(selected.spec || selected.plan) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Artifacts</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <ArtifactBlock title="Spec" artifact={selected.spec} />
                  <ArtifactBlock title="Plan" artifact={selected.plan} />
                </CardContent>
              </Card>
            )}

            {selected.tasks.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Tasks</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1.5">
                    {selected.tasks.map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate">
                          {t.title} <span className="text-muted-foreground/60">→ apex {t.workflow}</span>
                        </span>
                        <StatusBadge variant={taskVariant(t.status)}>{t.status}</StatusBadge>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {selected.gates.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Gate decisions</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1 text-[11px]">
                    {selected.gates.map((g, i) => (
                      <li key={i} className="flex items-center justify-between gap-2">
                        <span>{label(g.stage)}</span>
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <StatusBadge variant={g.decision.kind === 'reject' ? 'danger' : 'default'}>{g.decision.kind}</StatusBadge>
                          {new Date(g.at).toLocaleTimeString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
