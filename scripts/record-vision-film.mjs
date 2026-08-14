#!/usr/bin/env node
// Records the APEX vision film (v4) end to end, autonomously:
// narration via macOS `say` (TTS — v3 was TTS as well), video via
// Playwright driving the LIVE cockpit and the committed decks, assembly
// via ffmpeg. Re-run it and the film is re-recorded against today's
// surfaces — same refreshability contract as capture-vision-current.mjs.
//
// Diction: coined terms are written in speakable form in the narration
// (v3's whisper transcript heard "evalvertex" for Eval·Verdict — the
// classic TTS compound-mangling; here compounds are spelled out).
//
// Usage: node scripts/record-vision-film.mjs [outDir]
//   COCKPIT_URL  (default http://localhost:3100)
//   VOICE        (default Samantha)  RATE (default 168 wpm)

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localRequire = createRequire(import.meta.url);
const { chromium } = localRequire("@playwright/test");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const docsRoot = path.resolve(repoRoot, "..", "docs");
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(docsRoot, "vision", "v4");
const workDir = path.join(outDir, "build");
const BASE_URL = process.env.COCKPIT_URL ?? "http://localhost:3100";
const VOICE = process.env.VOICE ?? "Samantha";
const RATE = process.env.RATE ?? "168";
const SIZE = { width: 1920, height: 1080 };
const juxDeck = `file://${path.join(docsRoot, "vision", "juxtaposition-deck.html")}`;
const visionDeck = `file://${path.join(docsRoot, "vision", "apex-product-vision-deck.html")}`;

