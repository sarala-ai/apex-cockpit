import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Tag,
  ChevronRight,
  Shield,
  Copy,
  BookOpen,
  Loader2,
} from "lucide-react";
import type {
  CompanyPromptListItem,
  CompanyPromptDetail,
  CompanyPromptVersion,
  CompanyPromptLabel,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { companyPromptsApi } from "../api/companyPrompts";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function formatDate(s: string) {
  return new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function LabelBadge({ label }: { label: CompanyPromptLabel }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        label.name === "prod"
          ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
          : "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      )}
    >
      {label.protected && <Shield className="h-2.5 w-2.5" />}
      {label.name} <span className="opacity-60">v{label.versionNumber}</span>
    </span>
  );
}

function VersionRow({
  version,
  labels,
  onSetLabel,
}: {
  version: CompanyPromptVersion;
  labels: CompanyPromptLabel[];
  onSetLabel: (versionId: string) => void;
}) {
  const versionLabels = labels.filter((l) => l.versionId === version.id);
  return (
    <div className="flex items-start justify-between gap-3 py-3 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium tabular-nums text-muted-foreground">v{version.revisionNumber}</span>
        <div className="min-w-0">
          {version.commitMessage && (
            <p className="text-sm truncate">{version.commitMessage}</p>
          )}
          <p className="text-xs text-muted-foreground">{formatDate(version.createdAt)}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {versionLabels.map((l) => (
          <LabelBadge key={l.id} label={l} />
        ))}
        <Button variant="ghost" size="sm" onClick={() => onSetLabel(version.id)}>
          <Tag className="h-3.5 w-3.5 mr-1" />
          Label
        </Button>
      </div>
    </div>
  );
}

function PromptDetail({
  companyId,
  promptId,
}: {
  companyId: string;
  promptId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [newVersionContent, setNewVersionContent] = useState("");
  const [newVersionMessage, setNewVersionMessage] = useState("");
  const [labelDialogVersionId, setLabelDialogVersionId] = useState<string | null>(null);
  const [labelName, setLabelName] = useState("");

  const { data: prompt, isLoading } = useQuery({
    queryKey: queryKeys.companyPrompts.detail(companyId, promptId),
    queryFn: () => companyPromptsApi.detail(companyId, promptId),
  });

  const publishVersion = useMutation({
    mutationFn: (payload: { content: string; commitMessage: string | null }) =>
      companyPromptsApi.createVersion(companyId, promptId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyPrompts.detail(companyId, promptId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companyPrompts.list(companyId) });
      setShowNewVersion(false);
      setNewVersionContent("");
      setNewVersionMessage("");
      pushToast({ title: "Version published", tone: "success" });
    },
    onError: () => pushToast({ title: "Failed to publish version", tone: "error" }),
  });

  const setLabel = useMutation({
    mutationFn: ({ versionId, name }: { versionId: string; name: string }) =>
      companyPromptsApi.setLabel(companyId, promptId, name, { versionId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyPrompts.detail(companyId, promptId) });
      setLabelDialogVersionId(null);
      setLabelName("");
      pushToast({ title: "Label updated", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: err.message ?? "Failed to set label", tone: "error" }),
  });

  if (isLoading) return <PageSkeleton />;
  if (!prompt) return <div className="p-6 text-muted-foreground">Prompt not found</div>;

  const currentVersion = prompt.versions?.[0];

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold truncate">{prompt.name}</h2>
          {prompt.description && (
            <p className="text-sm text-muted-foreground mt-0.5">{prompt.description}</p>
          )}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {(prompt.labels ?? []).map((l) => (
              <LabelBadge key={l.id} label={l} />
            ))}
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setNewVersionContent(currentVersion?.content ?? "");
            setShowNewVersion(true);
          }}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          New version
        </Button>
      </div>

      {/* Current content */}
      {currentVersion && (
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Current content — v{currentVersion.revisionNumber}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigator.clipboard.writeText(currentVersion.content)}
            >
              <Copy className="h-3.5 w-3.5 mr-1" />
              Copy
            </Button>
          </div>
          <pre className="rounded-md bg-muted p-3 text-sm font-mono whitespace-pre-wrap overflow-auto max-h-64">
            {currentVersion.content}
          </pre>
        </div>
      )}

      {/* Version history */}
      <div className="px-6 py-4 flex-1">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Version history ({prompt.versions?.length ?? 0})
        </h3>
        {(prompt.versions ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No versions yet</p>
        ) : (
          <div>
            {(prompt.versions ?? []).map((v) => (
              <VersionRow
                key={v.id}
                version={v}
                labels={prompt.labels ?? []}
                onSetLabel={(versionId) => {
                  setLabelDialogVersionId(versionId);
                  setLabelName("");
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* New version dialog */}
      <Dialog open={showNewVersion} onOpenChange={setShowNewVersion}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Publish new version</DialogTitle>
            <DialogDescription>
              Each version is immutable once published. Add a commit message to describe what changed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="version-content">Prompt content</Label>
              <Textarea
                id="version-content"
                className="mt-1.5 font-mono text-sm min-h-48"
                value={newVersionContent}
                onChange={(e) => setNewVersionContent(e.target.value)}
                placeholder="Enter your prompt template..."
              />
            </div>
            <div>
              <Label htmlFor="version-message">Commit message (optional)</Label>
              <Input
                id="version-message"
                className="mt-1.5"
                value={newVersionMessage}
                onChange={(e) => setNewVersionMessage(e.target.value)}
                placeholder="Describe what changed..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewVersion(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newVersionContent.trim() || publishVersion.isPending}
              onClick={() =>
                publishVersion.mutate({
                  content: newVersionContent,
                  commitMessage: newVersionMessage.trim() || null,
                })
              }
            >
              {publishVersion.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set label dialog */}
      <Dialog open={!!labelDialogVersionId} onOpenChange={(open) => !open && setLabelDialogVersionId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set deployment label</DialogTitle>
            <DialogDescription>
              Labels like <code>prod</code> and <code>staging</code> point to a specific version.
              Moving the <code>prod</code> label is a governance action.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="label-name">Label name</Label>
            <Input
              id="label-name"
              className="mt-1.5"
              value={labelName}
              onChange={(e) => setLabelName(e.target.value.toLowerCase())}
              placeholder="prod, staging, dev..."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLabelDialogVersionId(null)}>
              Cancel
            </Button>
            <Button
              disabled={!labelName.trim() || setLabel.isPending}
              onClick={() =>
                labelDialogVersionId &&
                setLabel.mutate({ versionId: labelDialogVersionId, name: labelName })
              }
            >
              {setLabel.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Set label
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreatePromptDialog({
  open,
  onOpenChange,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [commitMessage, setCommitMessage] = useState("");

  const create = useMutation({
    mutationFn: () =>
      companyPromptsApi.create(companyId, {
        name,
        description: description.trim() || null,
        content,
        commitMessage: commitMessage.trim() || null,
      }),
    onSuccess: (prompt) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyPrompts.list(companyId) });
      onOpenChange(false);
      setName("");
      setDescription("");
      setContent("");
      setCommitMessage("");
      pushToast({ title: "Prompt created", tone: "success" });
      navigate(`prompts/${prompt.id}`);
    },
    onError: () => pushToast({ title: "Failed to create prompt", tone: "error" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New prompt</DialogTitle>
          <DialogDescription>
            Create a versioned prompt template. Publish versions and promote to <code>prod</code> when
            ready.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="prompt-name">Name</Label>
              <Input
                id="prompt-name"
                className="mt-1.5"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Issue triage"
              />
            </div>
            <div>
              <Label htmlFor="prompt-description">Description (optional)</Label>
              <Input
                id="prompt-description"
                className="mt-1.5"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this prompt does"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="prompt-content">Initial content</Label>
            <Textarea
              id="prompt-content"
              className="mt-1.5 font-mono text-sm min-h-40"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Enter your prompt template..."
            />
          </div>
          <div>
            <Label htmlFor="prompt-commit-message">Commit message (optional)</Label>
            <Input
              id="prompt-commit-message"
              className="mt-1.5"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Initial version"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !content.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Create prompt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PromptLibrary() {
  const { selectedCompany } = useCompany();
  const { promptId } = useParams<{ promptId?: string }>();
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showCreate, setShowCreate] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const companyId = selectedCompany?.id ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Prompt Library" }]);
  }, [setBreadcrumbs]);

  const { data: prompts, isLoading } = useQuery({
    queryKey: queryKeys.companyPrompts.list(companyId),
    queryFn: () => companyPromptsApi.list(companyId),
    enabled: !!companyId,
  });

  const filtered = (prompts ?? []).filter(
    (p) =>
      !searchQuery ||
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description ?? "").toLowerCase().includes(searchQuery.toLowerCase()),
  );

  if (!selectedCompany) return null;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      <div className="w-72 flex-shrink-0 border-r border-border flex flex-col h-full">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">Prompt Library</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-3 py-2 border-b border-border">
          <Input
            placeholder="Search prompts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 text-sm"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <PageSkeleton />
          ) : filtered.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {prompts?.length === 0 ? "No prompts yet" : "No results"}
            </div>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                className={cn(
                  "w-full text-left px-4 py-3 border-b border-border/50 hover:bg-accent/50 transition-colors",
                  promptId === p.id && "bg-accent",
                )}
                onClick={() => navigate(p.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{p.name}</span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {p.hasProd && (
                      <span className="w-2 h-2 rounded-full bg-green-500" title="Has prod label" />
                    )}
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                </div>
                {p.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{p.description}</p>
                )}
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="text-xs text-muted-foreground">
                    {p.currentVersionNumber != null ? `v${p.currentVersionNumber}` : "no versions"}
                  </span>
                  {p.labelCount > 0 && (
                    <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                      <Tag className="h-2.5 w-2.5" />
                      {p.labelCount}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="px-4 py-3 border-t border-border">
          <Button size="sm" className="w-full" onClick={() => setShowCreate(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            New prompt
          </Button>
        </div>
      </div>

      {/* Main panel */}
      <div className="flex-1 overflow-hidden">
        {promptId ? (
          <PromptDetail companyId={companyId} promptId={promptId} />
        ) : (
          <EmptyState
            icon={BookOpen}
            title="Select a prompt"
            message="Choose a prompt from the list or create a new one. Use labels like prod and staging to promote versions without redeploying."
            action="New prompt"
            onAction={() => setShowCreate(true)}
          />
        )}
      </div>

      <CreatePromptDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        companyId={companyId}
      />
    </div>
  );
}
