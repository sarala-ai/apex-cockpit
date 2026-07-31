// Gateway — apex-gateway's GOVERNANCE surface: what's registered/callable
// (upstream gateways, tools, virtual servers), the A2A agent registry, and the
// audit ledger (who called what, was it allowed). Deliberately NOT Observe:
// this answers "what's governed", not "how healthy is it" — tool-call
// throughput/latency metrics live on Observe's Metrics & Alerts section instead.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ClipboardList, Loader2, Network, Plus } from "lucide-react";
import type { GatewayRegisterInput } from "@paperclipai/shared";
import { gatewayApi } from "@/api/gateway";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/apex/status-badge";

const TRANSPORTS: Array<{ value: GatewayRegisterInput["transport"]; label: string }> = [
  { value: "STREAMABLEHTTP", label: "Streamable HTTP" },
  { value: "SSE", label: "SSE" },
];

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function EnabledBadge({ enabled, reachable }: { enabled: boolean; reachable?: boolean }) {
  if (!enabled) return <Badge variant="default">disabled</Badge>;
  if (reachable === false) return <StatusBadge variant="danger">unreachable</StatusBadge>;
  return <StatusBadge variant="success">enabled</StatusBadge>;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function AddGatewayForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<GatewayRegisterInput["transport"]>("STREAMABLEHTTP");
  const [description, setDescription] = useState("");

  const register = useMutation({
    mutationFn: () =>
      gatewayApi.register({
        name: name.trim(),
        url: url.trim(),
        transport,
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["gateway", "registry"] });
      onDone();
    },
  });

  const errorMessage =
    register.error instanceof ApiError
      ? register.error.message
      : register.error
        ? "Failed to register the MCP server."
        : null;

  return (
    <form
      className="space-y-3 rounded-md border border-border px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        register.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="mcp-name">Name</Label>
          <Input
            id="mcp-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="penpot"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mcp-transport">Transport</Label>
          <Select value={transport} onValueChange={(value) => setTransport(value as GatewayRegisterInput["transport"])}>
            <SelectTrigger id="mcp-transport" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSPORTS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mcp-url">URL</Label>
        <Input
          id="mcp-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://penpot.example.com/mcp"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mcp-description">Description (optional)</Label>
        <Input
          id="mcp-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What this server exposes"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Registering federates this server's tools through apex-gateway — the same governed,
        audited path every other tool in the registry goes through, not a side channel.
      </p>
      {errorMessage && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{errorMessage}</p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={register.isPending || !name.trim() || !url.trim()}>
          {register.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Register
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={register.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function Gateway() {
  const [showAddForm, setShowAddForm] = useState(false);
  const registry = useQuery({
    queryKey: ["gateway", "registry"],
    queryFn: gatewayApi.registry,
    refetchInterval: 20_000,
  });
  const agents = useQuery({
    queryKey: ["gateway", "agents"],
    queryFn: gatewayApi.agents,
    refetchInterval: 20_000,
  });
  const audit = useQuery({
    queryKey: ["gateway", "audit"],
    queryFn: () => gatewayApi.audit(100),
    refetchInterval: 15_000,
  });

  const reg = registry.data;

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Gateway</h1>
        <p className="text-sm text-muted-foreground">
          What's registered and governed through apex-gateway — not a metrics dashboard;
          see Observe for gateway throughput/health.
        </p>
      </div>

      {reg?.error && (
        <Card>
          <CardContent className="py-3 text-xs text-rose-600 dark:text-rose-400">
            {reg.error}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="registry">
        <TabsList variant="line" className="justify-start">
          <TabsTrigger value="registry">Registry</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="registry" className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Upstream gateways, their tools, and virtual servers governed through apex-gateway.
            </p>
            {!showAddForm && (
              <Button size="sm" variant="outline" onClick={() => setShowAddForm(true)}>
                <Plus className="h-4 w-4" />
                Add MCP server
              </Button>
            )}
          </div>

          {showAddForm && <AddGatewayForm onDone={() => setShowAddForm(false)} />}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex-row items-center gap-2 space-y-0">
                <Network className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Gateways</CardTitle>
              </CardHeader>
              <CardContent>
                {registry.isLoading ? (
                  <EmptyNote>Loading…</EmptyNote>
                ) : (reg?.gateways ?? []).length === 0 ? (
                  <EmptyNote>No upstream gateways registered.</EmptyNote>
                ) : (
                  <ul className="space-y-1.5">
                    {(reg?.gateways ?? []).map((g) => (
                      <li key={g.id ?? g.name} className="flex items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate font-medium" title={g.name}>
                          {g.name}
                        </span>
                        <EnabledBadge enabled={g.enabled} reachable={g.reachable} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center gap-2 space-y-0">
                <ClipboardList className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Tools</CardTitle>
              </CardHeader>
              <CardContent>
                {registry.isLoading ? (
                  <EmptyNote>Loading…</EmptyNote>
                ) : (reg?.tools ?? []).length === 0 ? (
                  <EmptyNote>No tools registered.</EmptyNote>
                ) : (
                  <ul className="space-y-1.5">
                    {(reg?.tools ?? []).map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate font-medium" title={t.description ?? t.name}>
                          {t.name}
                        </span>
                        <EnabledBadge enabled={t.enabled} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center gap-2 space-y-0">
                <Network className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Virtual servers</CardTitle>
              </CardHeader>
              <CardContent>
                {registry.isLoading ? (
                  <EmptyNote>Loading…</EmptyNote>
                ) : (reg?.servers ?? []).length === 0 ? (
                  <EmptyNote>No virtual servers configured.</EmptyNote>
                ) : (
                  <ul className="space-y-1.5">
                    {(reg?.servers ?? []).map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate font-medium" title={s.description ?? s.name}>
                          {s.name}
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                          <span className="tabular-nums">{s.associatedToolCount} tools</span>
                          <EnabledBadge enabled={s.enabled} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="agents" className="mt-4">
          <Card>
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">A2A agent registry</CardTitle>
            </CardHeader>
            <CardContent>
              {agents.isLoading ? (
                <EmptyNote>Loading…</EmptyNote>
              ) : agents.isError ? (
                <p className="text-xs text-rose-600 dark:text-rose-400">Failed to load agents.</p>
              ) : (agents.data ?? []).length === 0 ? (
                <EmptyNote>No A2A agents registered.</EmptyNote>
              ) : (
                <ul className="space-y-1.5">
                  {(agents.data ?? []).map((a) => (
                    <li key={a.id ?? a.name} className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 flex-1">
                        <span className="truncate font-medium" title={a.description ?? a.name}>
                          {a.name}
                        </span>
                        {a.agentType && (
                          <span className="ml-2 text-muted-foreground">{a.agentType}</span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                        {a.protocolVersion && <span>{a.protocolVersion}</span>}
                        <EnabledBadge enabled={a.enabled} reachable={a.reachable} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <Card>
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Audit trail</CardTitle>
            </CardHeader>
            <CardContent>
              {audit.isLoading ? (
                <EmptyNote>Loading…</EmptyNote>
              ) : audit.isError ? (
                <p className="text-xs text-rose-600 dark:text-rose-400">Failed to load audit trail.</p>
              ) : (audit.data ?? []).length === 0 ? (
                <EmptyNote>No audit entries yet.</EmptyNote>
              ) : (
                <ul className="space-y-1.5">
                  {(audit.data ?? []).map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{e.action}</span>{" "}
                        <span className="text-muted-foreground">
                          {e.resourceType}
                          {e.resourceName ? `:${e.resourceName}` : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
                        <span className="truncate" title={e.userEmail ?? e.userId}>
                          {e.userEmail ?? e.userId}
                        </span>
                        <span className="tabular-nums">{relTime(e.timestamp)}</span>
                        <StatusBadge variant={e.success ? "success" : "danger"}>
                          {e.success ? "ok" : "denied"}
                        </StatusBadge>
                        {e.requiresReview && <Badge variant="default">review</Badge>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
