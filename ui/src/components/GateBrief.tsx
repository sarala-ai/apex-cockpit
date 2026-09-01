/**
 * What a person is actually deciding, on every surface that asks them.
 *
 * Founder critique this answers, verbatim: *"Why does the gate get a one-line
 * brief? Why isn't it able to summarize or hand content from the previous
 * task for review and approval in a humane fashion?"* A gate used to show the
 * `gate.prompt` its process was seeded with — "Gate 1: Promote — is it worth
 * doing. Seconds." — written before the ticket existed. Approving on a label
 * is how a gate hollows into ceremony.
 *
 * ONE module, deliberately. The ticket (`IssueLifecycle`), the item page's
 * review panel and the approvals page all render this. The failure mode it
 * exists to prevent is the one `ui/src/lib/step-hold.ts` was written for: a
 * decision that reads three different ways depending on where you found it.
 *
 * The WORDS come from the server (`server/src/apex/steps/gate-brief.ts`),
 * assembled from records with no model call anywhere on the path. This file
 * decides layout and emphasis, never wording — so a copy change happens once,
 * and the tests that guard the wording are the server's.
 *
 * Two things it never does:
 *  - render a blank section. An absent artifact is stated ("finished and left
 *    nothing to read"), because that is decision-relevant.
 *  - hide the artifact behind a summary. The excerpt IS the document, cut,
 *    and the whole thing is one click away.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowUpRight, FileText } from "lucide-react";
import { approvalsApi, type GateBriefLookAtItem, type PipelineGateBrief } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { ReviewPassChecklist } from "./ReviewPassChecklist";

/** Where the whole artifact lives. A document is an anchor on its ticket; a
 *  change lives outside the product entirely. Never invented — an item with
 *  neither simply has no link, and says its piece inline. */
export function gateBriefItemHref(item: GateBriefLookAtItem, ticketId: string | null): string | null {
  if (item.url) return item.url;
  if (item.anchor && ticketId) return `/issues/${ticketId}#document-${encodeURIComponent(item.anchor)}`;
  return null;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-(--tracking-eyebrow) opacity-70">{children}</p>
  );
}

function ArtifactLink({ item, ticketId }: { item: GateBriefLookAtItem; ticketId: string | null }) {
  const href = gateBriefItemHref(item, ticketId);
  if (!href) return null;
  const label = item.truncated ? `Read all of ${item.label}` : `Open ${item.label}`;
  if (item.url) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2"
      >
        {label}
        <ArrowUpRight className="h-3 w-3" aria-hidden />
      </a>
    );
  }
  return (
    <Link to={href} className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2">
      {label}
      <ArrowUpRight className="h-3 w-3" aria-hidden />
    </Link>
  );
}

function LookAtItem({ item, ticketId }: { item: GateBriefLookAtItem; ticketId: string | null }) {
  return (
    <div className="space-y-1.5" data-testid="gate-brief-artifact">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
          {item.label}
        </span>
        {item.meta ? <span className="text-xs opacity-70">{item.meta}</span> : null}
      </div>
      {item.excerpt ? (
        <>
          {/* The artifact itself, not a paraphrase of it. Pre-wrapped so a
              spec's headings and list still read as a spec. */}
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-current/15 bg-background/60 px-3 py-2 font-sans text-sm leading-6 text-foreground">
            {item.excerpt}
          </pre>
          {item.truncated ? (
            <p className="text-xs opacity-70" data-testid="gate-brief-truncated">
              This is the start of it, not all of it.
            </p>
          ) : null}
        </>
      ) : null}
      <ArtifactLink item={item} ticketId={ticketId} />
    </div>
  );
}

