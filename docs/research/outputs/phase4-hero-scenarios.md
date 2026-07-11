# Phase 4 — Hero Scenarios (synthesis)

**Date run:** 2026-07-10 · **Model:** Opus · **Inputs:** phase1-pain-inventory.md, phase2-positioning-map.md, phase3-market-evidence.md
**Purpose:** 3–5 evidence-backed hero scenarios for the combined agent-dealer + agent-deck story, for direct reuse in README / landing / launch copy — and for founder conviction.

**Scoring discipline applied (per synthesis notes):** S1 (pain evidence, from Phase 1) and S3 (market signal, from Phase 3) are scored **independently**. Where Phase 1 marked a theme's first-person pain *insufficient* (T5 audit, T8 non-developer delegation) but Phase 3 rated the same theme's market signal *STRONG*, the two scores diverge on purpose and are not reconciled. A strong market signal does not license a high pain score, and vice versa.

---

## Step 1 — Candidates (11)

Generated from Phase 1 pain themes, never from product features. Each is persona + trigger moment + desired outcome. Two are non-developer candidates (C9, C10).

- **C1 — Morning review of the overnight queue.** *(T1 + T6)* A solo dev prepping tasks before bed wants to load a batch, walk away without babysitting permission prompts, and review finished work over coffee instead of watching it run.
- **C2 — The send that never should have gone out.** *(NEW-1 blast radius + T3)* Anyone whose agent can touch Slack/email/tickets wants the exact outbound payload held for one human OK, because a single wrong message or irreversible action is categorically worse than a bad diff.
- **C3 — Retire the babysitting rig.** *(T6)* A power user who already duct-taped a queue + Telegram-approval + cron + dashboard around `claude -p` wants to throw the bespoke rig away for one tool that does queue + gate + caps + trace properly.
- **C4 — Approve the plan and the budget before a dollar is spent.** *(T3 + T7)* A freelancer/agency dev who bills AI cost to a client wants to see the plan and a hard cap *before* execution, so "run first, see cost later" stops being the only option.
- **C5 — The audit treasure.** *(T5)* A solo founder / small-team lead who just had an agent incident (or an EU-AI-Act deadline) wants task → plan → trace → feedback stored and queryable, so "who approved this and why" has an answer.
- **C6 — Stop drowning the reviewer.** *(T2 + NEW-2)* An OSS maintainer / lead buried under agent-generated PRs wants a plan-approval gate *before* execution to cut the volume of unreviewed output reaching a human, not just another after-the-fact review tool.
- **C7 — Hard ceiling before the runaway.** *(T7 + D5)* An engineer who has watched an agent burn thousands overnight wants a turn/dollar cap that halts the run, not a bill that arrives after the money is gone.
- **C8 — Stop re-explaining the project.** *(T4)* A dev re-stuffing 50k tokens of project context into every session wants a bound deck of MCP tools + credentials + playbooks so the Nth similar task is cheap.
- **C9 — Gated Slack triage / email drafts for the non-developer.** *(T8)* An ops/marketing operator wants an agent to draft the triage reply or the follow-up email, but hold the send for their approval and log what happened.
- **C10 — One queue for dev tickets *and* business tasks.** *(bundle)* A founder wearing both hats wants code tickets and Slack/research/doc tasks in a single gated queue with one review surface.
- **C11 — Adversarial review before merge.** *(T2)* A dev who built a second "critic" agent wants quality-checking baked into the loop instead of hand-rolled.

---

## Step 2 — Scoring (1–5, with one-line justification)

Dimensions: **S1** Pain evidence (Phase 1 quote count × intensity) · **S2** Differentiation (needs D1–D6 + white space per Phase 2) · **S3** Market signal (Phase 3 verdict for underlying theme) · **S4** Demo-ability in current v0 · **S5** Both-products fit (deck AND dealer).

