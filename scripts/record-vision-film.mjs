#!/usr/bin/env node
// Records the APEX vision film (v4) end to end, autonomously: neural TTS
// narration (Google Cloud Chirp3-HD), video via Playwright driving the
// LIVE cockpit and the committed decks, assembly via ffmpeg. Re-run it
// and the film is re-recorded against today's surfaces.
//
// Sync model: every beat is a list of SEGMENTS — one narration passage
// tied to one visual move. Each segment's audio is synthesized and
// measured first; during recording the segment's steps run exactly when
// its narration starts and the frame holds until that narration ends.
// The voice never talks about a slide the viewer isn't on.
//
// Diction: coined compounds are written speakably (v3's whisper heard
// "evalvertex" — classic TTS compound mangling).
//
// Usage: node scripts/record-vision-film.mjs [outDir]
//   COCKPIT_URL  base URL of the dev server (default http://localhost:3100)
//   VOICE        GCP voice name (default en-US-Chirp3-HD-Charon), or a
//                macOS voice name (no dash, e.g. "Samantha") for offline say
//   TTS_PROJECT  GCP project for TTS billing (default sarala-bloom-dev)

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { writeFileSync } from "node:fs";
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
const VOICE = process.env.VOICE ?? "en-US-Chirp3-HD-Charon";
const SPEAKING_RATE = Number(process.env.SPEAKING_RATE ?? "0.95");
const TTS_PROJECT = process.env.TTS_PROJECT ?? "sarala-bloom-dev";
const SIZE = { width: 1920, height: 1080 };
const juxDeck = `file://${path.join(docsRoot, "vision", "juxtaposition-deck.html")}`;
const visionDeck = `file://${path.join(docsRoot, "vision", "apex-product-vision-deck.html")}`;
const titleCards = `file://${path.join(docsRoot, "vision", "v4", "titlecards.html")}`;