// One beat = one narration paragraph + one recorded shot. Actions run
// while the recorder rolls; after they finish, the last frame holds
// until the clip covers the narration.
const BEATS = [
  {
    id: "01-claim",
    say:
      "Every company is about to run on A.I. agents doing real engineering " +
      "work. The unsolved problem is not making agents smart. It is making " +
      "their work inspectable, governed, and repeatable. This is APEX. " +
      "The real thing first — then where it goes.",
    shot: [
      { goto: juxDeck },
      { pause: 2500 },
      { scroll: { to: 1, ms: 2500 } },
    ],
  },
  {
    id: "02-condition",
    say:
      "The condition, from primary research. Ninety percent of developers " +
      "use A.I. daily, yet ninety six percent do not fully trust its " +
      "output. Delivery stability is still negative. Adoption won; " +
      "discipline lost. The operating layer arrived as a dozen separate " +
      "tools — skills, prompts, M.C.P. servers, observability, evals, " +
      "pipelines, infrastructure — assembled by hand, and needed twice: " +
      "once to build the product, and once inside the product being " +
      "shipped. Creative prices are paid for clerk work. Deployment " +
      "patterns are finite. Finite means enumerable. Enumerable means " +
      "deterministic.",
    shot: [
      { goto: visionDeck },
      { scroll: { to: 1, ms: 3000 } },
      { pause: 3000 },
      { scroll: { to: 2, ms: 3000 } },
      { pause: 3000 },
      { scroll: { to: 4, ms: 4000 } },
      { pause: 2500 },
      { scroll: { to: 5, ms: 3500 } },
    ],
  },
  {
    id: "03-bloom-plane",
    say:
      "Here is a real product's entire plane. Bloom — an ed tech product " +
      "in development. Nine cloud run services, all healthy. The inventory " +
      "reads two thousand and one resources across forty three types — " +
      "discovered live, not curated. It read twelve hundred twenty nine in " +
      "July; the number moved because Bloom moved. Switch company: " +
      "FinPilot. Three services, one hundred and fifty three resources. " +
      "Multi-product from day one. The same surface — and nobody logged " +
      "into anything.",
    shot: [
      { goto: `${BASE_URL}/BLOOM/observe`, ready: "Real observability" },
      { pause: 3500 },
      { wheel: { dy: 900, ms: 3000 } },
      { pause: 2000 },
      { wheel: { dy: 1400, ms: 3500 } },
      { pause: 3500 },
      { goto: `${BASE_URL}/FINP/observe`, ready: "Real observability" },
      { pause: 2500 },
      { wheel: { dy: 1000, ms: 3000 } },
    ],
  },
  {
    id: "04-self-host",
    say:
      "APEX observes itself. Version zero point nine is public on the " +
      "Python package index — released through its own workflow engine, " +
      "with its own C.I. observed here. We eat the discipline we sell. " +
      "Even the errors are honest.",
    shot: [
      { goto: `${BASE_URL}/APEX/observe`, ready: "Real observability" },
      { pause: 3000 },
      { wheel: { dy: 900, ms: 3000 } },
    ],
  },
  {
    id: "05-dev-loop",
    say:
      "The development loop. A ticket becomes a spec, a design, a plan, an " +
      "implementation — agents do the work, humans approve at gates. The " +
      "cheapest gate is the design gate: a board reviewed in seconds, " +
      "before any implementation tokens burn. Last month, an agent took a " +
      "real issue end to end — repaired its own environment, wrote passing " +
      "tests, and closed the ticket — with zero human intervention after " +
      "the assignment. And this product's own design shipped through the " +
      "same loop — forty six boards across ten planes, every surface with " +
      "a current state and a target state, rendered by the cockpit itself " +
      "from the committed file.",
    shot: [
      { goto: `${BASE_URL}/APEX/issues` },
      { pause: 5000 },
      { goto: `${BASE_URL}/APEX/design`, ready: "Shipped" },
      { pause: 1500 },
      { click: { name: "Observe", exact: true } },
      { pause: 3000 },
      { click: { name: "Target", exact: true } },
      { pause: 3000 },
      { click: { name: "Current", exact: true } },
    ],
  },
  {
    id: "06-gateway",
    say:
      "Every tool an agent touches routes through a governed gateway. The " +
      "design tool's own M.C.P. server is federated here — four tools, " +
      "every call audited. We govern inside the execution path, at the " +
      "moment of the call.",
    shot: [
      { goto: `${BASE_URL}/APEX/gateway`, ready: "Gateways" },
      { pause: 3000 },
    ],
  },
  {
    id: "07-ladder",
    say:
      "Determinism is not a mode. It is a ladder. Encoded up front, in the " +
      "workflows that already deploy three products. Enforced by " +
      "composition. Imposed on intelligence — agent steps run inside " +
      "approved specs, with machine checked acceptance. And accreted over " +
      "time, as successful improvisation is promoted into permanent " +
      "workflows. And because those workflows are battle tested: point " +
      "them at an empty cloud project and a repository, and a new " +
      "company's foundation bootstraps in a day, not a quarter.",
    shot: [
      { goto: `${BASE_URL}/pipelines` },
      { pause: 4000 },
      { wheel: { dy: 500, ms: 2000 } },
    ],
  },
  {
    id: "08-cockpit",
    say:
      "Notice what you never did in this walkthrough: leave. Tickets, " +
      "boards, designs, docs, pipelines, resource planes, capabilities, " +
      "costs — one traceable loop, one surface. No story points, no " +
      "standups; two budgets instead — dollars for runs, and my attention " +
      "at gates. That is why we call it the cockpit: it controls your " +
      "product plane, and makes it soar.",
    shot: [
      { goto: `${BASE_URL}/APEX/design`, ready: "Shipped" },
      { pause: 1500 },
      { click: { name: "Registry", exact: true } },
      { pause: 3000 },
    ],
  },
  {
    id: "09-honesty",
    say:
      "One last thing — the honesty metric. This film's companion deck " +
      "puts every facet's live screenshot beside its target board. Today " +
      "the score is eight live, to eight target. The evaluation verdicts. " +
      "The capability registry, with its amendment gate and its cascade. " +
      "One screen onboarding. Still boards — and each one carries its " +
      "ticket. That ratio is restated in every film, because its movement " +
      "is the proof. Everything you saw is running today, built by one " +
      "person, with the loop you just watched. What is not running yet is " +
      "marked. That is the pitch.",
    shot: [
      { goto: juxDeck },
      { scroll: { to: 9, ms: 4000 } },
      { pause: 3000 },
      { scroll: { to: 10, ms: 3000 } },
      { pause: 3000 },
      { scroll: { to: 17, ms: 4000 } },
    ],
  },
];

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const probeDur = (file) =>
  parseFloat(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));

