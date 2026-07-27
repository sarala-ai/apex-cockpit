// Design API client — design-as-code (.op) discovery across the company's
// bound repos. Read-only; authoring happens in OpenPencil.

import { api } from "./client";
import type { DesignRepoListing, DesignFileContent } from "@paperclipai/shared";

export const designApi = {
  files: (companyId?: string) =>
    api.get<DesignRepoListing[]>(
      `/design/files${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""}`,
    ),
  file: (repo: string, path: string) =>
    api.get<DesignFileContent>(
      `/design/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
    ),
};