// Deck-forward story cut, natural walkthrough tone. The juxtaposition
// deck is the skeleton (one page per facet, restated each film); the
// vision deck carries the condition; live surfaces prove nothing is
// staged; title cards carry the sentence. `do` steps fire when the
// segment's narration starts.
const BEATS = [
  {
    id: "01-cold-open",
    segments: [
      {
        say:
          "Every product begins as a sentence. Here is one of ours: tell " +
          "a household what's due this week. Keep hold of it — by the " +
          "end, you'll know exactly how a sentence like this is meant to " +
          "travel.",
        do: [{ goto: titleCards }],
      },
      {
        say:
          "This is APEX: the surface where a company's engineering runs. " +
          "Agents do the work, humans decide at gates, and every change " +
          "is traceable.",
        do: [],
      },
    ],
  },
  {
    id: "02-condition",
    segments: [
      {
        say:
          "First, the context, briefly. Ninety percent of developers use " +
          "A.I. daily, and ninety six percent don't fully trust what it " +
          "produces.",
        do: [{ goto: visionDeck }, { scroll: { to: 1, ms: 2000 } }],
      },
      {
        say:
          "The tooling that grew around this is a dozen separate " +
          "products, assembled by hand.",
        do: [{ scroll: { to: 2, ms: 2000 } }],
      },
      {
        say:
          "And a team needs that stack twice: once for the agents " +
          "building the product, and once for the agents inside the " +
          "product.",
        do: [{ scroll: { to: 4, ms: 2000 } }],
      },
      {
        say:
          "APEX starts from a simpler observation: real deployment " +
          "patterns are finite. They can be enumerated, encoded, and " +
          "made repeatable — and the expensive creative model is spent " +
          "only where the work is actually creative.",
        do: [{ scroll: { to: 5, ms: 2000 } }],
      },
    ],
  },
  {
    id: "03-facets-shipped",
    segments: [
      {
        say:
          "Here is how the product works today, facet by facet. Each " +
          "page pairs a screenshot of the running product with its " +
          "target design.",
        do: [{ goto: juxDeck }],
      },
      {
        say: "Home: agents, budgets, and pending approvals on one screen.",
        do: [{ scroll: { to: 1, ms: 1500 } }],
      },
      {
        say:
          "Work: a ticket board you'd recognize. GitHub issues flow in, " +
          "and promoting one makes it a governed ticket.",
        do: [{ scroll: { to: 2, ms: 1500 } }],
      },
      {
        say:
          "Observe: live discovery of everything a product owns in the " +
          "cloud — next to the target, where every card opens a " +
          "provenance thread.",
        do: [{ scroll: { to: 3, ms: 1500 } }],
      },
      {
        say:
          "Design: the product's complete conception. Forty six boards, " +
          "rendered from a file committed in git. A draft is an open " +
          "pull request; approval is a merge.",
        do: [{ scroll: { to: 4, ms: 1500 } }],
      },
      {
        say:
          "Gateway: every tool an agent touches goes through a governed " +
          "registry, and every call is audited.",
        do: [{ scroll: { to: 5, ms: 1500 } }],
      },
      {
        say:
          "Pipelines: the deterministic workflows that deploy all three " +
          "of our products.",
        do: [{ scroll: { to: 6, ms: 1500 } }],
      },
      {
        say: "Releases: APEX ships its own releases through them.",
        do: [{ scroll: { to: 7, ms: 1500 } }],
      },
      {
        say:
          "And costs: two budgets. Dollars for agent runs, and my " +
          "attention at the gates.",
        do: [{ scroll: { to: 8, ms: 1500 } }],
      },
    ],
  },
  {
    id: "04-live-proof",
    segments: [
      {
        say:
          "None of that is staged — here is the live surface behind " +
          "those pages. This is Bloom, an ed tech product in " +
          "development: nine services, and two thousand and one cloud " +
          "resources across forty three types, discovered live.",
        do: [{ goto: `${BASE_URL}/BLOOM/observe`, ready: "Real observability" }],
      },
      {
        say:
          "In July that number was twelve hundred and twenty nine. It " +
          "moves because the product moves.",
        do: [{ wheel: { dy: 2100, ms: 4000 } }],
      },
      {
        say:
          "Switch to FinPilot: three services, one hundred and fifty " +
          "three resources. Same surface, no setup beyond a binding — " +
          "and nobody logged into anything.",
        do: [{ goto: `${BASE_URL}/FINP/observe`, ready: "Real observability" }],
      },
    ],
  },
  {
    id: "05-product-half",
    segments: [
      {
        say:
          "The same primitives are designed to run one level up, on " +
          "ideas instead of code. The ambition, plainly: you arrive with " +
          "a sentence, and you walk out with an engineered, evaluated " +
          "product. An idea becomes an initiative that carries its " +
          "assumptions, its budget, and its stop condition — written " +
          "down before any work is funded.",
        do: [
          { goto: `${BASE_URL}/APEX/design`, ready: "Shipped" },
          { click: { name: "Initiatives — assumptions, budget, stop conditions (target)", exact: true } },
          { waitText: "Initiatives, before the work starts" },
        ],
      },
      {
        say:
          "Every gate offers four outcomes, and a person decides — never " +
          "the system. Budget is the circuit breaker. Say week five " +
          "reads twenty two percent engagement against the thirty " +
          "percent line you wrote on day one: the stop condition fires, " +
          "carrying evidence and a proposal, and you choose change, not " +
          "stop. Stopping was designed in advance — so finding out was " +
          "cheap.",
        do: [{ wheel: { dy: 500, ms: 4000 } }],
      },
      {
        say:
          "That whole journey — idea, initiative, tickets, agents, " +
          "evaluators, verdict — is drawn end to end as the product " +
          "loop, in the same target register as every other unbuilt " +
          "claim in this film.",
        do: [{ goto: juxDeck }, { scroll: { to: 12, ms: 2000 } }],
      },
    ],
  },
    {
    id: "06-honest-part",
    segments: [
      {
        say:
          "And the honest part: some facets are still designs. " +
          "Evaluation verdicts inside the cockpit.",
        do: [{ goto: juxDeck }, { scroll: { to: 9, ms: 1500 } }],
      },
      {
        say:
          "The capability registry, with its amendment gate and its " +
          "cascade from organization down to agent.",
        do: [{ scroll: { to: 10, ms: 1500 } }],
      },
      {
        say:
          "One screen onboarding. Each of these pages shows the target " +
          "board, and carries the ticket where the gap closes.",
        do: [{ scroll: { to: 11, ms: 1500 } }],
      },
      {
        say:
          "Behind them, the other journey pages — flows and gates, " +
          "initiatives, the loops — describe how it all connects.",
        do: [{ scroll: { to: 13, ms: 1500 } }],
      },
    ],
  },
  {
    id: "07-close",
    segments: [
      {
        say:
          "So the score today: eight facets live, eight still target. " +
          "We restate that number in every film, and its movement is the " +
          "measure. The sentence you followed is the ambition in " +
          "miniature: it goes in as an idea, and this machine is being " +
          "built so that it comes back as an engineered product, with " +
          "evidence attached. Everything you saw is real, and was built " +
          "by one person.",
        do: [{ goto: juxDeck }, { scroll: { to: 17, ms: 2000 } }],
      },
      {
        say:
          "What does a software company look like when finding out is " +
          "cheap? That's the question this product exists to answer.",
        do: [{ goto: titleCards }, { scroll: { to: 2, ms: 1200 } }],
      },
    ],
  },
];

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const probeDur = (file) =>
  parseFloat(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));

