import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Goal } from "@paperclipai/shared";
import { GOAL_STATUSES, GOAL_LEVELS, GOAL_CLOSURES } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { formatDate, cn, agentUrl } from "../lib/utils";
import { goalDisplayStatus } from "../lib/goal-status";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
    </div>
  );
}

function label(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function PickerButton({
  current,
  options,
  onChange,
  children,
}: {
  current: string;
  options: readonly string[];
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {options.map((opt) => (
          <Button
            key={opt}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs", opt === current && "bg-accent")}
            onClick={() => {
              onChange(opt);
              setOpen(false);
            }}
          >
            {label(opt)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Put an initiative on hold, or release it.
 *
 * This is the one part of an initiative's status a person sets by hand, and it
 * is deliberately not in the status picker — there is no status picker for an
 * initiative, because that reading comes from its projects. A hold is the other
 * kind of statement: *we decided to pause this*, which no arrangement of
 * projects can express. The reason is required for the same reason every
 * closure keeps its evidence; a hold with no reason is indistinguishable from
 * neglect six weeks later.
 */
function HoldControl({
  goal,
  onUpdate,
}: {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (goal.hold) {
    return (
      <>
        <StatusBadge status="on_hold" />
        <span className="text-xs text-muted-foreground min-w-0 truncate">
          {goal.hold.reason}
        </span>
        {onUpdate && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => onUpdate({ hold: null })}
          >
            Release
          </Button>
        )}
      </>
    );
  }

  if (!onUpdate) return <span className="text-sm text-muted-foreground">Not held</span>;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="text-sm text-muted-foreground cursor-pointer hover:opacity-80 transition-opacity">
          Not held
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2 space-y-2" align="end">
        <p className="text-xs text-muted-foreground">
          A hold overrides the reading from this initiative's projects, so it needs a
          reason.
        </p>
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why this is valid, but not now"
          className="text-xs"
        />
        <Button
          size="sm"
          className="w-full text-xs"
          disabled={reason.trim().length === 0}
          onClick={() => {
            onUpdate({ hold: { reason: reason.trim(), since: new Date().toISOString() } });
            setReason("");
            setOpen(false);
          }}
        >
          Put on hold
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function GoalProperties({ goal, onUpdate }: GoalPropertiesProps) {
  const { selectedCompanyId } = useCompany();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ownerAgent = goal.ownerAgentId
    ? agents?.find((a) => a.id === goal.ownerAgentId)
    : null;

  const parentGoal = goal.parentId
    ? allGoals?.find((g) => g.id === goal.parentId)
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {/* An initiative's status is read from its projects, so there is no
            picker here — offering one would invite a hand-edit that contradicts
            the board the moment a project moves. */}
        <PropertyRow label="Status">
          {goal.level === "initiative" ? (
            <>
              <StatusBadge status={goalDisplayStatus(goal)} />
              <span className="text-xs text-muted-foreground">from its projects</span>
            </>
          ) : onUpdate ? (
            <PickerButton
              current={goal.status}
              options={GOAL_STATUSES}
              onChange={(status) => onUpdate({ status })}
            >
              <StatusBadge status={goal.status} />
            </PickerButton>
          ) : (
            <StatusBadge status={goal.status} />
          )}
        </PropertyRow>

        <PropertyRow label="Level">
          {onUpdate ? (
            <PickerButton
              current={goal.level}
              options={GOAL_LEVELS}
              onChange={(level) => onUpdate({ level })}
            >
              <span className="text-sm capitalize">{goal.level}</span>
            </PickerButton>
          ) : (
            <span className="text-sm capitalize">{goal.level}</span>
          )}
        </PropertyRow>

        {/* A hold is initiative-only and, unlike the status above, ASSERTED:
            the derivation cannot see a decision to pause. */}
        {goal.level === "initiative" && (
          <PropertyRow label="Hold">
            <HoldControl goal={goal} onUpdate={onUpdate} />
          </PropertyRow>
        )}

        {/* Closure is an initiative-only verdict — it would be meaningless on a
            company, team, agent or task goal, so the row is not offered there. */}
        {goal.level === "initiative" && (
          <PropertyRow label="Closure">
            {onUpdate ? (
              <PickerButton
                current={goal.closure ?? ""}
                options={GOAL_CLOSURES}
                onChange={(closure) => onUpdate({ closure })}
              >
                {goal.closure ? (
                  <StatusBadge status={goal.closure} />
                ) : (
                  <span className="text-sm text-muted-foreground">Open</span>
                )}
              </PickerButton>
            ) : goal.closure ? (
              <StatusBadge status={goal.closure} />
            ) : (
              <span className="text-sm text-muted-foreground">Open</span>
            )}
          </PropertyRow>
        )}

        <PropertyRow label="Owner">
          {ownerAgent ? (
            <Link
              to={agentUrl(ownerAgent)}
              className="text-sm hover:underline"
            >
              {ownerAgent.name}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>

        {goal.parentId && (
          <PropertyRow label="Parent Goal">
            <Link
              to={`/goals/${goal.parentId}`}
              className="text-sm hover:underline"
            >
              {parentGoal?.title ?? goal.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(goal.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{formatDate(goal.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
