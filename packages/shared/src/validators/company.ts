import { z } from "zod";
import {
  COMPANY_STATUSES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "../constants.js";

const logoAssetIdSchema = z.string().uuid().nullable().optional();
const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const feedbackDataSharingTermsVersionSchema = z.string().min(1).nullable().optional();
const attachmentMaxBytesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_COMPANY_ATTACHMENT_MAX_BYTES);

// Write-once identifier: stable across a company's lifetime, used to derive
// per-company capability env var names (APEX_<SLUG>_WORKFLOWS_PATH, per the
// capability-sync spec). Lowercase letters, digits, hyphens; must start with a
// letter; 2-32 characters total. Input is normalized to lowercase before the
// shape is validated, so "Acme" and "acme" are equivalent.
export const COMPANY_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export const companySlugSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .refine((value) => COMPANY_SLUG_PATTERN.test(value), {
    message:
      "Slug must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens (2-32 characters).",
  });

// Issue prefix shape: uppercase letters/digits, must start with a letter,
// 1-10 characters. This is intentionally looser than deriveIssuePrefixBase's
// output (which only ever produces 1-5 characters from a company name) because
// an operator may want to hand-pick a prefix (at creation, or via the
// break-glass escape hatch) that doesn't match any company name at all.
export const COMPANY_ISSUE_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;

export const companyIssuePrefixSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => COMPANY_ISSUE_PREFIX_PATTERN.test(value), {
    message:
      "Issue prefix must start with an uppercase letter and contain only uppercase letters and digits (1-10 characters).",
  });

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
  defaultResponsibleUserId: z.string().min(1).nullable().optional(),
  // Optional at creation — omit to auto-derive from the company name (see
  // deriveIssuePrefixBase). An explicit value wins over derivation and is
  // validated with the SAME shape as the break-glass path
  // (companyIssuePrefixSchema); unlike break-glass it is NOT retried with an
  // auto-appended suffix on collision — a taken explicit prefix is a
  // conflict, not something creation should silently work around.
  issuePrefix: companyIssuePrefixSchema.optional(),
  // Optional at creation — omit to auto-derive from the allocated issue prefix.
  // Creation is the intended one-time set point; see companySlugSchema.
  slug: companySlugSchema.optional(),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  // issuePrefix is create-only: deliberately excluded here even though
  // createCompanySchema now accepts it. Changing a company's issue prefix
  // post-creation is break-glass only (companyIssuePrefixBreakGlassSchema) —
  // see the "keeps issuePrefix out of the normal HTTP update() request shape"
  // test in companies-service.test.ts, which asserts this omission directly.
  .omit({ issuePrefix: true })
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    feedbackDataSharingEnabled: z.boolean().optional(),
    feedbackDataSharingConsentAt: z.coerce.date().nullable().optional(),
    feedbackDataSharingConsentByUserId: z.string().min(1).nullable().optional(),
    feedbackDataSharingTermsVersion: feedbackDataSharingTermsVersionSchema,
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
    attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
    // GitHub projection (per-company opt-in, off by default): mirror process
    // lifecycle onto GitHub issues. DORMANT since 0173 — the implementation
    // was the flow front-end's and was deleted with it; the setting is
    // accepted and stored, and projects nothing until it is re-hosted on the
    // pipeline step host. Only the owner/name SHAPE is validated.
    githubProjectionEnabled: z.boolean().optional(),
    githubProjectionRepo: z
      .string()
      .trim()
      .regex(/^[^/\s]+\/[^/\s]+$/, "Repo must be in owner/name format")
      .nullable()
      .optional(),
    // Write-once: the service only accepts this when the company's current slug
    // is NULL. Sending it once a slug is already set is rejected as a classified
    // conflict — see companyService.update.
    slug: companySlugSchema.optional(),
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;

export const updateCompanyBrandingSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.brandColor !== undefined
      || value.logoAssetId !== undefined,
    "At least one branding field must be provided",
  );

export type UpdateCompanyBranding = z.infer<typeof updateCompanyBrandingSchema>;

// Break-glass slug change — the ONE deliberate escape hatch from write-once
// immutability. `newSlug` goes through the same shape validation as any other
// slug. `confirm` is optional so the route can be called twice: once without
// it to fetch the consequences preview (no write), once with it — set to the
// CURRENT slug, typed by the operator — to actually perform the change. This
// is intentionally not a boolean: typing the old slug out is the proof of
// deliberateness the state-lock-break pattern relies on.
export const companySlugBreakGlassSchema = z.object({
  newSlug: companySlugSchema,
  confirm: z.string().min(1).optional(),
});

export type CompanySlugBreakGlass = z.infer<typeof companySlugBreakGlassSchema>;

// Break-glass issue prefix change — same posture as the slug break-glass
// escape hatch (see companySlugBreakGlassSchema): `confirm` absent returns a
// dry-run consequences preview only; `confirm` set to the CURRENT prefix
// performs the change. See companyService.breakGlassChangeIssuePrefix for why
// this exists as a break-glass op rather than a normal update() field — issue
// prefix has no update path at all today, and once issues exist against a
// prefix, changing it has real consequences (see consequences report).
export const companyIssuePrefixBreakGlassSchema = z.object({
  newPrefix: companyIssuePrefixSchema,
  confirm: z.string().min(1).optional(),
});

export type CompanyIssuePrefixBreakGlass = z.infer<typeof companyIssuePrefixBreakGlassSchema>;
