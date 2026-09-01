import { z } from "zod";

export const companyPromptVariableSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  required: z.boolean().default(false),
});

export const companyPromptCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-_]+$/, "Slug must be lowercase alphanumeric, hyphens, or underscores").optional(),
  description: z.string().max(2000).nullable().optional(),
  content: z.string().min(1),
  variables: z.array(companyPromptVariableSchema).default([]),
  commitMessage: z.string().max(500).nullable().optional(),
});

export const companyPromptUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const companyPromptVersionCreateSchema = z.object({
  content: z.string().min(1),
  variables: z.array(companyPromptVariableSchema).default([]),
  commitMessage: z.string().max(500).nullable().optional(),
});

export const companyPromptLabelSetSchema = z.object({
  versionId: z.string().uuid(),
});
