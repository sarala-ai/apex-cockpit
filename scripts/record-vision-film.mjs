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
const titleCards = `file://${path.join(docsRoot, "vision", "v4", "titlecards.html")}`;

// The v3 story spine, compressed to ~5 minutes: the sentence is planted
// in the cold open, travels through the machine, and returns as evidence
// before the close. Wording preserved from the v3 narration where it
// still holds; numbers updated to today's verified surfaces; coined
// compounds written speakably (the "evalvertex" class).
const BEATS = [
  {
    id: "01-cold-open",
    say:
      "Every product begins as a sentence. Here is one of ours: tell a " +
      "household what's due this week. Hold on to it — you're going to " +
      "watch it travel. Product engineering means the complete lifecycle. " +
      "With agents, that should have become simple. It didn't. In a " +
      "controlled trial, experienced developers were nineteen percent " +
      "slower with A.I. — while believing they were twenty percent " +
      "faster. Oversight became a job. This is the story of the machine " +
      "that gives the discipline back. It's called APEX.",
    shot: [{ goto: titleCards }, { pause: 4000 }],
  },
  {
    id: "02-condition",
    say:
      "The condition, in evidence. Ninety percent of developers use A.I. " +
      "daily. Ninety six percent don't fully trust the output. Delivery " +
      "stability is still negative. Adoption won; discipline lost. Why? " +
      "Because the operating layer arrived as a dozen separate tools — " +
      "and when a sprawled layer fails, it fails with real credentials. " +
      "An agent violated an explicit freeze, deleted a production " +
      "database, then claimed recovery was impossible. The lie is the " +
      "scarier half. And the sprawl is worse than it looks, because every " +
      "layer exists twice: once for the agents that build your product, " +
      "and once for the agents that are your product. Two planes, one " +
      "spine, wins. And the economics: real deployment patterns are " +
      "finite. Enumerate them, encode them, and they run free. Spend the " +
      "best model only where the work is genuinely creative. That's the " +
      "condition, whole. Everything from here is APEX's answer.",
    shot: [
      { goto: visionDeck },
      { scroll: { to: 1, ms: 3500 } },
      { pause: 3500 },
      { scroll: { to: 2, ms: 3500 } },
      { pause: 3000 },
      { scroll: { to: 3, ms: 3500 } },
      { pause: 3000 },
      { scroll: { to: 4, ms: 3500 } },
      { pause: 3000 },
      { scroll: { to: 5, ms: 3500 } },
    ],
  },
  {
    id: "03-protocol",
    say:
      "First, the sprawl. Not a dozen tools — facets of one surface, on " +
      "one shared spine. The eval facet knows your infrastructure; the " +
      "infra facet knows your provenance. Then, the discipline. Every " +
      "change runs the same protocol: simulate, preview, gate, apply, " +
      "promote. Trying is free, and surprises are structurally " +
      "impossible, because the plan is previewed before it runs. Our own " +
      "instrumented history of agent work without this protocol reads " +
      "eighteen to one. When the story reaches a gate, motion stops — " +
      "one human decision, with the proof attached. Motion resumes. " +
      "Gates govern the change as it happens. Provenance remembers it " +
      "afterwards — and it can't be retrofitted. It has to be a birth " +
      "property: idea to ticket, ticket to change, change to release, " +
      "release to verdict.",
    shot: [
      { goto: `${BASE_URL}/pipelines` },
      { pause: 5000 },
      { wheel: { dy: 500, ms: 2500 } },
      { pause: 2500 },
      { goto: `${BASE_URL}/APEX/issues` },
      { pause: 5000 },
    ],
  },
  {
    id: "04-design-and-product-half",
    say:
      "Here is the part I'm proudest of. The design tab holds the " +
      "product's complete conception — forty six boards now, every " +
      "surface with a current and a target state, rendered by the " +
      "cockpit itself, offline, from a file committed in git. A draft is " +
      "an open pull request; approved means merged. The screen you're " +
      "looking at was designed through the loop it's part of — and that " +
      "loop has now closed, governed, twice. That was the engineering " +
      "half: can I trust the change? The product half answers the more " +
      "expensive question: was this worth building? Same primitives, one " +
      "level up. You bring one sentence. An agent shapes it into an " +
      "initiative that carries its assumptions, its budget, and its stop " +
      "condition — written before any work is funded, so stopping is a " +
      "decision made in advance.",
    // One board per page visit: the board render iframe goes blank in the
    // screencast after successive in-page board switches (verified by
    // probe), so each view gets a fresh goto + a single click.
    // Single design view for the whole beat: board renders are flaky under
    // screencast (only clicks followed by a waitText render reliably), and
    // the Initiatives target board carries the product-half narration while
    // the sidebar + header show the 46-board conception. The wheel pans the
    // board so the long hold reads as a live surface, not a still.
    shot: [
      { goto: `${BASE_URL}/APEX/design`, ready: "Shipped" },
      { click: { name: "Initiatives — assumptions, budget, stop conditions (target)", exact: true } },
      { waitText: "Initiatives, before the work starts" },
      { pause: 8000 },
      { wheel: { dy: 500, ms: 6000 } },
      { pause: 4000 },
    ],
  },
  {
    id: "05-finhh01-payoff",
    say:
      "Now run the machine once, for real, on that same sentence. Before " +
      "any work was funded, the shaping agent answered one assumption " +
      "from our own records: documents arrive nine days early. The " +
      "initiative was approved to milestone one only — two days " +
      "committed, not two weeks. The extraction ticket ran over two " +
      "hundred and fourteen real documents, with throwaway code that " +
      "never merges. And the finding that mattered wasn't the error " +
      "rate. It was a consent term that blocked the whole proactive " +
      "premise — and an evaluator proposed the rescope. Not a person. " +
      "Then, weeks of silence. No interruptions, because nothing needed " +
      "a decision. Silence is the system working. Week five: engagement " +
      "twenty two percent, against the thirty percent line written on " +
      "day one. The stop condition fires — the first interruption in " +
      "five weeks, carrying evidence and a proposal. You choose change, " +
      "not stop. An assumption tested once is never paid for twice.",
    shot: [
      { goto: `${BASE_URL}/FINP/observe`, ready: "Real observability" },
      { pause: 4000 },
      { wheel: { dy: 900, ms: 3000 } },
      { pause: 3000 },
      { goto: titleCards },
      { scroll: { to: 1, ms: 1500 } },
    ],
  },
  {
    id: "06-acceptance-test",
    say:
      "Which brings us to the honest part. This is Bloom — a live ed " +
      "tech product, seen through APEX. Nine services, all healthy. Two " +
      "thousand and one cloud resources across forty three types, " +
      "discovered live. In July, that number was twelve hundred and " +
      "twenty nine. It moved because the product moved. Nothing staged — " +
      "and nobody logged into anything. Switch companies: FinPilot. " +
      "Three services, one hundred and fifty three resources. Same " +
      "surface; zero extra setup beyond a binding. And notice what you " +
      "never did in this walkthrough: leave. Agents here are not just " +
      "observed — they're judged. Every run is traced, and evals score " +
      "the output, so trust is a measurement, not a feeling. That's why " +
      "we called it the cockpit: it controls your product plane, and " +
      "makes it soar.",
    shot: [
      { goto: `${BASE_URL}/BLOOM/observe`, ready: "Real observability" },
      { pause: 4000 },
      { wheel: { dy: 900, ms: 3000 } },
      { pause: 2500 },
      { wheel: { dy: 1400, ms: 3500 } },
      { pause: 4000 },
      { goto: `${BASE_URL}/FINP/observe`, ready: "Real observability" },
      { pause: 3500 },
      { goto: `${BASE_URL}/APEX/gateway`, ready: "Gateways" },
      { pause: 3000 },
    ],
  },
  {
    id: "07-close",
    say:
      "The vision is falsifiable on one sentence: pick a company, see " +
      "its entire plane, launch a ticket, and governed agents ship the " +
      "change — traceable at every hop. Here is exactly where that " +
      "stands. The companion deck to this film puts every facet's live " +
      "screenshot beside its target board. Today it reads eight live, " +
      "eight target — and that ratio is restated in every film, because " +
      "its movement is the proof. Since the last film, the design loop " +
      "closed governed twice, and the platform went public on the " +
      "Python package index. And the sentence you followed through this " +
      "film? It went in as an idea. It came back as evidence. Everything " +
      "you saw was built by one person, inside the loop you just " +
      "watched. What does a software company look like when finding out " +
      "is cheap? That's the question I want us to answer together.",
    shot: [
      { goto: juxDeck },
      { scroll: { to: 9, ms: 3500 } },
      { pause: 3000 },
      { scroll: { to: 17, ms: 4000 } },
      { pause: 5000 },
      { goto: titleCards },
      { scroll: { to: 2, ms: 1500 } },
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
    } else if (step.waitText) {
      // Heavy Penpot board renders can outlast a fixed pause — block the
      // hold until the board's own content is on screen.
      await page.getByText(step.waitText).first().waitFor({ timeout: 90_000 });
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
  // Site isolation must be off for recording: the Design tab's board render
  // is a cross-origin iframe, and CDP screencast records OOPIFs as blank
  // (page.screenshot composites them, which is why captures never showed it).
  const browser = await chromium.launch({
    args: ["--disable-site-isolation-trials", "--disable-features=IsolateOrigins,site-per-process"],
  });
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
  // Warm the Design tab's Penpot render too — the Initiatives board can
  // take >30s cold under recording load.
  await wp.goto(`${BASE_URL}/APEX/design`, { waitUntil: "load", timeout: 60_000 });
  await wp.getByText("Shipped").first().waitFor({ timeout: 60_000 });
  await wp.getByRole("button", { name: "Initiatives — assumptions, budget, stop conditions (target)", exact: true })
    .first().click({ timeout: 15_000 });
  await wp.getByText("Initiatives, before the work starts").first().waitFor({ timeout: 120_000 });
  console.log("pre-warmed design render");
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