function gcpSynthesize(text, dest) {
  const token = sh("gcloud", ["auth", "print-access-token"]).trim();
  const body = JSON.stringify({
    input: { text },
    voice: { languageCode: "en-US", name: VOICE },
    audioConfig: { audioEncoding: "MP3", sampleRateHertz: 44100, speakingRate: SPEAKING_RATE },
  });
  const out = sh("curl", ["-sS", "--fail-with-body", "-X", "POST",
    "https://texttospeech.googleapis.com/v1/text:synthesize",
    "-H", `Authorization: Bearer ${token}`,
    "-H", `x-goog-user-project: ${TTS_PROJECT}`,
    "-H", "Content-Type: application/json",
    "-d", body]);
  const parsed = JSON.parse(out);
  if (!parsed.audioContent) throw new Error(`TTS response missing audio: ${out.slice(0, 300)}`);
  writeFileSync(dest, Buffer.from(parsed.audioContent, "base64"));
}

// Synthesize every segment, measure it, then concat per beat. Segment
// durations drive the recorder's timing, so slide moves land exactly
// where their sentences start. 0.5s of padding after each segment gives
// the narration natural breathing room.
async function synthesize() {
  const useGcp = VOICE.includes("-");
  for (const beat of BEATS) {
    const segFiles = [];
    for (const [i, seg] of beat.segments.entries()) {
      const raw = path.join(workDir, `${beat.id}.${i}.${useGcp ? "mp3" : "aiff"}`);
      const m4a = path.join(workDir, `${beat.id}.${i}.m4a`);
      if (useGcp) {
        // Fail loudly rather than fall back to the robotic offline
        // voice — a wrong-voice film is worse than no film.
        gcpSynthesize(seg.say, raw);
      } else {
        sh("say", ["-v", VOICE, "-o", raw, seg.say]);
      }
      sh("ffmpeg", ["-y", "-v", "error", "-i", raw, "-af", "apad=pad_dur=0.5",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", m4a]);
      seg.durationMs = Math.round(probeDur(m4a) * 1000);
      segFiles.push(m4a);
    }
    const list = path.join(workDir, `${beat.id}.audio.txt`);
    await fs.writeFile(list, segFiles.map((f) => `file '${f}'\n`).join(""));
    const beatAudio = path.join(workDir, `${beat.id}.m4a`);
    sh("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", beatAudio]);
    beat.durationMs = beat.segments.reduce((a, s) => a + s.durationMs, 0);
    console.log(`audio ${beat.id}: ${(beat.durationMs / 1000).toFixed(1)}s in ${beat.segments.length} segments`);
  }
}

async function runSteps(page, steps) {
  for (const step of steps) {
    if (step.goto) {
      await page.goto(step.goto, { waitUntil: "load", timeout: 60_000 });
      if (step.ready) await page.getByText(step.ready).first().waitFor({ timeout: 60_000 });
    } else if (step.waitText) {
      // Board renders paint late; block until the content is on screen.
      await page.getByText(step.waitText).first().waitFor({ timeout: 90_000 });
    } else if (step.click) {
      await page.getByRole("button", { name: step.click.name, exact: step.click.exact ?? false })
        .first().click({ timeout: 15_000 });
    } else if (step.scroll) {
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

async function record() {
  // Site isolation off: the Design tab's board render is a cross-origin
  // iframe and CDP screencast records OOPIFs as blank. Also: at most one
  // board click per page visit survives recording.
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
    // Hide dev-harness chrome only; the surfaces stay live and unstaged.
    await ctx.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent =
        '[data-testid="dev-restart-banner"],[data-testid="setup-startup-prompt"]{display:none !important}';
      document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
    });
    const page = await ctx.newPage();
    // Segment-locked pacing: each segment's steps start on its narration
    // cue; the frame then holds until that segment's audio would end.
    const t0 = Date.now();
    let cue = 0;
    for (const seg of beat.segments) {
      const behind = cue - (Date.now() - t0);
      if (behind > 0) await page.waitForTimeout(behind);
      await runSteps(page, seg.do);
      cue += seg.durationMs;
    }
    const remaining = cue + 600 - (Date.now() - t0);
    if (remaining > 0) await page.waitForTimeout(remaining);
    const video = page.video();
    await ctx.close();
    const dest = path.join(workDir, `${beat.id}.webm`);
    await fs.rename(await video.path(), dest);
    clips[beat.id] = dest;
    console.log(`clip ${beat.id}: recorded`);
  }
  await browser.close();
  return clips;
}

function assemble(clips) {
  const parts = [];
  for (const beat of BEATS) {
    const seg = path.join(workDir, `${beat.id}.mp4`);
    sh("ffmpeg", ["-y", "-v", "error",
      "-i", clips[beat.id], "-i", path.join(workDir, `${beat.id}.m4a`),
      "-map", "0:v:0", "-map", "1:a:0", "-t", (beat.durationMs / 1000).toFixed(3),
      "-vf", "scale=1920:1080,fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", seg]);
    parts.push(seg);
    console.log(`segment ${beat.id}: muxed`);
  }
  const list = path.join(workDir, "concat.txt");
  writeFileSync(list, parts.map((p) => `file '${p}'\n`).join(""));
  const final = path.join(outDir, "apex-vision-v4.mp4");
  sh("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", final]);
  return final;
}

