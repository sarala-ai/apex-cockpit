import type { PipelineStoppedStep } from "@paperclipai/shared";
import { api } from "./client";

export const stoppedStepsApi = {
  list: (companyId: string) =>
    api.get<{ items: PipelineStoppedStep[] }>(`/companies/${companyId}/stopped-steps`),
};
