import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companyPrompts, companyPromptVersions, companyPromptLabels } from "@paperclipai/db";
import { and, eq, isNull, desc } from "drizzle-orm";
import {
  companyPromptCreateSchema,
  companyPromptUpdateSchema,
  companyPromptVersionCreateSchema,
  companyPromptLabelSetSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { HttpError } from "../errors.js";
import { GatewayClient } from "../gateway/gateway-client.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function companyPromptRoutes(db: Db) {
  const router = Router();
  const gateway = new GatewayClient();

  // GET /companies/:companyId/prompts
  router.get("/companies/:companyId/prompts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const prompts = await db
      .select()
      .from(companyPrompts)
      .where(and(eq(companyPrompts.companyId, companyId), isNull(companyPrompts.deletedAt)))
      .orderBy(desc(companyPrompts.createdAt));

    if (prompts.length === 0) {
      res.json([]);
      return;
    }

    const labels = await db
      .select()
      .from(companyPromptLabels)
      .where(eq(companyPromptLabels.companyId, companyId));

    const labelsByPrompt = new Map<string, { count: number; hasProd: boolean }>();
    for (const lbl of labels) {
      const existing = labelsByPrompt.get(lbl.promptId) ?? { count: 0, hasProd: false };
      labelsByPrompt.set(lbl.promptId, {
        count: existing.count + 1,
        hasProd: existing.hasProd || lbl.name === "prod",
      });
    }

    const versionRows = await db
      .select({ promptId: companyPromptVersions.promptId, revisionNumber: companyPromptVersions.revisionNumber })
      .from(companyPromptVersions)
      .where(eq(companyPromptVersions.companyId, companyId))
      .orderBy(desc(companyPromptVersions.revisionNumber));

    const currentRevisionByPrompt = new Map<string, number>();
    for (const v of versionRows) {
      if (!currentRevisionByPrompt.has(v.promptId)) {
        currentRevisionByPrompt.set(v.promptId, v.revisionNumber);
      }
    }

    res.json(
      prompts.map((p) => ({
        ...p,
        currentVersionNumber: currentRevisionByPrompt.get(p.id) ?? null,
        labelCount: labelsByPrompt.get(p.id)?.count ?? 0,
        hasProd: labelsByPrompt.get(p.id)?.hasProd ?? false,
      })),
    );
  });

  // POST /companies/:companyId/prompts
  router.post("/companies/:companyId/prompts", validate(companyPromptCreateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const { name, slug: slugInput, description, content, variables, commitMessage } = req.body as {
      name: string;
      slug?: string;
      description?: string | null;
      content: string;
      variables?: Array<{ name: string; description: string | null; required: boolean }>;
      commitMessage?: string | null;
    };

    const slug = slugInput ?? slugify(name);

    const [prompt] = await db
      .insert(companyPrompts)
      .values({
        companyId,
        name,
        slug,
        description: description ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByAgentId: actor.agentId ?? null,
      })
      .returning();

    const [version] = await db
      .insert(companyPromptVersions)
      .values({
        companyId,
        promptId: prompt!.id,
        revisionNumber: 1,
        content,
        variables: variables ?? [],
        commitMessage: commitMessage ?? null,
        authorUserId: actor.actorType === "user" ? actor.actorId : null,
        authorAgentId: actor.agentId ?? null,
      })
      .returning();

    await db
      .update(companyPrompts)
      .set({ currentVersionId: version!.id, updatedAt: new Date() })
      .where(eq(companyPrompts.id, prompt!.id));

    res.status(201).json({ ...prompt, currentVersionId: version!.id, currentVersionNumber: 1 });
  });

  // GET /companies/:companyId/prompts/resolve/:labelName — must come before /:promptId
  router.get("/companies/:companyId/prompts/resolve/:labelName", async (req, res) => {
    const companyId = req.params.companyId as string;
    const labelName = (req.params.labelName as string).toLowerCase();
    assertCompanyAccess(req, companyId);

    const promptId = req.query.promptId as string | undefined;
    if (!promptId) {
      res.status(400).json({ error: "promptId query param is required" });
      return;
    }

    const [label] = await db
      .select()
      .from(companyPromptLabels)
      .where(
        and(
          eq(companyPromptLabels.promptId, promptId),
          eq(companyPromptLabels.name, labelName),
          eq(companyPromptLabels.companyId, companyId),
        ),
      );

    if (!label) {
      res.status(404).json({ error: `No '${labelName}' label found for this prompt` });
      return;
    }

    const [version] = await db
      .select()
      .from(companyPromptVersions)
      .where(eq(companyPromptVersions.id, label.versionId));

    const [prompt] = await db
      .select()
      .from(companyPrompts)
      .where(eq(companyPrompts.id, promptId));

    if (!version || !prompt) {
      res.status(404).json({ error: "Version data not found" });
      return;
    }

    res.json({
      promptId: prompt.id,
      promptName: prompt.name,
      versionId: version.id,
      revisionNumber: version.revisionNumber,
      content: version.content,
      variables: version.variables,
      label: labelName,
      resolvedAt: new Date().toISOString(),
    });
  });

  // GET /companies/:companyId/prompts/gateway — list what the gateway already knows
  router.get("/companies/:companyId/prompts/gateway", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const gatewayPrompts = await gateway.listGatewayPrompts();
    res.json(gatewayPrompts);
  });

  // GET /companies/:companyId/prompts/:promptId
  router.get("/companies/:companyId/prompts/:promptId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const promptId = req.params.promptId as string;
    assertCompanyAccess(req, companyId);

    const [prompt] = await db
      .select()
      .from(companyPrompts)
      .where(and(eq(companyPrompts.id, promptId), eq(companyPrompts.companyId, companyId), isNull(companyPrompts.deletedAt)));

    if (!prompt) {
      res.status(404).json({ error: "Prompt not found" });
      return;
    }

    const versions = await db
      .select()
      .from(companyPromptVersions)
      .where(and(eq(companyPromptVersions.promptId, promptId), eq(companyPromptVersions.companyId, companyId)))
      .orderBy(desc(companyPromptVersions.revisionNumber));

    const labels = await db
      .select()
      .from(companyPromptLabels)
      .where(and(eq(companyPromptLabels.promptId, promptId), eq(companyPromptLabels.companyId, companyId)));

    res.json({ ...prompt, versions, labels });
  });

  // PATCH /companies/:companyId/prompts/:promptId
  router.patch("/companies/:companyId/prompts/:promptId", validate(companyPromptUpdateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const promptId = req.params.promptId as string;
    assertCompanyAccess(req, companyId);

    const [existing] = await db
      .select()
      .from(companyPrompts)
      .where(and(eq(companyPrompts.id, promptId), eq(companyPrompts.companyId, companyId), isNull(companyPrompts.deletedAt)));

    if (!existing) {
      res.status(404).json({ error: "Prompt not found" });
      return;
    }

    const { name, description } = req.body as { name?: string; description?: string | null };
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    const [updated] = await db
      .update(companyPrompts)
      .set(updates)
      .where(eq(companyPrompts.id, promptId))
      .returning();

    res.json(updated);
  });

  // DELETE /companies/:companyId/prompts/:promptId
  router.delete("/companies/:companyId/prompts/:promptId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const promptId = req.params.promptId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const [existing] = await db
      .select()
      .from(companyPrompts)
      .where(and(eq(companyPrompts.id, promptId), eq(companyPrompts.companyId, companyId), isNull(companyPrompts.deletedAt)));

    if (!existing) {
      res.status(404).json({ error: "Prompt not found" });
      return;
    }

    const protectedLabels = await db
      .select()
      .from(companyPromptLabels)
      .where(
        and(
          eq(companyPromptLabels.promptId, promptId),
          eq(companyPromptLabels.protected, true),
        ),
      );

    if (protectedLabels.length > 0 && actor.actorType === "agent") {
      throw new HttpError(409, `Cannot delete prompt with protected labels: ${protectedLabels.map((l) => l.name).join(", ")}`);
    }

    await db
      .update(companyPrompts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(companyPrompts.id, promptId));

    res.status(204).end();
  });

  // GET /companies/:companyId/prompts/:promptId/versions
  router.get("/companies/:companyId/prompts/:promptId/versions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const promptId = req.params.promptId as string;
    assertCompanyAccess(req, companyId);

    const versions = await db
      .select()
      .from(companyPromptVersions)
      .where(and(eq(companyPromptVersions.promptId, promptId), eq(companyPromptVersions.companyId, companyId)))
      .orderBy(desc(companyPromptVersions.revisionNumber));

    res.json(versions);
  });

  // POST /companies/:companyId/prompts/:promptId/versions
  router.post(
    "/companies/:companyId/prompts/:promptId/versions",
    validate(companyPromptVersionCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const promptId = req.params.promptId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const [existing] = await db
        .select()
        .from(companyPrompts)
        .where(and(eq(companyPrompts.id, promptId), eq(companyPrompts.companyId, companyId), isNull(companyPrompts.deletedAt)));

      if (!existing) {
        res.status(404).json({ error: "Prompt not found" });
        return;
      }

      const [lastVersion] = await db
        .select({ revisionNumber: companyPromptVersions.revisionNumber })
        .from(companyPromptVersions)
        .where(and(eq(companyPromptVersions.promptId, promptId), eq(companyPromptVersions.companyId, companyId)))
        .orderBy(desc(companyPromptVersions.revisionNumber))
        .limit(1);

      const nextRevision = (lastVersion?.revisionNumber ?? 0) + 1;
      const { content, variables, commitMessage } = req.body as {
        content: string;
        variables?: Array<{ name: string; description: string | null; required: boolean }>;
        commitMessage?: string | null;
      };

      const [version] = await db
        .insert(companyPromptVersions)
        .values({
          companyId,
          promptId,
          revisionNumber: nextRevision,
          content,
          variables: variables ?? [],
          commitMessage: commitMessage ?? null,
          authorUserId: actor.actorType === "user" ? actor.actorId : null,
          authorAgentId: actor.agentId ?? null,
        })
        .returning();

      await db
        .update(companyPrompts)
        .set({ currentVersionId: version!.id, updatedAt: new Date() })
        .where(eq(companyPrompts.id, promptId));

      res.status(201).json(version);
    },
  );

  // GET /companies/:companyId/prompts/:promptId/labels
  router.get("/companies/:companyId/prompts/:promptId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    const promptId = req.params.promptId as string;
    assertCompanyAccess(req, companyId);

    const labels = await db
      .select()
      .from(companyPromptLabels)
      .where(and(eq(companyPromptLabels.promptId, promptId), eq(companyPromptLabels.companyId, companyId)));

    res.json(labels);
  });

  // PUT /companies/:companyId/prompts/:promptId/labels/:labelName
  router.put(
    "/companies/:companyId/prompts/:promptId/labels/:labelName",
    validate(companyPromptLabelSetSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const promptId = req.params.promptId as string;
      const labelName = (req.params.labelName as string).toLowerCase();
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const [prompt] = await db
        .select()
        .from(companyPrompts)
        .where(and(eq(companyPrompts.id, promptId), eq(companyPrompts.companyId, companyId), isNull(companyPrompts.deletedAt)));

      if (!prompt) {
        res.status(404).json({ error: "Prompt not found" });
        return;
      }

      const { versionId } = req.body as { versionId: string };
      const [version] = await db
        .select()
        .from(companyPromptVersions)
        .where(and(eq(companyPromptVersions.id, versionId), eq(companyPromptVersions.promptId, promptId)));

      if (!version) {
        res.status(404).json({ error: "Version not found" });
        return;
      }

      const [existingLabel] = await db
        .select()
        .from(companyPromptLabels)
        .where(and(eq(companyPromptLabels.promptId, promptId), eq(companyPromptLabels.name, labelName)));

      if (existingLabel?.protected && actor.actorType === "agent") {
        throw new HttpError(403, `The '${labelName}' label is protected and requires board-level authorization`);
      }

      const isProtected = labelName === "prod";
      const now = new Date();

      let label;
      if (existingLabel) {
        const [updated] = await db
          .update(companyPromptLabels)
          .set({
            versionId,
            versionNumber: version.revisionNumber,
            updatedByUserId: actor.actorType === "user" ? actor.actorId : null,
            updatedByAgentId: actor.agentId ?? null,
            updatedAt: now,
          })
          .where(eq(companyPromptLabels.id, existingLabel.id))
          .returning();
        label = updated;
      } else {
        const [inserted] = await db
          .insert(companyPromptLabels)
          .values({
            companyId,
            promptId,
            name: labelName,
            versionId,
            versionNumber: version.revisionNumber,
            protected: isProtected,
            updatedByUserId: actor.actorType === "user" ? actor.actorId : null,
            updatedByAgentId: actor.agentId ?? null,
          })
          .returning();
        label = inserted;
      }

      res.json(label);
    },
  );

  // DELETE /companies/:companyId/prompts/:promptId/labels/:labelName
  router.delete("/companies/:companyId/prompts/:promptId/labels/:labelName", async (req, res) => {
    const companyId = req.params.companyId as string;
    const promptId = req.params.promptId as string;
    const labelName = (req.params.labelName as string).toLowerCase();
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const [existingLabel] = await db
      .select()
      .from(companyPromptLabels)
      .where(and(eq(companyPromptLabels.promptId, promptId), eq(companyPromptLabels.name, labelName)));

    if (!existingLabel) {
      res.status(404).json({ error: "Label not found" });
      return;
    }

    if (existingLabel.protected && actor.actorType === "agent") {
      throw new HttpError(403, `The '${labelName}' label is protected and cannot be removed by agents`);
    }

    await db
      .delete(companyPromptLabels)
      .where(eq(companyPromptLabels.id, existingLabel.id));

    res.status(204).end();
  });

  return router;
}
