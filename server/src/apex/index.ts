import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { config } from './config.js';
import { getApexRuns, getCiRuns, getTokens } from './observe.js';
import { createCoordinator } from './pipeline/coordinator-agent-sdk.js';
import { LifecycleEngine } from './pipeline/engine.js';
import { LocalRunner } from './pipeline/runner.js';
import { JsonWorkingStore } from './pipeline/store.js';
import { GitHubIssuesSource } from './pipeline/ticket-source.js';
import type { GateDecision, Ticket } from './pipeline/types.js';
import { attachPty } from './pty.js';
import {
  checkAuth,
  listGcpOrgs,
  listGcpProjects,
  listGithubOrgs,
  listGithubRepos,
} from './setup/cloud.js';
import { companyStore, orgStore, type Company, type Org } from './setup/company.js';

const app = Fastify({ logger: { level: 'info' } });

await app.register(websocket, {
  options: { maxPayload: 4 * 1024 * 1024 },
});

// Map a ticket's repo (owner/name) to its local monorepo checkout so coordinators
// can ground their drafts in the code. Undefined when no local checkout exists.
const reposRoot = process.env.APEX_TOWER_REPOS_ROOT ?? join(homedir(), 'Dev', 'repos', 'sarala_org');
const resolveCwd = (ticket: Ticket): string | undefined => {
  const name = ticket.repo.split('/').pop();
  if (!name) return undefined;
  const path = join(reposRoot, name);
  return existsSync(path) ? path : undefined;
};

// Ticket lifecycle engine (spec 002). Local-first singletons. Coordinator is the
// Claude Agent SDK bridge (uses local Claude Code auth — web login or API key);
// the stub is used only when APEX_TOWER_COORDINATOR=stub.
const source = new GitHubIssuesSource();
const { coordinator, kind: coordinatorKind } = createCoordinator({ resolveCwd });
const engine = new LifecycleEngine({
  source,
  store: new JsonWorkingStore(),
  runner: new LocalRunner(),
  coordinator,
});
app.log.info(`coordinator: ${coordinatorKind}`);

// --- Health -----------------------------------------------------------------
app.get('/health', async () => ({ ok: true, service: 'apex-tower-sidecar', version: '0.1.0' }));

// --- PTY (WebSocket) --------------------------------------------------------
// GET/WS /pty?cmd=<command>&cols=&rows=  — upgrade to a PTY stream.
app.get('/pty', { websocket: true }, (socket, req) => {
  attachPty(socket, (req.query ?? {}) as Record<string, unknown>);
});

// --- Observe: APEX runs -----------------------------------------------------
app.get('/observe/apex-runs', async () => {
  const res = await getApexRuns();
  return res.ok
    ? { runs: res.value, source: res.source }
    : { runs: [], source: res.source, note: res.message };
});

// --- Observe: CI runs -------------------------------------------------------
app.get('/observe/ci-runs', async (req) => {
  const repo = (req.query as { repo?: string })?.repo ?? '';
  const res = await getCiRuns(repo);
  return res.ok
    ? { runs: res.value, source: res.source }
    : { runs: [], source: res.source, note: res.message };
});

// --- Observe: tokens & cost -------------------------------------------------
app.get('/observe/tokens', async () => {
  const res = await getTokens();
  if (res.ok) {
    return { ...res.value, source: res.source, ...(res.hint ? { hint: res.hint } : {}) };
  }
  return {
    tokens: 0,
    costUsd: 0,
    series: [],
    source: res.source,
    note: res.message,
    ...(res.hint ? { hint: res.hint } : {}),
  };
});

// --- Pipeline: tickets & runs (spec 002) ------------------------------------

// List candidate tickets (open issues) for a repo.
app.get('/pipeline/tickets', async (req) => {
  const repo = (req.query as { repo?: string })?.repo ?? '';
  const res = await source.list(repo);
  return res.ok
    ? { tickets: res.value, source: res.source }
    : { tickets: [], source: res.source, note: res.message };
});

// Mirror a ticket into the store, starting a run at `ingested`.
app.post('/pipeline/ingest', async (req, reply) => {
  const { repo, number } = (req.body ?? {}) as { repo?: string; number?: number };
  if (!repo || typeof number !== 'number') {
    return reply.code(400).send({ error: 'body requires { repo, number }' });
  }
  const res = await engine.ingest(repo, number);
  return res.ok ? { run: res.value } : reply.code(502).send({ error: res.message });
});