| # | Candidate | S1 | S2 | S3 | S4 | S5 | Σ |
|---|-----------|----|----|----|----|----|----|
| **C1** | Morning review of the overnight queue | **5** | **4** | **5** | **5** | **4** | **23** |
| **C2** | The send that never should have gone out | **4** | **5** | **4** | **5** | **5** | **23** |
| **C3** | Retire the babysitting rig | **5** | **4** | **3** | **5** | **5** | **22** |
| **C4** | Approve the plan and the budget before a dollar is spent | **5** | **4** | **3** | **4** | **4** | **20** |
| C5 | The audit treasure | 2 | 5 | 5 | 4 | 4 | 20 |
| C6 | Stop drowning the reviewer | 4 | 3 | 5 | 3 | 3 | 18 |
| C7 | Hard ceiling before the runaway | 5 | 3 | 3 | 4 | 3 | 18 |
| C8 | Stop re-explaining the project | 4 | 3 | 3 | 3 | 4 | 17 |
| C9 | Gated Slack triage / email drafts (non-dev) | 2 | 4 | 4 | 3 | 4 | 17 |
| C10 | One queue for dev + business | 2 | 5 | 3 | 3 | 5 | 18 |
| C11 | Adversarial review before merge | 3 | 2 | 5 | 3 | 2 | 15 |

**Per-score justifications**

