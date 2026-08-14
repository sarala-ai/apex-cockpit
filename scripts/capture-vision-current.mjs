#!/usr/bin/env node
// Captures the "current" (real, live) screenshots for the APEX-94
// juxtaposition deck: one 1920x1080 PNG per shipped surface, taken against
// the running dev server. Refreshable by design — re-run it and the deck's
// "current" side is today's truth again, with provenance recorded in
// manifest.json so a stale set is detectable instead of quietly rotting.
//
// Usage:
//   node scripts/capture-vision-current.mjs [outDir]
//     COCKPIT_URL   base URL of the running cockpit (default http://localhost:3100)
//     SHOT_FILTER   comma-separated shot labels to (re)capture, default all
//
// Prereqs the script checks rather than assumes: dev server reachable;
// per-shot readiness text present before the shutter fires. Shots that fail
// are reported individually at the end — one broken pane never silently
// yields a full set of stale images.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localRequire = createRequire(import.meta.url);
const { chromium } = localRequire("@playwright/test");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
// Default destination is the apex-docs checkout that sits beside cockpit in
// the umbrella repo (apex/docs → vision/current). Override with argv[2].
const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(repoRoot, "..", "docs", "vision", "current");

const BASE_URL = process.env.COCKPIT_URL ?? "http://localhost:3100";
const VIEWPORT = { width: 1920, height: 1080 };

// One entry per deck facet's "current" side. `route` is the page; `clicks`
// is an ordered list of accessible button names pressed after load (the
// Design tab keeps board selection in client state, not the URL, so target
// boards are reached by the same clicks a human makes). `readyText` must be
// visible before capture; `settleMs` covers post-ready animation/log churn.
const SHOTS = [
  { label: "dashboard", route: "/APEX/dashboard", readyText: "AGENTS" },
  {
    label: "tasks-board",
    route: "/APEX/issues",
    clicks: [{ role: "button", name: "Board view" }],
    readyText: "APEX-94",
  },
  { label: "pipelines", route: "/pipelines", settleMs: 2000 },
  { label: "releases", route: "/releases", settleMs: 2000 },
  // Observe panes discover live GCP inventory; cold scans take ~30s, so the
  // ready text is the surface's own header and the settle is generous.
  { label: "observe-apex", route: "/APEX/observe", settleMs: 8000 },
  { label: "observe-bloom", route: "/Bloom/observe", settleMs: 8000 },
  { label: "observe-finpilot", route: "/FinPilot/observe", settleMs: 8000 },
  { label: "design-index", route: "/APEX/design", readyText: "Shipped" },
  {
    label: "design-observe-current",
    route: "/APEX/design",
    clicks: [{ role: "button", name: "Observe", exact: true }],
    readyText: "Shipped",
    settleMs: 2000,
  },
  {
    label: "design-observe-target",
    route: "/APEX/design",
    clicks: [
      { role: "button", name: "Observe", exact: true },
      { role: "button", name: "Target", exact: true },
    ],
    readyText: "Shipped",
    settleMs: 2000,
  },
  // Gateway registry: requires apex-gateway to be up and the penpot upstream
  // federated — readyText makes an unreachable gateway a loud per-shot
  // failure instead of a screenshot of the error state.
  {
    label: "gateway-registry",
    route: "/APEX/gateway",
    readyText: "Gateways",
    failText: "gateway unreachable",
  },
  { label: "timeline", route: "/APEX/timeline", settleMs: 2000 },
  { label: "costs", route: "/APEX/costs", settleMs: 2000 },
];

function gitProvenance() {
  const rev = (repo) => {
    try {
      return execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return null;
    }
  };
  return { cockpit: rev(repoRoot), apexDocs: rev(path.resolve(repoRoot, "..", "docs")) };
}

async function captureShot(page, shot) {
  // "load", not "networkidle": Observe panes poll live inventory and never
  // go network-idle. Readiness is the shot's own readyText + settle.
  await page.goto(`${BASE_URL}${shot.route}`, {
    waitUntil: "load",
    timeout: 60_000,
  });
  // Hide dev-harness chrome only: the hot-reload restart banner and the
  // setup nudge toast are artifacts of running the dev server, not product
  // surface — every pixel of the surface itself stays live and unstaged.
  await page.addStyleTag({
    content:
      '[data-testid="dev-restart-banner"], [data-testid="setup-startup-prompt"] { display: none !important; }',
  });
  for (const click of shot.clicks ?? []) {
    await page
      .getByRole(click.role, { name: click.name, exact: click.exact ?? false })
      .first()
      .click({ timeout: 15_000 });
  }
  if (shot.readyText) {
    await page.getByText(shot.readyText).first().waitFor({ timeout: 60_000 });
  }
  await page.waitForTimeout(shot.settleMs ?? 1000);
  if (shot.failText && (await page.getByText(shot.failText).first().isVisible().catch(() => false))) {
    throw new Error(`page shows "${shot.failText}" — surface is in its error state, not captured`);
  }
  const dest = path.join(outDir, `${shot.label}.png`);
  await page.screenshot({ path: dest, fullPage: false });
  return dest;
}

async function main() {
  const filter = process.env.SHOT_FILTER
    ? new Set(process.env.SHOT_FILTER.split(",").map((s) => s.trim()))
    : null;
  const shots = filter ? SHOTS.filter((s) => filter.has(s.label)) : SHOTS;
  if (filter) {
    const unknown = [...filter].filter((l) => !SHOTS.some((s) => s.label === l));
    if (unknown.length) throw new Error(`Unknown SHOT_FILTER labels: ${unknown.join(", ")}`);
  }

  const probe = await fetch(`${BASE_URL}/`).catch(() => null);
  if (!probe?.ok) {
    throw new Error(
      `Cockpit dev server not reachable at ${BASE_URL} — start it (pnpm dev:once) before capturing.`,
    );
  }

  await fs.mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  const captured = [];
  const failed = [];
  try {
    for (const shot of shots) {
      try {
        const dest = await captureShot(page, shot);
        captured.push({
          label: shot.label,
          route: shot.route,
          file: path.basename(dest),
          capturedAt: new Date().toISOString(),
        });
        console.log(`captured ${shot.label} → ${dest}`);
      } catch (err) {
        failed.push({ label: shot.label, route: shot.route, error: String(err?.message ?? err) });
        console.error(`FAILED ${shot.label} (${shot.route}): ${err?.message ?? err}`);
      }
    }
  } finally {
    await browser.close();
  }

  // Filtered runs merge into the existing manifest so refreshing one pane
  // doesn't erase the provenance of the rest of the set.
  const manifestPath = path.join(outDir, "manifest.json");
  const ranLabels = new Set(shots.map((s) => s.label));
  const previous = await fs
    .readFile(manifestPath, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => ({ captured: [], failed: [] }));
  const keep = (entries) => (entries ?? []).filter((e) => !ranLabels.has(e.label));
  const manifest = {
    updatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    viewport: VIEWPORT,
    git: gitProvenance(),
    captured: [...keep(previous.captured), ...captured],
    failed: [...keep(previous.failed), ...failed],
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\n${captured.length}/${shots.length} shots captured → ${outDir}`);
  if (failed.length) {
    console.error(`${failed.length} shot(s) FAILED — deck "current" side is incomplete:`);
    for (const f of failed) console.error(`  - ${f.label}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
