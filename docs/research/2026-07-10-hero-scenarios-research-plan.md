# Hero-scenario research plan — agent-dealer + agent-deck

**Status:** ready to execute · **Date:** 2026-07-10
**Goal:** Find 3–5 hero user scenarios for the combined agent-dealer + agent-deck story, grounded in real demand evidence — for (a) product conviction about which scenarios to bet the narrative on, and (b) direct reuse in README / landing page / launch-post copy aimed at potential adopters.
**Method:** Demand-signal triangulation — mine real users' pain in their own words, map the competitive positioning landscape, use market/funding data only as a sizing signal, then synthesize scenarios scored against our actual differentiators.

---

## How to run this plan

Four phases, each a **self-contained prompt** for a fresh Claude session with web search. For every phase: paste **§0 (shared context)** first, then the phase prompt.

| Phase | Model | Depends on | Save output as |
|-------|-------|-----------|----------------|
| 1. Pain mining | Sonnet | — | `docs/research/outputs/phase1-pain-inventory.md` |
| 2. Competitor positioning | Sonnet | — | `docs/research/outputs/phase2-positioning-map.md` |
| 3. Market evidence | Sonnet | — | `docs/research/outputs/phase3-market-evidence.md` |
| 4. Synthesis | Opus | 1 + 2 + 3 | `docs/research/outputs/phase4-hero-scenarios.md` |

Phases 1–3 are independent — run them in parallel sessions if you like. Phase 4 needs the three output files pasted or attached.

**Quality bar for accepting a phase output:** every factual claim has a URL; quotes are verbatim; the output follows the requested format. If a phase comes back thin (fewer quotes/products/data points than its target), re-run it with the "go deeper" note at the end of its prompt rather than accepting a weak base.

---

## §0 — Shared context block (paste first in every session)

```text
You are doing product research for two sibling open-source products built by a solo
developer. Understand them precisely before searching.

PRODUCT 1 — agent-dealer: the human control plane for agent execution.
Workflow: Feed (tasks from Linear or manual entry) → agent drafts a plan → HUMAN
APPROVES PLAN → agent executes headlessly (Claude Code `claude -p` or Cursor CLI,
with per-phase tool allowlists and budget caps like 30 turns / $5) → HUMAN REVIEWS
RESULT (approve done / retry with feedback). Outbound actions (Slack message, email,
ticket update) are never sent by the agent — the human sees the exact payload and
approves the send. Everything is stored as an audit trail ("treasure"): task → plan
→ execution trace → feedback. Design principle: optimize overnight/unattended
THROUGHPUT with human gates, not sub-minute latency.

PRODUCT 2 — agent-deck: the context hub for agents. A "deck" bundles MCP servers
(Slack, Linear, etc.), credentials, and "playbooks" (reusable task recipes /
checklists). Binding a workspace to a deck gives any agent the right tools and
know-how for that project. Solves "what should this agent know and have access to."

COMBINED STORY: deck = what the agent knows; dealer = what runs next, when, with
what human gates, and what we learned. Target users: developers AND business/
knowledge workers who delegate repeatable work (code tickets, Slack triage, email
drafts, research briefs, doc/content generation) but want approval and audit control.

DIFFERENTIATORS to keep in mind (scenarios will later be scored against these):
D1 human-approved plans before any execution
D2 result review + human-gated outbound sends (nothing leaves without approval)
D3 full audit trail: task → plan → trace → feedback, queryable later
D4 reusable context: decks + playbooks make the Nth similar task cheap
D5 hard budget/tool caps per run (turns, dollars, allowlisted tools)
D6 queue orientation: batch many tasks, let them run overnight, review in the morning

EVIDENCE STANDARDS (apply to everything you report):
- Verbatim quotes only, with source URL and date. Never paraphrase a person's pain.
- First-person pain only: the person experiencing the problem, not a journalist or
  vendor describing it.
- Prefer sources from the last 12 months (July 2025 onward); flag anything older.
- A pain counts as a THEME only with 3+ independent sources (different authors).
- Record who the person appears to be (solo dev, eng lead, PM, founder, ops/marketing,
  academic, unknown).
```

---

## §1 — Phase 1 prompt: pain mining

````text
TASK: Build a pain inventory — real people describing, in their own words, problems
that the products above could solve. You are looking for pain, not for mentions of
our products (nobody knows them yet).

SEARCH THEMES (seed queries — expand with your own variants):
T1 Queueing / overnight runs: "run claude code overnight", "queue tasks for AI
   agent", "batch agent tasks", "agent while I sleep", cron + claude/cursor
T2 Trust & review: "can't trust agent output", "AI agent made changes I didn't
   want", "review every agent PR", "agent sent wrong message"
T3 Approval gates: "human in the loop agent", "approve before agent executes",
   "agent approval workflow"
T4 Repeated context setup: "re-explain context to agent every time", "agent
   forgets my conventions", "same prompt setup every session", MCP config pain