**C1 — S1 5:** many HIGH quotes incl. two DIY tools (benterix "overnight almost exclusively," starsh2001's *qlaude*, jshchnz's Claude Code Scheduler, Renner's 47-commit night). **S2 4:** "runs while you sleep" is crowded (Phase 2 §2 lists 6+ products), but the *morning-review* half + plan gate + caps is unclaimed — Phase 2 notes nobody's copy foregrounds it. **S3 5:** T1 = STRONG. **S4 5:** this *is* the v0 loop (feed → plan approval → capped execution → morning review). **S5 4:** dealer queue is essential; deck playbooks make the batch repeatable but the story limps rather than breaks without them.

**C2 — S1 4:** NEW-1 blast-radius quotes are HIGH (0xShyam Slack experiment #47, un-flagged) plus strong T3 (Kevin_Neilson #10) and pritesh_ghodge #20; docked one point because two of the most dramatic NEW-1 rows (#48 Railway, #49) are flagged sub-verbatim and not leaned on. **S2 5:** a *separate* gate on outbound sends as a distinct second checkpoint is unowned — n8n/Relay/Lindy own generic "approval-before-action," none isolate the send for both dev and business; plays D2/D1/D3. **S3 4:** no single Phase 3 verdict for NEW-1; rests on T3 (MODERATE) + governance pull (T5 STRONG, EU AI Act). **S4 5:** v0 shows the exact payload held for approve-send. **S5 5:** deck supplies the Slack/Linear/email MCP + credentials; dealer gates the send — amputate either and the story collapses.

**C3 — S1 5:** T6 is the single best-evidenced theme in Phase 1; multiple built rigs (qlaude, scheduler, dashboards, circuit breaker, claim-locks). **S2 4:** DIY-orchestration has productizers (Conductor, Superset, Vibe Kanban—sunsetting), but the gate + caps + audit + playbook *bundle* they replace is unowned. **S3 3:** T6 = MODERATE (strong OSS/community signal, no venture-scale winner; Vibe Kanban shut down). **S4 5:** directly demoable. **S5 5:** needs both queue/gates *and* reusable context to beat the rig.

**C4 — S1 5:** techaggi's formal feature request (#18, #19, #41) + Sattyam postmortem (#40) + Uber (#38) + Askew (#37) are all HIGH. **S2 4:** plan-level approval + hard budget cap is close to unowned — Copilot owns only the narrow CI-gate slice, n8n/Relay gate a node not a multi-step plan. **S3 3:** blend of T3 (MODERATE) + T7 (MODERATE); strong "why-now" cost timing but neither theme is STRONG. **S4 4:** v0 shows plan approval + turn/$ caps, but v0 does **not** show a pre-execution *cost estimate* (§0 describes caps like 30 turns / $5, not an estimate) — so the demo delivers the cap, not the number techaggi asks for. **S5 4:** dealer caps/gates central; deck is supporting, not load-bearing.

**C5 — S1 2:** Phase 1 explicitly marks T5 **insufficient** first-person pain — audit-trail need is argued from principle (teknium1 feature request, one postmortem), not people venting about its absence. **S2 5:** audit-as-the-hero-story (not an enterprise checkbox) is genuinely unowned per Phase 2. **S3 5:** T5 = STRONG (Braintrust $80M, Langfuse into ClickHouse, EU AI Act Aug 2 2026). **S4 4:** v0's SQLite treasure is demoable but static/undramatic. **S5 4:** audit spans both products. *(S1↔S3 divergence is the point — see cut rationale.)*

**C6 — S1 4:** T2 STRONG quotes (Volochnev #11, steipete #36, deadbabe #14) + NEW-2. **S2 3:** code-review is crowded ground (CodeRabbit/Greptile/Graphite; Vibe Kanban's "bottleneck has shifted"); the "gate-before-execution reduces volume" angle is fresh but adjacent. **S3 5:** T2 = STRONG. **S4 3:** "less unreviewed volume" is hard to show convincingly in 2 minutes. **S5 3:** dealer gate carries it; deck is weak here.

**C7 — S1 5:** T7 HIGH across persona levels (Uber, Sattyam, Askew, techaggi). **S2 3:** control-plane/FinOps space is filling (Portkey, Tokenomics Foundation); caps alone are a feature, not a story. **S3 3:** T7 = MODERATE. **S4 4:** caps demoable. **S5 3:** dealer-only. *Largely subsumed by C4.*

**C8 — S1 4:** T4 HIGH DIY fixes (Paul Keen's RAG #22–23, PLAN.md/PROGRESS.md #25, curated docs #26). **S2 3:** adjacent ingredient is crowded (Composio, Trace, Arcade, Charlie's daemon files). **S3 3:** T4 = MODERATE. **S4 3:** context reuse is hard to make legible in a short recording. **S5 4:** deck-centric, dealer supporting — asymmetric.

**C9 — S1 2:** Phase 1 marks T8 **insufficient** first-person, non-developer pain (the quotes are technical operators, not the marketer/ops persona). **S2 4:** dev+business in one gated queue is unowned, but business-approval is owned by Lindy/Relay/n8n. **S3 4:** T8 = STRONG broadly (Glean, n8n, Gumloop, Lyzr), MODERATE for the narrow Slack/email slice. **S4 3:** v0 can stage a manual business task + gated email but it isn't core-evidenced. **S5 4:** deck (Slack MCP) + dealer (gated send) fit well.

**C10 — S1 2:** the business half is unevidenced (T8 insufficient). **S2 5:** the unclaimed bundle per Phase 2. **S3 3:** blends STRONG-but-thin T8 with dev themes. **S4 3:** two-domain demo dilutes a 2-min recording. **S5 5:** the whole point is both products across both domains.

**C11 — S1 3:** aqme28 #16, findjashua #34 built critic agents. **S2 2:** crowded review ground, me-too. **S3 5:** T2 STRONG. **S4 3:** demoable but not distinctive. **S5 2:** neither product uniquely needed.

---

## Step 3 — Winners (4) + runner-up cut

**Winners: C1, C2, C3, C4.** Together they cover the full differentiator set and the Phase 2 white-space bundle — plan-level approval (C1, C4 → D1), a *separate* gated send (C2 → D2), audit-trail woven through as the "why us" of C2 and C3 (D3), reusable playbooks feeding the batch (C1, C3 → D4), hard caps (C3, C4 → D5), and queue orientation (C1, C3 → D6) — while every winner is anchored in a theme Phase 1 evidenced as real first-person pain.

- **C1 Morning review of the overnight queue** won on the rare 5/5/5 across pain, market, and demo-ability: it is literally the v0 loop, T1 is the largest dollar concentration in Phase 3, and the *morning-review* framing is the one twist Phase 2 says nobody's copy foregrounds. It is the anchor scenario.
- **C2 The send that never should have gone out** won on differentiation (only 5 on S2) and both-products fit (5 on S5). NEW-1's blast-radius incidents are the single strongest argument in Phase 1 for D2, and gating the *send* as a discrete checkpoint is the most defensible piece of white space — competitors gate a workflow node or a diff, not the outbound payload for both dev and business tasks.
- **C3 Retire the babysitting rig** won because T6 is the strongest-evidenced theme in the entire inventory — people who built a worse version themselves are the "wanted it badly enough" signal the plan prizes — and it is the scenario where both products are most obviously non-amputatable.
- **C4 Approve the plan and the budget before a dollar is spent** won on pain (techaggi filed a formal feature request; costs are HIGH across Uber down to solo devs) and gives the launch a professional/agency wedge the other three lack. Kept despite a MODERATE market blend because the "why-now" cost timing (18.6x tokens/9mo, EU AI Act) is a genuine tailwind, and because it carries D1+D5 into a paying persona.

**Strongest runner-up cut: C5 — The audit treasure.** This is the most tempting cut because it scored **5 on both S2 and S3**: Phase 2 calls audit-as-hero *genuinely unowned* (everyone treats it as an enterprise checkbox), and Phase 3 rates T5 STRONG on the back of Braintrust/Langfuse funding and the EU AI Act deadline one month out. It is cut on **S1 = 2**: Phase 1 explicitly found audit-trail to be *insufficient* first-person pain — the need is argued from compliance principle and postmortems, not from people complaining about its absence in the wild. Leading a launch aimed at solo devs and small teams with a scenario nobody is *felt-painfully* asking for would be positioning on a market chart rather than on a human. This is the exact trap the synthesis brief warns against, so audit-trail is **demoted from a hero to a supporting "why us"** inside C2 and C3 (where the pain is real and the trace is the payoff), not deleted. If EU-AI-Act-driven demand shows up as first-person pain in a later pass, promote it. *(Secondary cuts for the same reason: C9 and C10 — the non-developer/business scenarios — cut on S1 = 2 despite T8's STRONG broad market signal, because Phase 1 could not evidence genuine first-person non-developer pain through dev-forum mining. Both are held for a primary-research/landing-test validation loop, not built into launch copy yet.)*

---

## Step 4 — Hero scenario cards

### CARD 1 — Morning review of the overnight queue

**Persona & trigger.** Solo dev / indie hacker. It's 11pm; there are five nagging tickets (dead-code cleanup, a flaky test, a dependency bump, a docs pass, a small refactor) that are worth doing but not worth *watching* get done. Today the only way to run them through Claude Code is to sit at the keyboard answering permission prompts one at a time.

**Narrative.** Before bed she opens the dealer feed — three tickets pulled from Linear (`ENG-412 flaky auth test`, `ENG-418 bump lockfile`, `ENG-421 delete dead billing code`) plus two typed in by hand. Each task is bound to her project's deck, so the agent already has the repo's MCP tools, the test-runner credential, and the `codebase-maintainer` playbook that spells out "run the full suite, never touch migrations, open a draft PR." For each task the agent drafts a plan; she skims all five plans in one pass and approves — a single cheap gate, not per-action nagging. Execution runs headless under a 30-turn / $5 cap per task; if one blows the cap it halts and waits rather than grinding. She closes the laptop. Over coffee she opens the morning-review view: three tasks done with draft PRs, one halted at its cap with the partial trace, one flagged for feedback. She approves two, sends one back with a one-line correction, and re-queues the halted one with a higher cap. Every task's plan, execution trace, and her feedback are already stored as treasure she can grep next week.

**Why us.** D6 (queue overnight, review in the morning), D1 (one plan approval up front, not permission prompts mid-run), D5 (per-task caps that halt instead of overrun), D4 (the deck/playbook makes the nightly batch repeatable). Competitors' framing doesn't cover it: Phase 2 shows 6+ products own "runs while you sleep," but they gate on the *output PR* after the fact (Devin, Conductor, Codex Cloud) — none narrate the *plan-approve-then-morning-review* loop, and Phase 2 notes explicitly that nobody's copy foregrounds the morning-review half.

**Evidence.**
- "I use Claude Code overnight almost exclusively, it's simply not worth my time during the day. It's just easier to prepare precise instructions, let it run and check the results in the morning." — solo dev "benterix", https://news.ycombinator.com/item?id=44718795 (~Jul 2025)
- "my biggest frustration was babysitting it. You give it a task, wait for it to finish, then give it the next one. If it asks a permission question, you have to be at your keyboard to respond. You can't really walk away." — solo dev "starsh2001" (built *qlaude*), https://news.ycombinator.com/item?id=47075865 (~Feb 2026)
- "I found myself frequently wanting to schedule tasks in Claude Code (both one-time and recurring)... it's nice in a nightly cadence." — solo dev "jshchnz" (built Claude Code Scheduler), https://news.ycombinator.com/item?id=46624100 (~Jan 2026)
- **Market signal (Phase 3, T1 = STRONG):** the largest dollar concentration in the research maps here — Cognition/Devin raised $1B+ at a $25B valuation (May 2026) and Claude Code hit $1B ARR in six months — capital is voting that long-running, low-supervision execution is the market's direction.

**Copy hooks.**
1. "Queue it before bed. Review it over coffee."
2. "Approve the plan once. Wake up to the work — and the receipts."
3. "Stop babysitting your agent. Start reviewing its mornings."

**Demo sketch (2 min).** (0:00) Linear board → pull 3 tickets into the feed, type 2 more. (0:25) Deck badge shows tools + `codebase-maintainer` playbook bound. (0:40) Five plan drafts appear; approve all in one scroll. (1:00) Fast-forward: headless runs, one halting at its $5 cap. (1:20) Morning-review view: 3 draft PRs, 1 halted-with-trace, 1 flagged. (1:40) Approve two, send one back with a one-line note, re-queue the halted one. (1:55) Click a finished task → full treasure trail.

**Falsifier.** If, when people are handed a real queue, they overwhelmingly disable the plan gate ("just run them all") — i.e. the approval step reads as friction rather than the point (see anti-signal 1) — the scenario collapses into the crowded "background agents" cluster with no differentiation.

---

### CARD 2 — The send that never should have gone out

**Persona & trigger.** Anyone who has wired an agent to Slack, email, or a ticketing system — a solo dev, an ops lead, a founder. The trigger is the cold-sweat moment: the agent, mid-task, decides the "helpful" next step is to *message someone* or *change something live* — and there was no gate between deciding and doing.

**Narrative.** A support-triage task runs on the deck that bundles the Slack and Linear MCP servers plus the team's credentials. The agent reads an escalation thread, drafts a plan ("summarize the outage, post a status update to `#customers`, update `SUP-207`"), and the human approves the plan. Execution runs under caps and produces three *proposed outbound actions* — but nothing is sent. The dealer shows each payload exactly as it would land: the literal `#customers` message text, the email body and recipient, the ticket-status change. The human reads the Slack draft, sees it names the wrong customer, edits one line, approves *that* send; approves the ticket update; and rejects the email entirely. Two actions fire, one never existed. The whole sequence — plan, trace, each proposed payload, each approve/edit/reject — lands in the treasure, so "who approved this message and why" has a literal answer. The gate is cheap and high-leverage: one plan approval, then one approval per *irreversible* send — not a prompt for every keystroke.

**Why us.** D2 (nothing leaves without the human seeing the exact payload) is the spine; D1 (plan approved first) and D3 (every send logged) reinforce it. This is the strongest white space in Phase 2: n8n, Relay, and Lindy own generic "human-in-the-loop approvals," but they gate a *workflow node* for business users only — none isolate the *outbound send* as a distinct second checkpoint spanning both coding-agent runs and business tasks. The coding-agent cluster gates the PR, never the message.

**Evidence.**
- "A message was sent from someone's account, to a person they didn't choose, with content they didn't write, at a time they didn't know about." — security researcher giving Claude full Slack access, https://medium.com/@0xShyam-Sec/we-tricked-an-ai-agent-into-sending-messages-it-was-never-told-to-send-1569557db3f9 (2026)
- "the agent can edit workspace files without approval... the biggest win is a human approval step between the agent and anything that deploys or runs live." — eng/community responder "Kevin_Neilson", https://forum.cursor.com/t/unauthorized-changes-by-lazy-agent/164158 (2026-07-03)
- "full autonomy on content, product, support; zero autonomy on spend above 0 or irreversible decisions." — founder/ops "pritesh_ghodge", https://www.indiehackers.com/post/i-analyzed-7-autonomous-ai-agents-for-business-in-2026-here-s-what-i-concluded-e34c50741f (2026-03-15)
- **Market signal (Phase 3, T3 = MODERATE, governance-adjacent T5 = STRONG):** investors fund oversight as bundled infrastructure — Sycamore ($65M, "governance layer for AI agents"), Dust ($40M, "multiplayer AI," 3,000+ orgs) — and the EU AI Act (enforceable Aug 2, 2026) mandates documented human-oversight mechanisms for high-risk systems.

**Copy hooks.**
1. "Your agent drafts the message. You send it."
2. "Nothing leaves without you seeing exactly what leaves."
3. "One approval stands between your agent and an irreversible mistake."

**Demo sketch (2 min).** (0:00) Deck badge: Slack + Linear MCP bound. (0:20) Approve a triage plan. (0:40) Execution completes → three *proposed* outbound actions listed, all pending. (1:00) Open the Slack payload — real channel, real text — spot the wrong customer name, edit one line, approve. (1:25) Approve the ticket update; reject the email with a reason. (1:45) Show `#customers` receiving only the edited message. (1:55) Treasure view: the rejected email preserved as "proposed, denied."

**Falsifier.** If the population that matters routinely runs with `--dangerously-skip-permissions` / "Run Everything" *specifically because* they've sandboxed the blast radius (containers, no live credentials) — Phase 1 anti-signals 2 and 3 — then gating the send is safety theater to them, and the scenario only lands for users who *cannot* contain blast radius that way (live Slack, real inboxes, production tickets). If that latter group is small, the card shrinks.

---

### CARD 3 — Retire the babysitting rig

**Persona & trigger.** The power user who is already *doing this the hard way*: running 5–20 Claude Code / Cursor sessions across machines and branches, having stitched together a queue, a Telegram approval bot, a cron scheduler, and a dashboard — and lost track of what's running where. The trigger is the maintenance tax on the rig itself.

**Narrative.** He's been running his own orchestration: a queue wrapper, a Telegram bot that pings him for approvals, a cron job that kicks off nightly cleanups, and a hand-rolled dashboard so he can see what each session did. It works, barely, and every new project means re-plumbing context and re-teaching conventions. He moves the whole thing onto dealer + deck. The queue, the approval gate, the caps, and the trace are now one surface instead of four scripts. Each project gets a deck — its MCP tools, its credentials, its playbooks — so the reference docs he used to maintain by hand become a bound, reusable object. He loads a batch across two repos, approves the plans in one pass, and lets them run headless under caps; when he checks back he reviews *what happened* from the trace rather than trying to watch sessions live. The bespoke rig — the part he maintained instead of shipping features — gets deleted.

**Why us.** D6 + D1 + D5 replace the queue/approval/cap scripts; D4 (decks/playbooks) replaces the hand-curated reference docs and per-project re-plumbing; D3 (trace) replaces the DIY dashboard. Phase 2: DIY-orchestration *is* being productized (Conductor, Superset, the now-sunsetting Vibe Kanban), but those tools sell parallelism and review ergonomics — none bundle the plan-gate + caps + audit + portable playbooks the rig-builders actually assembled by hand.

**Evidence.**
- "my biggest frustration was babysitting it... You can't really walk away." — solo dev "starsh2001" (built *qlaude*, a queue + Telegram-approval tool), https://news.ycombinator.com/item?id=47075865 (~Feb 2026)
- "you can't watch 20 agents in real-time, but you can review what happened." — engineer running 70+ local agents "killbot_2000", https://news.ycombinator.com/item?id=46990733 (~Jan 2026)
- "We don't trust agents to make the right call under load, so we make the call for them." — small eng team "Askew" (built a DIY circuit breaker after a $87 burn), https://write.as/askew/we-built-a-circuit-breaker-because-we-couldnt-trust-ourselves (2026-03-30)
- **Market signal (Phase 3, T6 = MODERATE):** the DIY layer is real but hasn't produced a venture winner — LangChain ($125M) and Mastra ($13M) are "graduate the scripts into a company" plays, while Vibe Kanban's parent shut down in April 2026 — strong community pull, open product slot.

**Copy hooks.**
1. "You built the queue, the approval bot, and the dashboard. Delete all three."
2. "Stop maintaining the rig you built to run your agents."
3. "One surface for the queue, the gate, the caps, and the trace."

**Demo sketch (2 min).** (0:00) Split screen: a messy tmux/cron/Telegram rig on the left. (0:20) Right side: dealer feed loads a batch across two repos, each with its deck bound. (0:45) Approve plans in one pass. (1:05) Headless runs under caps; one halts. (1:25) Review "what happened" from the trace — no live-watching. (1:45) Close the left screen: the rig is gone. (1:55) Show a deck's playbook = the old reference doc, now portable.

**Falsifier.** Anti-signal 4: some experienced operators reject *more* orchestration infrastructure outright — "I'd rather stick to one agent and optimize what it can do" (HN "giancarlostoro"). If that's the dominant reflex among rig-builders rather than a minority, they won't migrate a rig — they'll shrink scope instead, and the "retire the rig" pitch has no audience.

---

### CARD 4 — Approve the plan and the budget before a dollar is spent

**Persona & trigger.** Freelancer or agency developer who bills AI cost through to a client. The trigger: a client asks "what will this cost?" and today the honest answer is "I can't tell you until after it runs." "Run first, see cost later" is not a professional stance.

**Narrative.** A client ticket comes in — "migrate the reporting module to the new API." On the client's deck (their repo tools, their conventions playbook) the agent drafts a plan: the steps, the files it will touch, and a hard ceiling of 40 turns / $8 for the run. The developer reviews the plan *before* anything executes, adjusts the cap down to $5 because the scope is smaller than the agent assumed, and approves. Execution runs headless and stops at the cap if it hits it — no surprise reconciliation after the fact. The result comes back as a diff for review; the developer approves the "done," and the outbound status update to the client's Slack is held as a gated send he approves separately. Task → plan → trace → the caps he set → his approvals all land in the treasure, so when he invoices, the record of what was authorized and what it cost is already there, per client, per task.

**Why us.** D1 (plan approved before execution) + D5 (hard turn/dollar caps as the gate) are the spine, with D2 (gated client-facing send) and D3 (billable audit trail) supporting. Phase 2: GitHub Copilot owns only a narrow CI-approval slice; n8n/Relay gate a single node, not a multi-step plan with a budget. Nobody offers plan-plus-budget approval as the pre-execution gate for a billable engagement. **Honest scope note:** v0 enforces caps but does not yet produce a pre-execution cost *estimate* — it delivers the ceiling techaggi wants, not the forecast; the estimate is a roadmap gap the copy must not overclaim.

**Evidence.**
- "In a professional context, 'run first, see cost later' is not acceptable... token cost before plan approval is a complete unknown." — freelancer/agency dev "techaggi" (filed a formal Claude Code feature request), https://github.com/anthropics/claude-code/issues/55779 (2026-05-03)
- "Budget accountability: Agencies and freelancers bill AI costs to clients. Before approving a plan, they need an estimate to determine if the work is within authorized budget." — "techaggi", https://github.com/anthropics/claude-code/issues/55779 (2026-05-03)
- "Cost to the user: $50. Cost of not having this: $4,200." — postmortem author "Sattyam Jain", https://medium.com/@sattyamjain96/the-agent-that-burned-4-200-in-63-hours-a-production-ai-postmortem-d38fd9586a85 (2026-04-14)
- **Market signal (Phase 3, T3/T7 = MODERATE, strong "why-now"):** per-developer token use rose ~18.6x in nine months, Uber "exhausted its entire 2026 AI coding budget by April," and the Linux Foundation stood up a "Tokenomics Foundation" in June 2026 — the cost-control tooling layer is visibly behind the growth curve.

**Copy hooks.**
1. "See the plan and the ceiling before the meter starts."
2. "No run without an approved plan — and an approved budget."
3. "Bill your client with the receipts already in hand."

**Demo sketch (2 min).** (0:00) Client ticket into the feed; client deck bound. (0:20) Plan draft appears with a proposed 40-turn / $8 cap. (0:45) Edit the cap down to $5; approve. (1:05) Headless run halts cleanly at the cap. (1:25) Diff review → approve "done." (1:40) Gated Slack status update to the client — approve the send. (1:55) Treasure view filtered by client: plan + cap + trace + approvals, invoice-ready.

**Falsifier.** Anti-signal 5: audit/accountability overhead is reported as *not worth it* for solo operators ("I have never lost any sales... because of it"). If freelancers treat authorized-budget records the same way — nice in theory, skipped in practice — then the billable-audit half of this card is dead weight and it degrades to a plain "set a cap" feature (C7), which Phase 2 shows is a checkbox competitors already have.

---

## Step 5 — Contradictions & anti-signals

These are carried through in full from Phase 1 (§4 anti-signals) plus Phase 2/3 findings that cut against the winners. Not sanded off — the founder needs them for conviction.

**1. Approval-prompt fatigue is a named, recognized failure mode — and it is our nearest UX cliff.** Cursor users complained in near-identical language about per-change approval: "This is super frustrating/time consuming having to double approve everything" (Mark_Hutton); "Same issue here. This is driving me crazy for more than an hour now." (Carlos_Ramirez) — https://forum.cursor.com/t/agent-mode-keeps-asking-approval-for-changes/145341 (Dec 2025). **Implication for the winners:** every card above is written so the gate is *cheap and high-leverage* — one plan approval, then one approval per *irreversible send* — never per-action. If the dealer's approval UX drifts toward per-step prompting, C1/C2/C4 turn into the exact thing these users are begging to escape. The gate must read as leverage, not nagging.

**2. Gates don't just annoy — they can degrade into rubber-stamping.** "Over time approval fatigue leads people to stop paying close attention to what they're approving" — https://thomas-wiegold.com/blog/claude-code-dangerously-skip-permissions/ (2026). This is a direct argument that D1/D2 can hollow out if the gate is exercised too often or too cheaply. It reinforces #1 from the opposite side: too many gates and people rubber-stamp; the value of the plan gate and the send gate depends on there being *few* of them, each carrying real weight.

**3. A material population disables gates on purpose and defends it.** Practitioners run `--dangerously-skip-permissions` / "Run Everything" and argue the gate is redundant when blast radius is already contained by a sandbox/disposable container with no credentials: "the community consensus is pretty much settled: containers or don't bother... They don't add safety" (secondary-source paraphrase, same URL as #2). **Implication:** C2's gated-send story lands hardest for people who *cannot* contain blast radius that way — live Slack, real inboxes, production tickets, client credentials. For the sandbox-and-forget crowd, our gates are theater. Segment the copy accordingly; don't pitch the gate to people who've already engineered the risk away.

**4. Some operators reject orchestration infrastructure as the answer.** "I'd rather stick to one agent and optimize what it can do. When I hit my Claude Code limit, I stop." (HN "giancarlostoro", https://news.ycombinator.com/item?id=46990733, ~Jan 2026). This is a direct counter to D6/queue-orientation and the premise of C3. There is a real "constrain scope, don't orchestrate" school; the queue pitch is not universal even among heavy users.

**5. Audit value may be concentrated in larger teams, not the solo/small segment our strongest pain lives in.** Solo operators openly skip compliance overhead: "I have never lost any sales (that I know of) because of it" (HN "bitbasher"); "I lost some prestige business but if I took them on, it wouldn't move my profit levels much" (HN "jwr") — https://news.ycombinator.com/item?id=48145524 (~Jun 2026). D3's appeal is contingent on compliance requirements that the T1/T6/T7 solo-dev core can and does skip. **This is why C5 (audit-as-hero) was cut** and why audit appears only as a *supporting* payoff inside C2/C4, never as a standalone lead for a solo-dev launch.

**6. Independent-scoring flags (do not let market signal launder pain).** Phase 3 rates **T5 STRONG** (Braintrust/Langfuse funding, EU AI Act) and **T8 STRONG-broadly** (Glean $7.2B, n8n $2.5B) — but Phase 1 rates both as **insufficient first-person pain**. Every winner is anchored in a theme with *both* real Phase-1 pain and a real Phase-3 signal; C5, C9, and C10 were cut precisely because their market charts outran their human evidence. The non-developer / one-queue story (the fullest expression of Phase 2's white-space bundle) is therefore **positioned as a validation hypothesis, not a launch claim** — it needs primary research (interviews, a landing-page test) before it earns hero copy, because the population that would feel that pain does not write the HN/GitHub/dev.to posts this research could mine.

**7. Phase 2 crowding checks on the winners.** "Runs while you sleep" is baseline framing owned by 6+ products (C1's risk — mitigated only by the morning-review twist and the plan gate). Generic "human-in-the-loop approvals" is owned by n8n/Relay/Lindy (C2/C4's risk — mitigated only by gating the *plan* and the *send* specifically, not a node). Audit logs are a checkbox everywhere (C3/C5's risk). None of the winners survive on their headline theme alone; each survives only on the *specific* twist that Phase 2 confirmed is unclaimed. If a competitor ships plan-level approval + gated sends + audit-as-hero as a bundle (Charlie Labs and n8n are the two nearest, per Phase 2), the white space closes and the winners revert to me-too.
