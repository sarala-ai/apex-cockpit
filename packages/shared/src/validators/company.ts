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

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
  defaultResponsibleUserId: z.string().min(1).nullable().optional(),
  // Optional at creation — omit to auto-derive from the allocated issue prefix.
  // Creation is the intended one-time set point; see companySlugSchema.
  slug: companySlugSchema.optional(),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
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
    // GitHub projection (per-company opt-in, off by default): mirror flow
    // lifecycle onto GitHub issues in `githubProjectionRepo` ("owner/name").
    // Enabling without a repo is rejected at the service layer for
    // board-origin mirrors to have a creation target.
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
