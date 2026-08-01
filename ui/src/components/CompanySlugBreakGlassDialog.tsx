import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { OctagonAlert } from "lucide-react";
import type { CompanySlugBreakGlassConsequences } from "@paperclipai/shared";
import { COMPANY_SLUG_PATTERN } from "@paperclipai/shared";
import { companiesApi, type CompanySlugBreakGlassResult } from "@/api/companies";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

/**
 * Break-glass slug change dialog — the ONE deliberate, audited escape hatch out
 * of write-once slug immutability (see companyService.breakGlassChangeSlug).
 * Never a default action: the trigger sits behind a disclosure on the settings
 * page, this dialog restates the live consequences report before anything can
 * happen, and the confirm button stays disabled until the operator types the
 * CURRENT slug out by hand — proof of deliberateness, not a checkbox.
 */
export function CompanySlugBreakGlassDialog({
  companyId,
  currentSlug,
  open,
  onOpenChange,
}: {
  companyId: string;
  currentSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [newSlug, setNewSlug] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [consequences, setConsequences] = useState<CompanySlugBreakGlassConsequences | null>(null);
  const [result, setResult] = useState<CompanySlugBreakGlassResult | null>(null);

  useEffect(() => {
    if (!open) {
      setNewSlug("");
      setConfirmText("");
      setConsequences(null);
      setResult(null);
    }
  }, [open]);

  const normalizedNewSlug = newSlug.trim().toLowerCase();
  const newSlugValid = COMPANY_SLUG_PATTERN.test(normalizedNewSlug);
  const confirmMatches = confirmText.trim() === currentSlug;

  const previewMutation = useMutation({
    mutationFn: () => companiesApi.slugBreakGlassPreview(companyId, normalizedNewSlug),
    onSuccess: (data) => setConsequences(data.consequences),
  });

  const executeMutation = useMutation({
    mutationFn: () => companiesApi.slugBreakGlassExecute(companyId, normalizedNewSlug, confirmText.trim()),
    onSuccess: (data) => setResult(data),
  });

  const canPreview = newSlugValid && normalizedNewSlug !== currentSlug && !previewMutation.isPending;
  const canExecute =
    Boolean(consequences) && confirmMatches && normalizedNewSlug === consequences?.proposedSlug && !executeMutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (executeMutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="slug-break-glass-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <OctagonAlert className="h-4 w-4" aria-hidden />
            Break glass — force change slug
          </DialogTitle>
          <DialogDescription>
            This is the only way to change a company slug once it's set. It bypasses the normal
            write-once protection and can silently orphan capability paths, env vars, and any bound
            repo's committed config that key off the old slug. Use this only if you understand and
            will fix those consequences yourself.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
            <p className="font-medium text-foreground">
              Slug changed: <span className="font-mono">{currentSlug}</span> &rarr;{" "}
              <span className="font-mono">{result.company?.slug ?? normalizedNewSlug}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Recorded in the activity log
              {result.activityId ? (
                <>
                  {" "}
                  as <span className="font-mono">{result.activityId}</span>
                </>
              ) : null}
              . The consequences report above was snapshotted into that entry.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="slug-break-glass-new-slug">New slug</Label>
              <input
                id="slug-break-glass-new-slug"
                data-testid="slug-break-glass-new-slug"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                value={newSlug}
                placeholder={currentSlug}
                onChange={(event) => {
                  setNewSlug(event.target.value);
                  setConsequences(null);
                }}
              />
            </div>

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canPreview}
              data-testid="slug-break-glass-preview-button"
              onClick={() => previewMutation.mutate()}
            >
              {previewMutation.isPending ? "Loading consequences..." : "Preview consequences"}
            </Button>

            {previewMutation.isError && (
              <p className="text-xs text-destructive">
                {previewMutation.error instanceof Error
                  ? previewMutation.error.message
                  : "Failed to load consequences"}
              </p>
            )}

            {consequences && (
              <div
                className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs"
                data-testid="slug-break-glass-consequences"
              >
                <p className="font-medium text-destructive">{consequences.warning}</p>
                <div>
                  <p className="font-medium text-foreground">Env vars that change</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono">
                    {consequences.envVarsThatChange.map((ref) => (
                      <li key={ref.current}>
                        {ref.current} &rarr; {ref.next}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="font-medium text-foreground">Capability sync paths</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono">
                    {consequences.capabilitySyncTargets.map((ref) => (
                      <li key={ref.current}>
                        {ref.current} &rarr; {ref.next}
                      </li>
                    ))}
                  </ul>
                </div>
                {consequences.boundRepoConfigs.length > 0 && (
                  <div>
                    <p className="font-medium text-foreground">
                      Bound repos — this command does NOT update these; open a PR
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono">
                      {consequences.boundRepoConfigs.map((entry) => (
                        <li key={entry.repo}>{entry.repo}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {consequences && (
              <div className="space-y-1.5">
                <Label htmlFor="slug-break-glass-confirm">
                  Type the CURRENT slug (<span className="font-mono">{currentSlug}</span>) to confirm
                </Label>
                <input
                  id="slug-break-glass-confirm"
                  data-testid="slug-break-glass-confirm-input"
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder={currentSlug}
                />
              </div>
            )}

            {executeMutation.isError && (
              <p className="text-xs text-destructive">
                {executeMutation.error instanceof Error
                  ? executeMutation.error.message
                  : "Failed to change slug"}
              </p>
            )}
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              type="button"
              variant="destructive"
              disabled={!canExecute}
              data-testid="slug-break-glass-execute-button"
              onClick={() => executeMutation.mutate()}
            >
              {executeMutation.isPending ? "Changing..." : "Force change slug"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
