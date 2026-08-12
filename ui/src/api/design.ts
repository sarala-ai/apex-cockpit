// Design API client — design-as-code (.penpot, legacy .op) discovery across the company's
// bound repos. Read-only; authoring happens in Penpot.

import { api } from "./client";
import type { DesignRepoListing, DesignFileContent } from "@paperclipai/shared";

export const designApi = {
  files: (companyId?: string) =>
    api.get<DesignRepoListing[]>(
      `/design/files${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""}`,
    ),
  /** `ref` reads the document as it exists on a DRAFT (a pull request's head
   *  branch). Omitted = what shipped on the default branch. */
  file: (repo: string, path: string, ref?: string) =>
    api.get<DesignFileContent>(
      `/design/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}` +
        (ref ? `&ref=${encodeURIComponent(ref)}` : ""),
    ),
};
