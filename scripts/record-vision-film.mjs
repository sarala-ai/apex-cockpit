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
// FILM_CUT=full (default) renders the master with every segment;
// FILM_CUT=short derives the trim by skipping fullOnly segments.
// The master is the source of truth — trims are derived, never rebuilt.
const FILM_CUT = process.env.FILM_CUT ?? "full";
const SIZE = { width: 1920, height: 1080 };
const juxDeck = `file://${path.join(docsRoot, "vision", "juxtaposition-deck.html")}`;
const visionDeck = `file://${path.join(docsRoot, "vision", "apex-product-vision-deck.html")}`;
const titleCards = `file://${path.join(docsRoot, "vision", "v4", "titlecards.html")}`;
const filmStrip = `file://${path.join(docsRoot, "vision", "v4", "filmstrip.html")}`;

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
          "Product development is not writing code. It is the whole " +
          "lifecycle: an idea becomes a design, a build, a test, a " +
          "shipped change, a running service — and an evaluated result. " +
          "A tool that helps with one stage leaves the rest on you.",
        do: [{ scroll: { to: 1, ms: 1200 } }],
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
        fullOnly: true,
        say:
          "And when a sprawled layer fails, it fails with real " +
          "credentials. An agent violated an explicit freeze, deleted a " +
          "production database, then claimed recovery was impossible — " +
          "the lie is the scarier half.",
        do: [{ scroll: { to: 3, ms: 2000 } }],
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
          "And creative prices are being paid for clerk work — the " +
          "expensive model belongs only where the work is actually " +
          "creative.",
        do: [{ scroll: { to: 5, ms: 2000 } }],
      },
      {
        say:
          "And I didn't need the surveys. I run three products alone — " +
          "with agents on every one. I assembled that dozen tool layer " +
          "by hand, twice. When I instrumented my own agent work before " +
          "gates existed, improvised actions outnumbered governed ones " +
          "eighteen to one. And releases shipped by hand, at night. " +
          "APEX is what that experience demanded.",
        do: [{ goto: titleCards }, { scroll: { to: 2, ms: 1200 } }],
      },
      {
        say:
          "It starts from a simple observation: real deployment " +
          "patterns are finite. They can be enumerated, encoded, and " +
          "made repeatable. Everything from here is the answer.",
        do: [{ goto: visionDeck }, { scroll: { to: 6, ms: 2000 } }],
      },
    ],
  },
  {
    id: "03-facets-shipped",
    segments: [
      {
        say:
          "Here is the product itself, facet by facet — the running " +
          "surface first, then the target board it is built toward.",
        do: [{ goto: filmStrip }],
      },
      {
        say:
          "Home, for the APEX company itself: five agents enabled, " +
          "seventy eight open tasks, eighty approvals waiting on board " +
          "review, and this month's agent spend — all on one screen.",
        do: [],
      },
      {
        say:
          "The target home is the multi company cockpit: three " +
          "companies, twelve governed agents, and a live ticket queue " +
          "where every ticket shows the stage it's in and the gate it's " +
          "waiting on.",
        do: [{ scroll: { to: 1, ms: 900 } }],
      },
      {
        say:
          "Work is a board you'd recognize: backlog through done, real " +
          "tickets with identifiers, priorities, and blocked and done " +
          "columns you can read at a glance.",
        do: [{ scroll: { to: 2, ms: 900 } }],
      },
      {
        say:
          "The target adds the stage rail on the ticket itself, and the " +
          "cycle above the board — budgets in place of standups.",
        do: [{ scroll: { to: 3, ms: 900 } }],
      },
      {
        say:
          "Observe is Bloom's live plane: the whole service fleet with " +
          "health per service, evals, and recent runs on one page.",
        do: [{ scroll: { to: 4, ms: 900 } }],
      },
      {
        say:
          "Its target draws the north star: availability, latency, eval " +
          "pass rate and cost per run as scorecards — and beneath them, " +
          "one thread from resource, to service, to run, to verdict. " +
          "Every arrow is a provenance edge.",
        do: [{ scroll: { to: 5, ms: 900 } }],
      },
      {
        say:
          "Design renders the product's complete conception: forty six " +
          "boards across ten planes, drawn from the file committed in " +
          "git. A draft is an open pull request; approval is a merge.",
        do: [{ scroll: { to: 6, ms: 900 } }],
      },
      {
        say:
          "The target puts the design gate inline: a board diff, " +
          "derived from an approved spec, waiting on one human decision " +
          "— approve, or request changes.",
        do: [{ scroll: { to: 7, ms: 900 } }],
      },
      {
        say:
          "The gateway reads what is actually federated: the design " +
          "tool's own server, with its four tools — export, inspection, " +
          "overview, and code execution — every call audited.",
        do: [{ scroll: { to: 8, ms: 900 } }],
      },
      {
        say:
          "Its target grows that registry into the full capability " +
          "plane an agent can be granted.",
        do: [{ scroll: { to: 9, ms: 900 } }],
      },
      {
        say:
          "Pipelines are typed lifecycles, not scripts: the ticket " +
          "lifecycle, bug, design change, and feature — each with its " +
          "own gates and a live review queue; thirty four waiting in " +
          "bug alone.",
        do: [{ scroll: { to: 10, ms: 900 } }],
      },
      {
        say:
          "And when something is wrong, this is the discipline: a " +
          "deploy step holding — every prior gate approved, and the " +
          "hold explains exactly what to fix. It holds the stage. It " +
          "never silently fails.",
        do: [{ scroll: { to: 11, ms: 900 } }],
      },
      {
        say:
          "The gate arithmetic is designed down to the worst case: a " +
          "chore has zero gates, because C.I. is the gate. A bug has " +
          "one, because the failing test is the spec. A feature has " +
          "three, and the spec gate pre approves every task derived " +
          "from it. Twenty tasks unattended is the design — an " +
          "interruption that carries no decision is spam.",
        do: [{ scroll: { to: 12, ms: 900 } }],
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
        do: [
          { wheel: { dy: 2100, ms: 4000 } },
          { caption: "July 2026: 1,229 resources · today: discovered live" },
        ],
      },
      {
        say:
          "Switch to FinPilot: three services, one hundred and fifty " +
          "three resources. Same surface, no setup beyond a binding — " +
          "and nobody logged into anything.",
        do: [
          { goto: `${BASE_URL}/FINP/observe`, ready: "Real observability" },
          { wheel: { dy: 2100, ms: 4000 } },
          { caption: "no login — local APEX trusts this machine; operator identity from gcloud" },
        ],
      },
      {
        fullOnly: true,
        say:
          "And APEX observes itself the same way. Version zero point " +
          "nine is public on the Python package index — released " +
          "through its own workflow engine, with its own C.I. watched " +
          "on this same surface. We eat the discipline we sell.",
        do: [
          { goto: `${BASE_URL}/APEX/observe`, ready: "Real observability" },
          { caption: "apex-core 0.9.0 · pip install apex-core — released through its own pipeline" },
        ],
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
        do: [{ goto: filmStrip }, { scroll: { to: 16, ms: 1200 } }],
      },
    ],
  },
    {
    id: "06-honest-part",
    segments: [
      {
        say:
          "Now the honest part — what is still a board. Eval verdicts: " +
          "a run scored against its own checklist, passed at point " +
          "eight seven, with the evaluator named and versioned. Trust " +
          "as a measurement. Not shipped yet.",
        do: [{ goto: filmStrip }, { scroll: { to: 13, ms: 1200 } }],
      },
      {
        say:
          "The registry's amendment gate: an evaluator reads fourteen " +
          "runs, finds the failure pattern, and proposes the charter " +
          "change itself — which then passes the same approve or send " +
          "back gate as any other change. The cascade down from " +
          "organization to agent carries its own tickets.",
        do: [{ scroll: { to: 14, ms: 1200 } }],
      },
      {
        say:
          "And onboarding: a second product joins as one binding " +
          "record — twelve skills and three pipelines inherited " +
          "automatically. One configuration, not a second " +
          "infrastructure.",
        do: [{ scroll: { to: 15, ms: 1200 } }],
      },
      {
        fullOnly: true,
        say:
          "Behind the facets, the journeys. The learning loop draws " +
          "what compounds: every closed ticket deposits capability " +
          "back — a skill, a workflow, a prompt, a distilled doc — " +
          "into one registry that cascades from organization down to " +
          "agent. The next ticket starts further ahead.",
        do: [{ scroll: { to: 17, ms: 1200 } }],
      },
      {
        fullOnly: true,
        say:
          "And the loop, closed — the small team practice: six " +
          "stations, every ticket compounding. No platform team to " +
          "hire, gates in place of meetings, provenance in place of " +
          "onboarding, and cost per ticket visible. It is why one " +
          "founder can run three products.",
        do: [{ scroll: { to: 18, ms: 1200 } }],
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
          "evidence attached. And as the card says: everything you saw " +
          "is real, built by one person, inside this loop.",
        do: [{ goto: filmStrip }, { scroll: { to: 19, ms: 1500 } }],
      },
      {
        say:
          "What does a software company look like when finding out is " +
          "cheap? That's the question this product exists to answer.",
        do: [{ goto: titleCards }, { scroll: { to: 4, ms: 1200 } }],
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
  if (FILM_CUT === "short") {
    for (const beat of BEATS) beat.segments = beat.segments.filter((s) => !s.fullOnly);
  }
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

async function runSteps(page, steps, segStart, segDurationMs) {
  for (const step of steps) {
    if (step.cue !== undefined) {
      const at = segStart + segDurationMs * step.cue;
      const wait = at - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      continue;
    }
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
    } else if (step.caption) {
      await page.evaluate((text) => {
        let el = document.getElementById("film-caption");
        if (!el) {
          el = document.createElement("div");
          el.id = "film-caption";
          el.style.cssText =
            "position:fixed;left:2rem;bottom:2rem;z-index:99999;" +
            "background:rgba(11,12,14,0.92);color:#e8eaed;" +
            "border:1px solid #26292e;border-left:3px solid #34d399;" +
            "border-radius:6px;padding:0.6rem 1rem;" +
            "font:500 15px -apple-system,sans-serif";
          document.body.appendChild(el);
        }
        el.textContent = text;
      }, step.caption);
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
      await runSteps(page, seg.do, t0 + cue, seg.durationMs);
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
  const final = path.join(outDir, FILM_CUT === "short" ? "apex-vision-v4-short.mp4" : "apex-vision-v4.mp4");
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
