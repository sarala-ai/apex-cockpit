/**
 * WorkingStore seam (spec 002). Engineering-shaped persistence for the pipeline
 * (ticket → stage → spec → plan → tasks → gates → PR). Thin JSON-file impl to
 * start; Paperclip's tables (or SQLite) may back it later without touching callers.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Run } from './types.js';

export interface WorkingStore {
  list(): Promise<Run[]>;
  get(runId: string): Promise<Run | undefined>;
  put(run: Run): Promise<void>;
}

/** File-backed store at ~/.apex-tower/runs.json. Single-user, local-first. */
export class JsonWorkingStore implements WorkingStore {
  private readonly path: string;
  private cache: Map<string, Run> | null = null;

  constructor(path = join(homedir(), '.apex-tower', 'runs.json')) {
    this.path = path;
  }

  private async load(): Promise<Map<string, Run>> {
    if (this.cache) return this.cache;
    try {
      const text = await readFile(this.path, 'utf8');
      const rows = JSON.parse(text) as Run[];
      this.cache = new Map(rows.map((r) => [r.runId, r]));
    } catch {
      this.cache = new Map(); // missing/corrupt file → empty, not a crash
    }
    return this.cache;
  }

  private async flush(): Promise<void> {
    const map = this.cache ?? new Map();
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify([...map.values()], null, 2), 'utf8');
  }

  async list(): Promise<Run[]> {
    return [...(await this.load()).values()];
  }

  async get(runId: string): Promise<Run | undefined> {
    return (await this.load()).get(runId);
  }

  async put(run: Run): Promise<void> {
    (await this.load()).set(run.runId, run);
    await this.flush();
  }
}