async function synthesize() {
  const durations = {};
  for (const beat of BEATS) {
    const aiff = path.join(workDir, `${beat.id}.aiff`);
    const m4a = path.join(workDir, `${beat.id}.m4a`);
    sh("say", ["-v", VOICE, "-r", RATE, "-o", aiff, beat.say]);
    // 0.7s of trailing silence per beat keeps cuts from feeling clipped.
    sh("ffmpeg", ["-y", "-v", "error", "-i", aiff, "-af", "apad=pad_dur=0.7",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", m4a]);
    durations[beat.id] = probeDur(m4a);
    console.log(`audio ${beat.id}: ${durations[beat.id].toFixed(1)}s`);
  }
  return durations;
}

async function runShot(page, beat) {
  for (const step of beat.shot) {
    if (step.goto) {
      await page.goto(step.goto, { waitUntil: "load", timeout: 60_000 });
      if (step.ready) await page.getByText(step.ready).first().waitFor({ timeout: 60_000 });
    } else if (step.pause) {
      await page.waitForTimeout(step.pause);
    } else if (step.click) {
      await page.getByRole("button", { name: step.click.name, exact: step.click.exact ?? false })
        .first().click({ timeout: 15_000 });
    } else if (step.scroll) {
      // Smooth-scroll a deck to section N over ms.
      await page.evaluate(({ to }) => {
        document.querySelectorAll("section")[to]?.scrollIntoView({ behavior: "smooth" });
      }, step.scroll);
      await page.waitForTimeout(step.scroll.ms);
    } else if (step.wheel) {
      const ticks = 10;
      for (let i = 0; i < ticks; i++) {
        await page.mouse.wheel(0, step.wheel.dy / ticks);
        await page.waitForTimeout(step.wheel.ms / ticks);
      }
    }
  }
}

async function record(durations) {
  const browser = await chromium.launch();
  const clips = {};
  for (const beat of BEATS) {
    const ctx = await browser.newContext({
      viewport: SIZE,
      deviceScaleFactor: 1,
      recordVideo: { dir: workDir, size: SIZE },
    });
    // Dev-harness chrome only (restart banner, setup toast) — surfaces stay live.
    await ctx.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent =
        '[data-testid="dev-restart-banner"],[data-testid="setup-startup-prompt"]{display:none !important}';
      document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
    });
    const page = await ctx.newPage();
    const started = Date.now();
    await runShot(page, beat);
    // Hold the last frame until the clip outlasts the narration.
    const need = (durations[beat.id] + 1.0) * 1000 - (Date.now() - started);
    if (need > 0) await page.waitForTimeout(need);
    const video = page.video();
    await ctx.close();
    const raw = await video.path();
    const dest = path.join(workDir, `${beat.id}.webm`);
    await fs.rename(raw, dest);
    clips[beat.id] = dest;
    console.log(`clip ${beat.id}: recorded`);
  }
  await browser.close();
  return clips;
}

function assemble(durations, clips) {
  const parts = [];
  for (const beat of BEATS) {
    const seg = path.join(workDir, `${beat.id}.mp4`);
    // Cut video to exactly the narration length; normalize codecs for concat.
    sh("ffmpeg", ["-y", "-v", "error",
      "-i", clips[beat.id], "-i", path.join(workDir, `${beat.id}.m4a`),
      "-map", "0:v:0", "-map", "1:a:0", "-t", durations[beat.id].toFixed(3),
      "-vf", "scale=1920:1080,fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", seg]);
    parts.push(seg);
    console.log(`segment ${beat.id}: muxed`);
  }
  const list = path.join(workDir, "concat.txt");
  execFileSync("bash", ["-c",
    `printf "file '%s'\\n" ${parts.map((p) => `"${p}"`).join(" ")} > "${list}"`]);
  const final = path.join(outDir, "apex-vision-v4.mp4");
  sh("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", final]);
  return final;
}

async function main() {
  const probe = await fetch(`${BASE_URL}/`).catch(() => null);
  if (!probe?.ok) throw new Error(`Cockpit not reachable at ${BASE_URL} — start pnpm dev:once first.`);
  await fs.mkdir(workDir, { recursive: true });

  // Pre-warm the observe panes so inventory numbers are on screen when
  // the recorder rolls (cold scans take ~30s).
  const warm = await chromium.launch();
  const wp = await (await warm.newContext({ viewport: SIZE })).newPage();
  for (const co of ["BLOOM", "FINP", "APEX"]) {
    await wp.goto(`${BASE_URL}/${co}/observe`, { waitUntil: "load", timeout: 60_000 });
    for (let i = 0; i < 30; i++) {
      const t = await wp.innerText("main").catch(() => "");
      if (/resources ·/.test(t)) break;
      await wp.waitForTimeout(4000);
    }
    console.log(`pre-warmed ${co}/observe`);
  }
  await warm.close();

  const durations = await synthesize();
  const clips = await record(durations);
  const final = assemble(durations, clips);

  const total = probeDur(final);
  await fs.writeFile(path.join(outDir, "narration-v4.txt"),
    BEATS.map((b) => `[${b.id}]\n${b.say}\n`).join("\n"));
  await fs.writeFile(path.join(outDir, "PROVENANCE.md"),
    `# apex-vision-v4 — provenance\n\nGenerated ${new Date().toISOString()} by ` +
    `cockpit scripts/record-vision-film.mjs (TTS voice ${VOICE} @ ${RATE} wpm; ` +
    `Playwright against ${BASE_URL}; decks from apex-docs vision/).\n` +
    `Total ${total.toFixed(1)}s across ${BEATS.length} beats. Fully ` +
    `re-recordable: re-run the script and the film shows that day's surfaces.\n`);
  console.log(`\nfinal: ${final} (${total.toFixed(1)}s)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
