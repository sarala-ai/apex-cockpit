import { Building2, CheckCircle2, Cloud, Github, Plus, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/apex/status-badge';
import {
  api,
  type AuthStatus,
  type Company,
  type GcpOrg,
  type GcpProject,
  type GhOrg,
  type GhRepo,
  type Org,
} from '@/apex/api';

function AuthRow({ ok, label, who }: { ok: boolean; label: string; who: string | null }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
      ) : (
        <XCircle className="h-4 w-4 text-red-400" />
      )}
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{ok ? who : 'not authenticated'}</span>
    </div>
  );
}

export function SetupPane() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<GcpProject[]>([]);
  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // connect-org form
  const [connecting, setConnecting] = useState(false);
  const [gcpOrgs, setGcpOrgs] = useState<GcpOrg[]>([]);
  const [ghOrgs, setGhOrgs] = useState<GhOrg[]>([]);
  const [selGcpOrg, setSelGcpOrg] = useState('');
  const [selGhOrg, setSelGhOrg] = useState('');
  const [orgName, setOrgName] = useState('');

  // add-company form
  const [adding, setAdding] = useState(false);
  const [compName, setCompName] = useState('');
  const [selProjects, setSelProjects] = useState<Set<string>>(new Set());
  const [selRepos, setSelRepos] = useState<Set<string>>(new Set());

  const loadOrgContext = useCallback(async (o: Org) => {
    const [p, r, c] = await Promise.all([
      api.gcpProjects(),
      o.githubOrg ? api.githubRepos(o.githubOrg) : Promise.resolve({ repos: [] as GhRepo[] }),
      api.companies(o.id),
    ]);
    setProjects(p.projects);
    setRepos(r.repos);
    setCompanies(c.companies);
  }, []);

  const reload = useCallback(async () => {
    const [a, o] = await Promise.all([api.setupAuth(), api.orgs()]);
    setAuth(a);
    const first = o.orgs[0] ?? null;
    setOrg(first);
    if (first) await loadOrgContext(first);
  }, [loadOrgContext]);

  useEffect(() => {
    reload().catch((e) => setErr(String(e)));
  }, [reload]);

  async function startConnect() {
    setConnecting(true);
    setErr(null);
    const [g, h] = await Promise.all([api.gcpOrgs(), api.githubOrgs()]);
    setGcpOrgs(g.orgs);
    setGhOrgs(h.orgs);
    if (g.orgs[0]) {
      setSelGcpOrg(g.orgs[0].id);
      setOrgName(g.orgs[0].displayName.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()));
    }
    if (h.orgs[0]) setSelGhOrg(h.orgs[0].login);
  }

  async function connectOrg() {
    const g = gcpOrgs.find((o) => o.id === selGcpOrg);
    if (!orgName || !g) return;
    setBusy(true);
    try {
      const { org } = await api.createOrg({
        name: orgName,
        googleOrg: { id: g.id, displayName: g.displayName },
        githubOrg: selGhOrg || undefined,
      });
      setConnecting(false);
      setOrg(org);
      await loadOrgContext(org);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(set: Set<string>, key: string, apply: (s: Set<string>) => void) {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  }

  async function addCompany() {
    if (!org || !compName) return;
    setBusy(true);
    try {
      await api.createCompany({
        orgId: org.id,
        name: compName,
        gcpProjects: [...selProjects],
        githubRepos: [...selRepos],
      });
      setAdding(false);
      setCompName('');
      setSelProjects(new Set());
      setSelRepos(new Set());
      const c = await api.companies(org.id);
      setCompanies(c.companies);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full space-y-4 overflow-auto p-4">
      <div className="text-xs text-muted-foreground">
        One-time setup — connect this company's cloud + Git orgs, then define its products.
      </div>
      {err && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">{err}</div>}

      {/* Auth status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Provider &amp; auth · Google</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <AuthRow ok={!!auth?.google.authed} label="Google Cloud" who={auth?.google.account ?? null} />
          <AuthRow ok={!!auth?.github.authed} label="GitHub" who={auth?.github.user ?? null} />
        </CardContent>
      </Card>

      {/* Org */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-muted-foreground" /> Organization
          </CardTitle>
          {!org && !connecting && (
            <button onClick={startConnect} className="rounded border px-2 py-1 text-xs hover:bg-muted">
              Connect org
            </button>
          )}
        </CardHeader>
        <CardContent>
          {org ? (
            <div className="space-y-1 text-xs">
              <div className="text-sm font-medium">{org.name}</div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Cloud className="h-3.5 w-3.5" /> {org.googleOrg?.displayName} ({org.googleOrg?.id})
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Github className="h-3.5 w-3.5" /> {org.githubOrg ?? '—'}
              </div>
            </div>
          ) : connecting ? (
            <div className="space-y-2 text-xs">
              <label className="block">
                <span className="text-muted-foreground">Org name</span>
                <input value={orgName} onChange={(e) => setOrgName(e.target.value)} className="mt-0.5 w-full rounded border bg-background px-2 py-1" />
              </label>
              <label className="block">
                <span className="text-muted-foreground">Google org</span>
                <select value={selGcpOrg} onChange={(e) => setSelGcpOrg(e.target.value)} className="mt-0.5 w-full rounded border bg-background px-2 py-1">
                  {gcpOrgs.map((o) => <option key={o.id} value={o.id}>{o.displayName} ({o.id})</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-muted-foreground">GitHub org</span>
                <select value={selGhOrg} onChange={(e) => setSelGhOrg(e.target.value)} className="mt-0.5 w-full rounded border bg-background px-2 py-1">
                  {ghOrgs.map((o) => <option key={o.login} value={o.login}>{o.login}</option>)}
                </select>
              </label>
              <div className="flex gap-2">
                <button disabled={busy} onClick={connectOrg} className="rounded bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-500 disabled:opacity-50">Connect</button>
                <button onClick={() => setConnecting(false)} className="rounded border px-3 py-1">Cancel</button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No organization connected yet.</p>
          )}
        </CardContent>
      </Card>

      {/* Companies */}
      {org && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">Companies · products under {org.name}</CardTitle>
            {!adding && (
              <button onClick={() => setAdding(true)} className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted">
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {companies.length === 0 && !adding && (
              <p className="text-xs text-muted-foreground">No companies yet. Add FinPilot, Bloom, APEX…</p>
            )}
            <ul className="space-y-1.5">
              {companies.map((c) => (
                <li key={c.id} className="rounded border p-2 text-xs">
                  <div className="font-medium">{c.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.gcpProjects.map((p) => <StatusBadge key={p} variant="info">{p}</StatusBadge>)}
                    {c.githubRepos.map((r) => <Badge key={r} variant="default">{r.split('/').pop()}</Badge>)}
                  </div>
                </li>
              ))}
            </ul>

            {adding && (
              <div className="space-y-2 rounded border border-sky-500/30 bg-sky-500/5 p-2 text-xs">
                <input value={compName} onChange={(e) => setCompName(e.target.value)} placeholder="Company name (e.g. FinPilot)" className="w-full rounded border bg-background px-2 py-1" />
                <div>
                  <div className="mb-1 text-muted-foreground">GCP projects</div>
                  <div className="flex flex-wrap gap-1">
                    {projects.map((p) => (
                      <button key={p.projectId} onClick={() => toggle(selProjects, p.projectId, setSelProjects)}
                        className={`rounded border px-1.5 py-0.5 ${selProjects.has(p.projectId) ? 'border-sky-500/50 bg-sky-500/20 text-sky-200' : 'text-muted-foreground'}`}>
                        {p.projectId}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-muted-foreground">Repos</div>
                  <div className="flex flex-wrap gap-1">
                    {repos.map((r) => (
                      <button key={r.nameWithOwner} onClick={() => toggle(selRepos, r.nameWithOwner, setSelRepos)}
                        className={`rounded border px-1.5 py-0.5 ${selRepos.has(r.nameWithOwner) ? 'border-sky-500/50 bg-sky-500/20 text-sky-200' : 'text-muted-foreground'}`}>
                        {r.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button disabled={busy} onClick={addCompany} className="rounded bg-sky-600 px-3 py-1 font-medium text-white hover:bg-sky-500 disabled:opacity-50">Create</button>
                  <button onClick={() => setAdding(false)} className="rounded border px-3 py-1">Cancel</button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