async function main() {
  const probe = await fetch(`${BASE_URL}/`).catch(() => null);
  if (!probe?.ok) throw new Error(`Cockpit not reachable at ${BASE_URL} — start pnpm dev:once first.`);
  await fs.mkdir(workDir, { recursive: true });

  // Pre-warm: observe panes (cold inventory scans take ~30s) and the
  // Design tab's board render.
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
  await wp.goto(`${BASE_URL}/APEX/design`, { waitUntil: "load", timeout: 60_000 });
  await wp.getByText("Shipped").first().waitFor({ timeout: 60_000 });
  await wp.getByRole("button", { name: "Initiatives — assumptions, budget, stop conditions (target)", exact: true })
    .first().click({ timeout: 15_000 });
  await wp.getByText("Initiatives, before the work starts").first().waitFor({ timeout: 120_000 });
  console.log("pre-warmed design render");
  await warm.close();

  await synthesize();
  const clips = await record();
  const final = assemble(clips);

  const total = probeDur(final);
  await fs.writeFile(path.join(outDir, "narration-v4.txt"),
    BEATS.map((b) => `[${b.id}]\n${b.segments.map((s) => s.say).join("\n")}\n`).join("\n"));
  await fs.writeFile(path.join(outDir, "PROVENANCE.md"),
    `# apex-vision-v4 — provenance\n\nGenerated ${new Date().toISOString()} by ` +
    `cockpit scripts/record-vision-film.mjs (TTS ${VOICE} @ rate ${SPEAKING_RATE}; ` +
    `segment-locked sync; Playwright against ${BASE_URL}; decks from apex-docs vision/).\n` +
    `Total ${total.toFixed(1)}s across ${BEATS.length} beats / ` +
    `${BEATS.reduce((a, b) => a + b.segments.length, 0)} segments. Fully re-recordable: ` +
    `re-run the script and the film shows that day's surfaces.\n`);
  console.log(`\nfinal: ${final} (${total.toFixed(1)}s)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
