import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type GateReviewDecision = "request_changes" | "reject";

const COPY: Record<
  GateReviewDecision,
  { title: string; description: string; placeholder: string; confirm: string; pending: string }
> = {
  // Why the reason is required is stated where it is asked, not buried in a
  // validation error: it is not paperwork, it IS the instruction the step
  // redoing the work receives.
  request_changes: {
    title: "Request changes",
    description:
      "The work goes back to the step that produced it and is redone. What you write here is delivered to that step verbatim — it is the instruction, so say what has to change.",
    placeholder: "What has to change, and how you will know it is right.",
    confirm: "Request changes",
    pending: "Requesting…",
  },
  reject: {
    title: "Reject this gate",
    description:
      "Rejecting stops the flow — it does not send the work back for another round. If you want it redone, request changes instead. Your reason is recorded on the decision ledger.",
    placeholder: "Why this work should not proceed.",
    confirm: "Reject",
    pending: "Rejecting…",
  },
};

/**
 * The reason a flow-gate reviewer must give for any non-approve decision.
 *
 * Mirrors what a pipeline review stage already enforces server-side
 * (`requireRejectReason` / `requireRequestChangesReason`): the server returns a
 * classified 400 on a blank note, and this dialog is how the founder is asked
 * rather than how the rule is enforced — the button stays disabled until there
 * is something to send, so the 400 is a backstop, never the normal path.
 */
export function GateReviewReasonDialog({
  open,
  decision,
  onOpenChange,
  onConfirm,
  isPending = false,
  error = null,
}: {
  open: boolean;
  decision: GateReviewDecision;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isPending?: boolean;
  error?: string | null;
}) {
  const [reason, setReason] = useState("");
  const copy = COPY[decision];

  // A fresh dialog starts empty: a reason typed for one decision must never
  // silently become the reason recorded for a different one.
  useEffect(() => {
    if (!open) setReason("");
  }, [open, decision]);

  const canSubmit = reason.trim().length > 0 && !isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="gate-review-reason-dialog">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={5}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={copy.placeholder}
          aria-label={`${copy.title} reason`}
          data-testid="gate-review-reason-input"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant={decision === "reject" ? "destructive" : "default"}
            onClick={() => onConfirm(reason.trim())}
            disabled={!canSubmit}
            data-testid="gate-review-reason-confirm"
          >
            {isPending ? copy.pending : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