T5 Audit & accountability: "log what the AI agent did", "audit trail for AI",
   "who approved this agent action", AI compliance for small teams
T6 DIY orchestration hacks: people describing homegrown scripts around claude -p /
   cursor CLI / aider — cron jobs, task queues, tmux farms, custom dashboards.
   THIS IS THE STRONGEST SIGNAL: they wanted the product badly enough to build a
   worse version themselves.
T7 Cost anxiety: "agent burned tokens", "runaway agent cost", budget caps
T8 Non-developer delegation: ops/marketing/founders wanting to hand off Slack
   triage, email drafts, research briefs, reports to an agent — but blocked by
   trust or setup effort.

SOURCES & TACTICS:
- Hacker News via hn.algolia.com — search the phrases above; also read comment
  threads on agent-orchestration launch posts (Show HN for Devin/OpenHands-type
  tools), where commenters state what they actually want.
- Reddit: r/ClaudeAI, r/ClaudeCode, r/cursor, r/ChatGPTCoding, r/LocalLLaMA,
  r/singularity, r/Entrepreneur, r/productivity (site:reddit.com queries).
- GitHub: issues/discussions on claude-code, aider, OpenHands, CrewAI, AutoGen —
  especially feature requests for queues, approvals, review gates, audit logs.
- Cursor community forum; Anthropic Discord summaries if surfaced on the web.
- X/Twitter posts and personal blog posts ("my agent workflow", "how I run N
  agents in parallel").

OUTPUT FORMAT (markdown):
1. Pain inventory table — one row per quote:
   | # | Theme (T1–T8 or NEW) | Verbatim quote (trimmed ok, no rewording) |
   | Persona | Source URL | Date | Intensity |
   Intensity: HIGH = built a DIY hack or actively searched for a tool;
   MED = complained with specifics; LOW = passing remark.
2. Theme summary — for each theme with 3+ independent sources: 2–3 sentence
   synthesis of the pain in your words + count of quotes + persona mix.
3. Surprises — pains you found that don't fit T1–T8 (mark theme NEW).
4. Anti-signals — evidence AGAINST our assumptions (e.g. people happy with
   full autonomy, or who reject approval gates as friction). Do not skip this.

TARGETS: 30–50 quotes total; every theme either reaches 3+ sources or is
explicitly marked "insufficient evidence". If under target, go deeper: follow
comment threads, not just top-level posts, and search non-obvious phrasings
("babysitting the agent", "agent PR review fatigue", "context rot").
````

---

## §2 — Phase 2 prompt: competitor positioning scan

````text
TASK: Map how existing products position agent orchestration/delegation — which
hero scenario each one leads with, for whom — so we can find positioning white
space. This is a POSITIONING scan (their websites, launch posts, docs intros),
not a feature-matrix teardown.

PRODUCTS (add any relevant ones you discover; note discoveries):
Coding agents/orchestrators: Devin (Cognition), Factory.ai, OpenHands,
Cursor background agents, Claude Code (headless/GitHub Actions), GitHub Copilot
coding agent, Jules (Google), Codegen, Vibe Kanban, Conductor, Sweep, aider.
Workflow/business agents: n8n, Lindy, Relay.app, Gumloop, Zapier agents,
Dust.tt, Respell.
Frameworks positioning to end users: CrewAI, LangGraph (LangChain), AutoGen/
Microsoft Agent Framework.

FOR EACH PRODUCT record:
| Product | One-line positioning (their words, quoted from site/launch) |
| Hero scenario they lead with | Target persona | Human-in-the-loop story
(none / review-after / approval-before / configurable gates) | Audit/trace story |
Reusable-context story (templates/playbooks/memory) | Pricing model | Source URLs |

THEN ANALYZE:
1. Positioning clusters — group products by the story they tell (e.g. "autonomous
   engineer", "workflow automation", "agent framework"). 2–3 sentences each.
2. Crowded ground — scenarios 3+ products already lead with (we should NOT
   position there head-on).
3. White space — combinations nobody leads with, judged against our
   differentiators D1–D6. Hypothesis to test honestly: "human-gated overnight
   throughput + audit trail + reusable playbooks" is unowned. Confirm or refute;
   if some product DOES own part of it, say so plainly and cite it.
4. Borrowable language — phrases from their copy that demonstrably resonate
   (heavily quoted in launch threads / testimonials), as style reference only.

TARGET: all listed products covered (mark dead/pivoted ones as such) + at least
3 self-discovered additions. If a product's positioning is unclear, quote their
homepage hero text verbatim and say "unclear" rather than guessing.
````

---

## §3 — Phase 3 prompt: market evidence

````text
TASK: Gather demand-SIZING evidence for these pain themes:
T1 queueing/overnight agent runs · T2 trust & review of agent output ·
T3 approval gates / human-in-the-loop · T4 repeated context setup ·
T5 audit & accountability · T6 DIY orchestration hacks · T7 agent cost anxiety ·
T8 non-developer delegation (Slack triage, email drafts, research briefs).
This phase answers "is this pain big and growing?" — it does NOT supply story
material. Funded startups' claimed
use cases reflect what pitches to VCs, not what makes an individual adopt, so
treat them strictly as a signal that money believes the pain is real.

SOURCES:
1. Funding activity (last 18 months): YC company directory (W25/S25/W26 batches,
   tags: agents, developer-tools, automation), TechCrunch/Crunchbase funding
   announcements for agent orchestration / agent infrastructure / AI workflow
   startups. For each relevant startup: name, round + amount + date, one-line
   pitch, which theme(s) T1–T8 it maps to, URL.
2. Usage research: Anthropic Economic Index reports (what work agents actually
   do; automation vs augmentation split), OpenAI/Google equivalents if public.
3. Developer surveys: Stack Overflow AI survey, DORA/State of DevOps AI findings,
   JetBrains dev ecosystem survey — adoption rates, stated blockers (trust,
   review burden, cost).
4. Adoption proxies: GitHub star/download trajectories for open-source
   orchestrators (OpenHands, CrewAI, aider, n8n), npm/pypi download trends where
   findable.

OUTPUT FORMAT (markdown):
1. Funding table as specified above (target: 15–25 relevant startups).
2. Per-theme demand notes — for each T1–T8: what the funding + survey + usage
   data says about size and growth, 3–5 sentences, every claim cited. End each
   with a verdict: STRONG / MODERATE / WEAK / NO SIGNAL.
3. Timing evidence — anything supporting "why now" (model capability jumps,
   enterprise AI-governance requirements, agent-cost trends).
4. Caveats — where the data is thin or the mapping from startup pitch to theme
   is a stretch. Honesty over completeness.
````

---

## §4 — Phase 4 prompt: synthesis into hero scenarios

Attach/paste the three phase outputs after the prompt.

````text
TASK: Synthesize the three attached research outputs into 3–5 HERO SCENARIOS for
the combined agent-dealer + agent-deck story. A hero scenario is a concrete,
evidence-backed narrative that makes a specific person think "that's exactly my
pain" — it will drive README, landing page, and launch-post copy, and it must be
one the founder can believe in.

STEP 1 — Generate candidates (8–12). Start from PAIN THEMES in the Phase 1
inventory — never from product features. For each candidate: one sentence,
persona + trigger moment + desired outcome. Include at least 2 non-developer
candidates (business/knowledge work) if the evidence supports any.

STEP 2 — Score every candidate 1–5 on each dimension, in a table, with a
one-line justification per score:
  S1 Pain evidence — quote count × intensity from Phase 1 (5 = many HIGH-
     intensity quotes incl. DIY hacks; 1 = speculative)
  S2 Differentiation — does winning this scenario NEED D1–D6, and is it white
     space per Phase 2? (5 = unowned + plays to 3+ differentiators; 1 = crowded
     ground where we'd be a me-too)
  S3 Market signal — Phase 3 verdict for the underlying theme(s)
  S4 Demo-ability — can the current v0 show it convincingly in a 2-minute
     screen recording? (feed → plan approval → overnight execution → morning
     review; Linear + manual tasks; Claude Code/Cursor runtimes; gated sends)
  S5 Both-products fit — does the story genuinely need deck context/playbooks
     AND dealer gates/queue? (5 = amputating either product breaks the story)

STEP 3 — Select 3–5 winners. State why each won and name the strongest
runner-up you cut and why.

STEP 4 — Write a HERO SCENARIO CARD for each winner:
- Name — short, memorable ("Morning review of the overnight queue")
- Persona & trigger — who, and the moment the pain bites
- Narrative — 150–250 words walking the full product loop: task feed → deck/
  playbook context → plan approval → capped execution → result review →
  gated send → audit treasure. Concrete nouns (real-sounding tickets, real
  channels), no marketing adjectives.
- Why us — which differentiators D1–D6 carry it, and why competitors' framing
  (from Phase 2) doesn't cover it
- Evidence — 3+ verbatim quotes with URLs from Phase 1; market signal one-liner
  from Phase 3
- Copy hooks — 3 one-liner drafts usable as a README tagline or landing headline
- Demo sketch — beats of a 2-minute screen recording
- Falsifier — what evidence, if it appeared, would kill this scenario

STEP 5 — Contradictions & anti-signals. Summarize the Phase 1 anti-signals and
any Phase 2/3 findings that argue AGAINST the winners. Do not sand these off —
the founder needs them for conviction, not just cheerleading.
````

---

## After Phase 4

1. Founder review: do the winners survive your own judgment? Any scenario you can't personally retell with conviction gets cut regardless of score.
2. Convert winning cards into copy: README one-liner + scenario section, landing draft, launch post — each card already contains the hooks and narrative.
3. Optional validation loop: post one scenario narrative where its persona lives (HN comment, subreddit) and watch whether real people self-identify — cheapest possible test before building the full site around it.