export function GateBriefBody({
  brief,
  acknowledgedReviewPasses,
  onAcknowledgedReviewPassesChange,
}: {
  brief: PipelineGateBrief;
  acknowledgedReviewPasses?: string[];
  onAcknowledgedReviewPassesChange?: (ids: string[]) => void;
}) {
  const [showMachine, setShowMachine] = useState(false);
  const { deciding, lookAt, checked, history } = brief;
  const ticketId = deciding.ticketId;
  const checkedTone =
    checked.ok === true
      ? "border-emerald-600/30 bg-emerald-500/10"
      : checked.ok === false
        ? "border-red-600/30 bg-red-500/10"
        : "border-current/15 bg-background/40";

  return (
    <div className="space-y-4" data-testid="gate-brief">
      {/* 1 — what is being decided */}
      <div className="space-y-1">
        <p className="text-sm font-medium leading-6" data-testid="gate-brief-headline">
          {deciding.headline}
        </p>
        {deciding.question ? (
          <p className="text-sm leading-6 opacity-90" data-testid="gate-brief-question">
            {deciding.question}
          </p>
        ) : null}
        <ul className="space-y-0.5 pt-1">
          {deciding.outcomes.map((outcome) => (
            <li key={outcome.decision} className="text-sm leading-6 opacity-80">
              {outcome.line}
            </li>
          ))}
        </ul>
        {deciding.waitingFor ? (
          <p className="pt-1 text-xs opacity-70" data-testid="gate-brief-waiting">
            {deciding.waitingFor}
          </p>
        ) : null}
      </div>

      {/* 2 — what the last step produced. The artifact, or the absence of it,
          never a blank. */}
      <div className="space-y-2">
        <SectionLabel>What to look at</SectionLabel>
        <p className="text-sm leading-6" data-testid="gate-brief-look-at">
          {lookAt.headline}
        </p>
        {lookAt.items.map((item) => (
          <LookAtItem key={`${item.label}-${item.anchor ?? item.url ?? ""}`} item={item} ticketId={ticketId} />
        ))}
        {lookAt.nothingThere ? (
          <p className="text-sm leading-6 opacity-80" data-testid="gate-brief-nothing-there">
            {lookAt.nothingThere}
          </p>
        ) : null}
      </div>

      {/* 3 — what the machine already checked, labelled as machine-checked */}
      <div className={`space-y-1 rounded-md border px-3 py-2.5 ${checkedTone}`}>
        <SectionLabel>Already checked</SectionLabel>
        <p className="text-sm leading-6" data-testid="gate-brief-checked">
          {checked.headline}
        </p>
        {checked.detail ? <p className="text-sm leading-6 opacity-80">{checked.detail}</p> : null}
      </div>

      {/* 4 — history that changes the decision. Silent when nothing does. */}
      {history.length > 0 ? (
        <div className="space-y-1" data-testid="gate-brief-history">
          <SectionLabel>Worth knowing first</SectionLabel>
          {history.map((line) => (
            <p key={line} className="text-sm leading-6">
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {/* 5 — the questions this decision asks. Recorded, never required. */}
      <ReviewPassChecklist
        passes={brief.reviewPasses}
        acknowledged={acknowledgedReviewPasses}
        onChange={onAcknowledgedReviewPassesChange}
      />

      {/* The machine strings still travel — hiding them would be a different
          dishonesty. They are just never the headline. */}
      {checked.machine.length > 0 ? (
        <div className="text-xs">
          <button
            type="button"
            className="underline underline-offset-2 opacity-70"
            onClick={() => setShowMachine((value) => !value)}
          >
            {showMachine ? "Hide the exact check" : "Show the exact check"}
          </button>
          {showMachine ? (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all opacity-70">
              {checked.machine.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The brief, fetched.
 *
 * Every degraded state says something rather than collapsing to nothing: no
 * approval id, a brief that could not be assembled, or the older flow-shaped
 * brief (which its own surface renders) each fall back to the gate's question
 * — the state the product was in before this existed, reached deliberately
 * instead of by an empty render.
 */
function GateQuestionOnly({ question }: { question: string | null | undefined }) {
  const text = question?.trim();
  if (!text) return null;
  return (
    <p className="text-sm font-medium leading-6" data-testid="gate-brief-fallback">
      {text}
    </p>
  );
}

function LoadedGateBrief({
  approvalId,
  fallbackQuestion,
  acknowledgedReviewPasses,
  onAcknowledgedReviewPassesChange,
}: {
  approvalId: string;
  fallbackQuestion?: string | null;
  acknowledgedReviewPasses?: string[];
  onAcknowledgedReviewPassesChange?: (ids: string[]) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.approvals.brief(approvalId),
    queryFn: () => approvalsApi.getBrief(approvalId),
    staleTime: 15_000,
  });

  if (isLoading) {
    return <p className="text-xs opacity-70">Gathering what you need to decide…</p>;
  }
  // A brief that could not be assembled, or the older flow-shaped one (its own
  // surface renders that), falls back to the question — the state the product
  // was in before this existed, reached deliberately rather than by an empty
  // render.
  if (!data || data.available === false || data.kind !== "pipeline_gate") {
    return <GateQuestionOnly question={fallbackQuestion} />;
  }

  return (
    <GateBriefBody
      brief={data}
      acknowledgedReviewPasses={acknowledgedReviewPasses}
      onAcknowledgedReviewPassesChange={onAcknowledgedReviewPassesChange}
    />
  );
}

/**
 * The brief, fetched.
 *
 * The fetch lives one component down so that a gate with NO open approval —
 * which is every gate on a surface rendered outside a query context, and the
 * honest degraded state — costs nothing and needs no provider. A decision
 * with no brief still shows its question and still has its buttons; it is
 * thinner, not broken.
 */
export function GateBrief({
  approvalId,
  fallbackQuestion,
  acknowledgedReviewPasses,
  onAcknowledgedReviewPassesChange,
}: {
  approvalId: string | null | undefined;
  /** The gate's own question, shown when no brief can be had. */
  fallbackQuestion?: string | null;
  acknowledgedReviewPasses?: string[];
  onAcknowledgedReviewPassesChange?: (ids: string[]) => void;
}) {
  if (!approvalId) return <GateQuestionOnly question={fallbackQuestion} />;
  return (
    <LoadedGateBrief
      approvalId={approvalId}
      fallbackQuestion={fallbackQuestion}
      acknowledgedReviewPasses={acknowledgedReviewPasses}
      onAcknowledgedReviewPassesChange={onAcknowledgedReviewPassesChange}
    />
  );
}
