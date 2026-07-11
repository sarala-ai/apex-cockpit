/**
 * Org + Company registry (spec 003 draft).
 *
 * Three-tier tenancy that mirrors provider reality:
 *   Org (holding entity) → Company (product / business unit) → GCP projects + repo
 *
 * - Org = the provider-level organization: the Google Cloud Organization AND the
 *   GitHub Organization. Connected ONCE (the one-time setup); loads all projects
 *   and repos.
 * - Company = a product/business unit UNDER an org, claiming a SUBSET of the org's
 *   GCP projects + repos. This is the multi-tenancy unit the bootstrap and ticket
 *   loop operate within.
 *
 * Thin JSON stores, local-first (mirrors the pipeline WorkingStore).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CloudProvider } from './cloud.js';

/** The one-time provider-org linkage. One per holding entity. */
export interface Org {
  id: string;
  name: string; // holding-org name, derived from discovery (the Google org display name)
  provider: CloudProvider;
  /** Google Cloud Organization this org is linked to. */
  googleOrg?: { id: string; displayName: string };
  /** GitHub Organization login. */
  githubOrg?: string;
  createdAt: string;
}

/** A product/business unit under an Org, owning a subset of its resources. */
export interface Company {
  id: string;
  orgId: string; // parent Org
  name: string; // e.g. "FinPilot"
  /** GCP project ids under the org's Google org that belong to this company. */
  gcpProjects: string[];
  /** GitHub repos (nameWithOwner) under the org that belong to this company. */
  githubRepos: string[];
  createdAt: string;
}

/** Generic file-backed JSON store for id-keyed entities. Local-first. */
export class JsonEntityStore<T extends { id: string }> {
  private cache: Map<string, T> | null = null;
  constructor(private readonly path: string) {}

  private async load(): Promise<Map<string, T>> {
    if (this.cache) return this.cache;
    try {
      const rows = JSON.parse(await readFile(this.path, 'utf8')) as T[];
      this.cache = new Map(rows.map((r) => [r.id, r]));
    } catch {
      this.cache = new Map(); // missing/corrupt → empty, not a crash
    }
    return this.cache;
  }

  async list(): Promise<T[]> {
    return [...(await this.load()).values()];
  }
  async get(id: string): Promise<T | undefined> {
    return (await this.load()).get(id);
  }
  async put(entity: T): Promise<void> {
    const map = await this.load();
    map.set(entity.id, entity);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify([...map.values()], null, 2), 'utf8');
  }
}

const dir = join(homedir(), '.apex-tower');
export const orgStore = new JsonEntityStore<Org>(join(dir, 'orgs.json'));
export const companyStore = new JsonEntityStore<Company>(join(dir, 'companies.json'));
