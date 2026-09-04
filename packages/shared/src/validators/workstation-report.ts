import { z } from "zod";

// What an operator's workstation knows about its own toolchain. Produced by the
// desktop app at launch and by `apex doctor --report`; consumed by the setup
// wizard's operator-scoped items. Never carries a credential value.
export const workstationReportSchema = z.object({
  gcloud: z.object({
    installed: z.boolean(),
    account: z.string().trim().min(1).max(320).nullable(),
    live: z.boolean(),
  }),
  adc: z.object({ live: z.boolean() }),
  gh: z.object({
    installed: z.boolean(),
    user: z.string().trim().min(1).max(120).nullable(),
  }),
  // optional: not every reporter sends them
  claude: z.object({
    installed: z.boolean(),
    version: z.string().trim().min(1).max(64).nullable().optional(),
    loggedIn: z.boolean().nullable().optional(),
  }),
  apex: z.object({
    installed: z.boolean(),
    version: z.string().trim().min(1).max(64).nullable(),
  }),
});

export type WorkstationReport = z.infer<typeof workstationReportSchema>;

export const WORKSTATION_REPORT_SOURCES = ["desktop", "cli"] as const;
export type WorkstationReportSource = (typeof WORKSTATION_REPORT_SOURCES)[number];

export const submitWorkstationReportSchema = z.object({
  source: z.enum(WORKSTATION_REPORT_SOURCES),
  report: workstationReportSchema,
});

export type SubmitWorkstationReport = z.infer<typeof submitWorkstationReportSchema>;