// List / get runs.
app.get('/pipeline/runs', async () => ({ runs: await new JsonWorkingStore().list() }));
app.get('/pipeline/runs/:runId', async (req, reply) => {
  const { runId } = req.params as { runId: string };
  const run = await new JsonWorkingStore().get(runId);
  return run ? { run } : reply.code(404).send({ error: `no run ${runId}` });
});

// Apply a human decision at a gate.
app.post('/pipeline/decide', async (req, reply) => {
  const { runId, decision } = (req.body ?? {}) as { runId?: string; decision?: GateDecision };
  if (!runId || !decision) {
    return reply.code(400).send({ error: 'body requires { runId, decision }' });
  }
  const res = await engine.decide(runId, decision);
  return res.ok ? { run: res.value } : reply.code(409).send({ error: res.message });
});

// Advance the current working stage, streaming agent/execution output over WS.
// GET/WS /pipeline/step?runId=<id>
app.get('/pipeline/step', { websocket: true }, (socket, req) => {
  const runId = (req.query as { runId?: string })?.runId ?? '';
  if (!runId) {
    socket.send(JSON.stringify({ type: 'error', message: 'missing runId' }));
    socket.close();
    return;
  }
  const send = (chunk: string) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'data', chunk }));
  };
  engine
    .step(runId, send)
    .then((res) => {
      const msg = res.ok
        ? { type: 'done', run: res.value }
        : { type: 'error', message: res.message };
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    })
    .catch((e) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'error', message: String(e) }));
      }
    })
    .finally(() => socket.close());
});

// --- Company setup: auth + discovery (spec 003 draft) -----------------------

app.get('/setup/auth', async () => checkAuth());

app.get('/setup/gcp/projects', async () => {
  const r = await listGcpProjects();
  return r.ok ? { projects: r.value, source: r.source } : { projects: [], source: r.source, note: r.message };
});
app.get('/setup/gcp/orgs', async () => {
  const r = await listGcpOrgs();
  return r.ok ? { orgs: r.value, source: r.source } : { orgs: [], source: r.source, note: r.message };
});
app.get('/setup/github/orgs', async () => {
  const r = await listGithubOrgs();
  return r.ok ? { orgs: r.value, source: r.source } : { orgs: [], source: r.source, note: r.message };
});
app.get('/setup/github/repos', async (req) => {
  const org = (req.query as { org?: string })?.org ?? '';
  const r = await listGithubRepos(org);
  return r.ok ? { repos: r.value, source: r.source } : { repos: [], source: r.source, note: r.message };
});

// --- Orgs (the one-time provider-org linkage — Sarala) ----------------------
app.get('/orgs', async () => ({ orgs: await orgStore.list() }));
app.get('/orgs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const o = await orgStore.get(id);
  return o ? { org: o } : reply.code(404).send({ error: `no org ${id}` });
});
app.post('/orgs', async (req, reply) => {
  const b = (req.body ?? {}) as Partial<Org> & { name?: string };
  if (!b.name) return reply.code(400).send({ error: 'body requires { name }' });
  const org: Org = {
    id: randomUUID(),
    name: b.name,
    provider: 'google',
    googleOrg: b.googleOrg,
    githubOrg: b.githubOrg,
    createdAt: new Date().toISOString(),
  };
  await orgStore.put(org);
  return { org };
});

// --- Companies (products under an org — FinPilot/Bloom/APEX) -----------------
app.get('/companies', async (req) => {
  const orgId = (req.query as { orgId?: string })?.orgId;
  const all = await companyStore.list();
  return { companies: orgId ? all.filter((c) => c.orgId === orgId) : all };
});
app.get('/companies/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const c = await companyStore.get(id);
  return c ? { company: c } : reply.code(404).send({ error: `no company ${id}` });
});
app.post('/companies', async (req, reply) => {
  const b = (req.body ?? {}) as Partial<Company> & { orgId?: string; name?: string };
  if (!b.orgId || !b.name) return reply.code(400).send({ error: 'body requires { orgId, name }' });
  if (!(await orgStore.get(b.orgId))) return reply.code(400).send({ error: `unknown orgId ${b.orgId}` });
  const company: Company = {
    id: randomUUID(),
    orgId: b.orgId,
    name: b.name,
    gcpProjects: b.gcpProjects ?? [],
    githubRepos: b.githubRepos ?? [],
    createdAt: new Date().toISOString(),
  };
  await companyStore.put(company);
  return { company };
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`apex-tower sidecar on http://${config.host}:${config.port} (localhost only)`);
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
