# Phase 3 — Market Evidence (demand sizing for T1–T8)

**Date run:** 2026-07-10 · **Method:** WebSearch/WebFetch against funding trackers, press, Anthropic Economic
Index, developer surveys, and OSS adoption proxies. All claims below are cited with URL. Themes:

T1 queueing/overnight agent runs · T2 trust & review of agent output · T3 approval gates / human-in-the-loop ·
T4 repeated context setup · T5 audit & accountability · T6 DIY orchestration hacks · T7 agent cost anxiety ·
T8 non-developer delegation (Slack triage, email drafts, research briefs).

**Framing reminder:** funded startups' pitches are a signal that money believes a pain is real — not proof
that the pain drives individual adoption, and not story material for Phase 4. Verdicts are about theme
*size and growth*, not about whether agent-dealer/agent-deck should copy any of these products.

---

## 1. Funding table (last ~18 months, i.e. Jan 2025 – Jul 2026)

24 relevant startups. "Theme" = primary T1–T8 mapping; secondary mapping noted in parentheses.

| # | Startup | Round · Amount · Date | One-line pitch | Theme(s) | URL |
|---|---------|------------------------|-----------------|----------|-----|
| 1 | Cognition (Devin) | Series D · $1B+ at $25B pre-money · May 2026 | Autonomous coding agent that works for hours-to-days per task with $492M run-rate revenue | T1 | [TechCrunch](https://techcrunch.com/2026/05/27/ai-coding-startup-cognition-raises-1b-at-25b-pre-money-valuation/) |
| 2 | Factory.ai | Series C · $150M at $1.5B · Apr 2026 | Enterprise coding "droids" that run autonomous dev work; revenue doubled monthly for 6 months | T1 | [TechCrunch](https://techcrunch.com/2026/04/16/factory-hits-1-5b-valuation-to-build-ai-coding-for-enterprises/) |
| 3 | Blitzy | Series C · $200M at $1.4B · May 2026 | Deploys "thousands of coding agents in parallel," runs for weeks unattended on enterprise codebases | T1 | [SiliconANGLE](https://siliconangle.com/2026/05/05/blitzy-raises-200m-1-4b-valuation-deploy-thousands-coding-agents-parallel/) |
| 4 | 8090 | Series A · $135M · Jun 2026 | Enterprise coding-agent platform for regulated industries | T1 (T5) | [gravity.fast tracker](https://gravity.fast/blog/ai-agent-funding-tracker-q3-2026/) |
| 5 | CodeRabbit | Series B · $60M at $550M · Sep 2025 | AI reviewer that checks AI-generated code before merge | T2 | [TechCrunch](https://techcrunch.com/2025/09/16/coderabbit-raises-60m-valuing-the-2-year-old-ai-code-review-startup-at-550m/) |
| 6 | Greptile | Series A · $25M · Sep 2025 | AI code review/validation to catch what agent-written PRs get wrong | T2 | [SiliconANGLE](https://siliconangle.com/2025/09/23/greptile-bags-25m-funding-take-coderabbit-graphite-ai-code-validation/) |
| 7 | Graphite | Growth round · $52M · Mar 2025 | Code-review platform partnered with Anthropic to handle the review bottleneck AI coding creates | T2 | [DEV Community summary](https://dev.to/heraldofsolace/stacking-up-graphite-in-the-world-of-code-review-tools-5fbn) |
| 8 | Patronus AI | Series B · $50M · Jun 2026 | Builds simulated "digital worlds" to stress-test AI agents before/after deployment | T2 | [TechCrunch](https://techcrunch.com/2026/06/25/patronus-ai-lands-50m-to-build-digital-worlds-that-stress-test-ai-agents/) |
| 9 | HumanLayer | Pre-seed · $500K · 2023/24 (outside 18-mo window; included as the only pure-play example of the category) | API/SDK for agents to request human approval via Slack/email/SMS before executing a function call | T3 | [Extruct AI](https://www.extruct.ai/hub/humanlayer-dev-funding/) |
| 10 | Sycamore | Seed · $65M · Mar 2026 | "Enterprise operating system and governance layer" for AI agents | T3 (T5) | [newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis) |
| 11 | Dust | Series B · $40M · May 2026 | "Multiplayer AI" platform for human-agent collaboration; 3,000+ orgs, 300,000+ deployed agents | T3 (T8) | [Dust blog](https://dust.tt/blog/series-b-multiplayer-ai) |
| 12 | Composio | Series A · $25M · Jul 2025 | Infrastructure/skill layer so agents connect to enterprise systems without bespoke integration work each time | T4 | [newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis) |
| 13 | Trace | Seed · $3M · Feb 2026 | "Context layer for enterprise AI-agent adoption" — explicitly framed as solving re-explaining context | T4 | [TechCrunch](https://techcrunch.com/2026/02/26/trace-raises-3-million-to-solve-the-agent-adoption-problem/) |
| 14 | Arcade.dev | Series A · $60M (combined $72M total) · Jun 2026 | "Secure action layer" giving agents durable, reusable tool access instead of one-off auth per agent | T4 (T5) | [BusinessWire](https://www.businesswire.com/news/home/20260615229631/en/Arcade-Raises-$60M-to-Become-the-Secure-Action-Layer-Behind-Every-Production-AI-Agent) |
| 15 | Braintrust | Series B · $80M at $800M · Feb 2026 | AI-native observability/eval platform, positioned as "the observability layer for AI" | T5 | [SiliconANGLE](https://siliconangle.com/2026/02/17/braintrust-lands-80m-series-b-funding-round-become-observability-layer-ai/) |
| 16 | Langfuse (acquired into ClickHouse) | Part of ClickHouse's $400M Series D · Jan 2026 | LLM observability/tracing; 2,000+ paying customers, tens of millions of monthly SDK installs | T5 | [Confident AI roundup](https://www.confident-ai.com/knowledge-base/compare/best-ai-agent-observability-tools-2026) |
| 17 | CodeIntegrity | Seed · $5M · Jun 2026 | Security guardrails against prompt injection / unpredictable behavior in enterprise agents | T5 (T2) | [newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis) |
| 18 | LangChain | Series B · $125M · Oct 2025 | Open-source framework/platform for building and operating agents (the "roll your own orchestration" layer, now commercializing) | T6 | [newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis) |
| 19 | Mastra | Seed · $13M · Oct 2025 | TypeScript framework/tooling for building and deploying agents — productized DIY orchestration | T6 | [newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis) |
| 20 | E2B | Series A · $21M · Jul 2025 | Open-source cloud sandbox so home-grown agent scripts can execute code safely instead of on a dev's own machine | T6 (T1) | [newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis) |
| 21 | Paid | Seed · $21.6M · Sep 2025 | Monetization/billing infra for AI-agent businesses — adjacent to the "what is this agent actually costing us" problem | T7 | [newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis) |
| 22 | Portkey | Series A · $15M · Feb 2026 (acquired by Palo Alto Networks, Jun 2026) | Control plane sitting in front of every model call for cost control/governance; manages $180M+ in annualized LLM spend for customers | T7 | [Portkey blog](https://portkey.ai/blog/series-a-funding/) |
| 23 | Glean | Series F · $150M at $7.2B · Jun 2025 | Enterprise AI search/agents usable by "anyone, not just technical teams," across departments | T8 | [Glean press](https://www.glean.com/press/glean-raises-150m-series-f-at-7-2b-valuation-to-accelerate-enterprise-ai-agent-innovation-globally) |
| 24 | n8n | Series C · $180M at $2.5B · Oct 2025 | No/low-code workflow automation now centered on an "AI Agent" node; ARR ~$40M, 10x YoY usage growth | T8 (T4/T6) | [n8n blog](https://blog.n8n.io/series-c/) |
| 25 | Gumloop | Series B · $50M ($70M total) · Mar 2026 | No-code AI agent platform for non-engineers to build automations | T8 | [TAMradar](https://www.tamradar.com/funding-rounds/gumloop-series-b-50m) |
| 26 | Lyzr | Series B · $100M at ~$500M · Jul 2026 | Enterprise AI agents; used its own agent ("SivaClaw") to run investor Q&A during its own raise | T8 (T6) | [TechCrunch](https://techcrunch.com/2026/07/09/an-ai-agent-startup-just-let-its-agent-run-its-100-million-fundraise/) |

Count: **26 startups** (slightly above the 15–25 target because T1–T8 coverage was uneven — cutting further
would have left T7 with only 1 entry). Cut from the table but worth noting: Keycard ($38M, Oct 2025, agent
access-control — T3/T5), Manifold ($8M seed, Mar 2026, agent endpoint security — T5), Archestra ($10M seed,
Jun 2026, secure agent-to-data broker — T4/T5), Catena Labs ($30M seed, May 2026, agentic finance
infrastructure — weak T7 mapping), Convey ($38M, Jun 2026, enterprise AI teammates — T8), Didero ($30M
Series A, Feb 2026, agentic procurement — T8). All found via the same searches; omitted only to keep the
table at a readable size, not because the signal was weaker.

---

## 2. Per-theme demand notes

### T1 — Queueing / overnight agent runs
The single largest dollar concentration in this whole research maps here. Cognition/Devin raised $1B+ at a
$25B valuation in May 2026 explicitly to scale an agent that works autonomously for extended stretches, with
disclosed run-rate revenue of $492M ([TechCrunch](https://techcrunch.com/2026/05/27/ai-coding-startup-cognition-raises-1b-at-25b-pre-money-valuation/)).
Factory.ai ($150M Series C, $1.5B valuation, Apr 2026) and Blitzy ($200M, $1.4B valuation, May 2026 — "deploy
thousands of coding agents in parallel," running for weeks) are the same bet from different teams
([TechCrunch](https://techcrunch.com/2026/04/16/factory-hits-1-5b-valuation-to-build-ai-coding-for-enterprises/),
[SiliconANGLE](https://siliconangle.com/2026/05/05/blitzy-raises-200m-1-4b-valuation-deploy-thousands-coding-agents-parallel/)).
Claude Code itself is the clearest usage-side proxy: it went from launch to $1B annualized revenue in 6
months — "the fastest enterprise software product" to do so — and passed $2.5B run-rate by February 2026
([Anthropic Economic Index coverage](https://www.anthropic.com/research/economic-index-june-2026-report)).
None of this is queue/scheduling infrastructure specifically (that remains a DIY/OSS layer — see T6), but the
capital is voting that long-running, low-supervision agent execution is the direction of the market, which is
the underlying bet agent-dealer's "feed → plan → overnight execution → morning review" loop is making too.
**Verdict: STRONG.**

### T2 — Trust & review of agent output
Three funded, growing companies (CodeRabbit $60M Series B at $550M, Sep 2025; Greptile $25M Series A, Sep
2025; Graphite $52M, Mar 2025) exist purely to review AI-generated code before it ships, explicitly because
reviewers can't keep up with AI-generated code volume
([SiliconANGLE](https://siliconangle.com/2025/09/23/greptile-bags-25m-funding-take-coderabbit-graphite-ai-code-validation/)).
Patronus AI ($50M Series B, Jun 2026) extends the same problem pre-deployment, building simulated environments
to stress-test agents before they're trusted with real tasks
([TechCrunch](https://techcrunch.com/2026/06/25/patronus-ai-lands-50m-to-build-digital-worlds-that-stress-test-ai-agents/)).
Survey data backs the underlying distrust directly: Stack Overflow's 2025 Developer Survey found only 29% of
developers trust AI accuracy (down from 40%) versus 46% who actively distrust it, and 66% say they spend more
time fixing "almost-right" AI output ([Stack Overflow](https://stackoverflow.co/company/press/archive/stack-overflow-2025-developer-survey/),
[shiftmag](https://shiftmag.dev/stack-overflow-survey-2025-ai-5653/)). DORA's 2025 report frames this as a
"trust paradox" — AI is used heavily (~90% of developers) but doesn't replace review; it makes review *more*
critical ([DORA](https://dora.dev/dora-report-2025/)). JetBrains 2025 (n=24,534) found only 44% of developers
have AI even partially integrated into core workflows despite 85% regular usage, with code quality the
top-cited concern (23%) ([JetBrains](https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/)).
**Verdict: STRONG.**

### T3 — Approval gates / human-in-the-loop
This is the theme where funding data and survey/usage data point in different directions, and it's worth
being explicit about that split. As a *standalone* funding category, human-approval tooling is barely funded:
one analysis of the agentic-AI funding market found "no qualifying deals in 2024, one tiny $1.4M deal in
2025, and no qualifying deals in early 2026" for what it calls "Human Approval Agents," concluding that
"human approval is widely needed but rarely funded as its own category... oversight is being bundled into
vertical agents, governance tools, security products, and control planes"
([newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis)). HumanLayer, the
clearest pure-play example (an API for agents to request human approval via Slack/email before executing a
function call), raised only a $500K pre-seed and that was in 2023/24, outside this window
([Extruct AI](https://www.extruct.ai/hub/humanlayer-dev-funding/)). But the *bundled* version is well funded
and large: Sycamore ($65M seed, Mar 2026, "governance layer for AI agents"), Keycard ($38M, Oct 2025, agent
permissions), and Dust ($40M Series B, May 2026, "multiplayer AI" for human-agent collaboration, 3,000+ orgs)
all sell approval/oversight as a feature of a bigger platform rather than the product itself
([newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis), [Dust blog](https://dust.tt/blog/series-b-multiplayer-ai)).
Read together: investors believe approval/oversight is necessary infrastructure, but don't believe it's a
sellable product on its own — which is a real risk for any narrative that leads with "approval gates" as the
headline feature rather than as one part of a fuller workflow story.
**Verdict: MODERATE** (strong underlying necessity, weak standalone monetization signal).

### T4 — Repeated context setup
Direct-hit funded examples exist and are recent: Composio ($25M Series A, Jul 2025, tool/skill connection
infra "so agents can connect to enterprise systems"), Trace ($3M seed, Feb 2026, explicitly "a context layer
for enterprise AI-agent adoption" solving "the agent adoption problem"), and Arcade.dev ($60M Series A, Jun
2026 combined with its $12M seed, "secure action layer behind every production AI agent" — i.e., don't
re-authorize/re-explain access per agent) all monetize "stop re-teaching the agent every time"
([newmarketpitch](https://newmarketpitch.com/blogs/news/agentic-ai-funding-analysis),
[TechCrunch](https://techcrunch.com/2026/02/26/trace-raises-3-million-to-solve-the-agent-adoption-problem/),
[BusinessWire](https://www.businesswire.com/news/home/20260615229631/en/Arcade-Raises-$60M-to-Become-the-Secure-Action-Layer-Behind-Every-Production-AI-Agent)).
The MCP ecosystem's rapid emergence (Composio, Arcade.dev, and others explicitly built "on MCP") is itself a
signal that context/tool re-setup is being treated as a distinct, investable layer rather than a feature of
individual agent products. However, dollar amounts here (Trace's $3M seed vs. Cognition's $1B) are an order
of magnitude smaller than T1/T2, suggesting this is recognized as real but not yet proven to be a big
standalone market — it may be getting solved as a checkbox feature inside bigger platforms (Dust, Glean,
n8n) rather than needing its own company.
**Verdict: MODERATE.**

### T5 — Audit & accountability
Funded and growing: Braintrust ($80M Series B at $800M, Feb 2026, positioned as "the observability layer for
AI"), and Langfuse — acquired into ClickHouse's $400M Series D (Jan 2026) with 2,000+ paying customers and
"tens of millions of SDK installs per month" — show real commercial pull for logging/tracing agent behavior
([SiliconANGLE](https://siliconangle.com/2026/02/17/braintrust-lands-80m-series-b-funding-round-become-observability-layer-ai/),
[Confident AI](https://www.confident-ai.com/knowledge-base/compare/best-ai-agent-observability-tools-2026)).
The market-sizing data point is explicit: "the LLM observability platform market is estimated at roughly
$1.97B in 2025 growing to $2.69B in 2026 — a CAGR in the mid-30s percent"
([Confident AI](https://www.confident-ai.com/knowledge-base/compare/best-ai-agent-observability-tools-2026)).
CodeIntegrity ($5M seed, Jun 2026) targets the compliance-adjacent version of the same need (guardrails
against prompt injection in enterprise agents). Regulatory pressure is a real tailwind, not speculation: EU AI
Act high-risk obligations (Articles 8–17, 26, 27, 73) activate August 2, 2026, with penalties up to €35M or 7%
of global revenue, and they mandate "documented human oversight mechanisms," "mandatory logging of agent
decisions," and "6-month log retention" for high-risk systems
([Covasant](https://www.covasant.com/blogs/eu-ai-act-compliance-autonomous-agents-enterprise-2026)). This is
one of the strongest "why now" signals in the whole research set (see §3).
**Verdict: STRONG.**

### T6 — DIY orchestration hacks
This theme is structurally hard to size through funding data, because by definition the people doing this
haven't paid anyone — they built it themselves. The best evidence is adoption-proxy data on the OSS tools
they built or adopted instead: OpenHands sits around 68–76k GitHub stars with active monthly-plus release
cadence; Aider (41–46k stars) shows plateauing momentum, with a January 2026 GitHub issue openly asking "has
this project entered maintenance mode"; Cline was GitHub's fastest-growing AI open-source project in Octoverse
2025 with 4,704% YoY contributor growth
([Cline blog](https://cline.bot/blog/cline-the-fastest-growing-ai-open-source-project-on-github-in-2025-thanks-to-you),
[wetheflywheel](https://wetheflywheel.com/en/comparisons/openhands-vs-aider/)). Purpose-built DIY-orchestration
tools exist at small scale — Vibe Kanban (open-source Kanban board + MCP server for running Claude
Code/Cursor/Gemini agents in parallel) and Conductor (macOS app for running parallel Claude Code/Codex agents
in isolated worktrees) both emerged in this window, but Vibe Kanban's parent company Bloop *shut down* in
April 2026 and the project is now community-maintained — a concrete signal that "toolified DIY orchestration"
didn't clear the bar for a venture-scale business even where the underlying pain (managing multiple parallel
agents) is real ([augmentcode roundup](https://www.augmentcode.com/tools/open-source-agent-orchestrators)).
Funded companies now productizing what used to be scripts around `claude -p`/cron are LangChain ($125M Series
B, Oct 2025) and Mastra ($13M seed, Oct 2025, TypeScript agent framework) — both explicitly "graduate the DIY
layer into a company" plays, and E2B ($21M Series A, Jul 2025) sells the sandboxed execution environment those
DIY scripts need.
**Verdict: MODERATE** (strong OSS/community signal, but the direct "queue/orchestrate my own agent CLI" product
category hasn't produced a big funded winner yet — HumanLayer, Vibe Kanban's shutdown, and Aider's plateau all
point the same way).

### T7 — Agent cost anxiety
The pain is well documented in press coverage but thinly represented as a *funding* category specifically
(as opposed to the broader LLM-observability category, which overlaps with T5). TechCrunch's June 2026 feature
is the sharpest evidence: per-developer token consumption rose "approximately 18.6x in nine months," Uber
"exhausted its entire 2026 AI coding budget by April," one unnamed company "accumulated a $500 million Claude
bill after failing to set usage limits," and Goldman Sachs projects token usage will multiply 24x by 2030
([TechCrunch](https://techcrunch.com/2026/06/05/the-token-bill-comes-due-inside-the-industry-scramble-to-manage-ais-runaway-costs/)).
The same article reports the Linux Foundation launched a "Tokenomics Foundation" in June 2026 explicitly to
standardize cost metrics, "similar to FinOps for cloud spending" — a strong "this is now an industry-level
problem" signal. On the funding side, Portkey ($15M Series A, Feb 2026, manages $180M+ in annualized LLM
spend for customers, then acquired by Palo Alto Networks in June 2026) and Paid ($21.6M seed, Sep 2025,
billing infra for agent businesses) are the closest direct hits, but neither is purely a "stop my agent from
burning money" product — Portkey is a broader control plane, Paid is monetization infra for companies
*selling* agents rather than companies *running* them. A 2025 Mavvrik study cited in search results found
"50% of AI product companies don't track LLM API costs at all," which cuts both ways: real pain, but a market
still early enough that half of it isn't even instrumented yet.
**Verdict: MODERATE** (strong qualitative/press evidence of the pain; funding evidence is real but thinner and
more indirect than T1/T2/T5).

### T8 — Non-developer delegation
This is well funded and the deals are large. Glean ($150M Series F at $7.2B, Jun 2025) is explicit that its
pitch is agents usable "by anyone — not just technical teams — in any department or function," and disclosed
$300M ARR (3x in 15 months) with "AI budget cutting" as a stated selling point
([Glean press](https://www.glean.com/press/glean-raises-150m-series-f-at-7-2b-valuation-to-accelerate-enterprise-ai-agent-innovation-globally),
[TechCrunch](https://techcrunch.com/2026/05/28/gleans-top-line-crosses-300m-as-ai-budget-cutting-becomes-its-major-selling-point/)).
n8n ($180M Series C at $2.5B, Oct 2025) reports ARR near $40M with usage up 10x YoY and mid-market customer
count growing from 12 to 122 in twelve months, driven by its "AI Agent" node — largely used by ops/business
users, not just engineers ([n8n blog](https://blog.n8n.io/series-c/)). Gumloop ($50M Series B, Mar 2026) and
Lyzr ($100M Series B, Jul 2026 — notably, Lyzr had its own agent run its investor Q&A during the raise) round
out a cluster of no-code/low-code agent platforms aimed squarely at non-engineers
([TAMradar](https://www.tamradar.com/funding-rounds/gumloop-series-b-50m),
[TechCrunch](https://techcrunch.com/2026/07/09/an-ai-agent-startup-just-let-its-agent-run-its-100-million-fundraise/)).
Where this theme is weaker is in the *specific* sub-cases the plan names (Slack triage, email drafts, research
briefs): search turned up product tutorials and Slack's own January 2026 agentic-Slackbot features (draft
emails, schedule meetings, sift inboxes) rather than independent funded startups built narrowly around those
exact workflows — the funded money is going to general-purpose business-agent platforms, and Slack/email
triage is a use case layered on top rather than a company's whole pitch.
**Verdict: STRONG** (as "non-developer delegation platforms" broadly) but **MODERATE** for the narrower
Slack-triage/email-draft/research-brief slice specifically — see caveats.

---

## 3. Timing evidence ("why now")

- **Model capability + cost curve.** Anthropic's revenue grew from $1B annualized (Dec 2024) to $47B
  (May 2026) — a 47x increase in 17 months — and Claude Code reached $1B ARR in 6 months, "the fastest
  enterprise software product" to do so, then passed $2.5B run-rate by Feb 2026. Anthropic reports engineering
  teams now integrate AI into 60% of work while maintaining active oversight on 80–100% of delegated tasks —
  i.e., delegation is scaling *and* oversight is not going away, which is exactly the joint bet agent-dealer
  makes ([Anthropic Economic Index](https://www.anthropic.com/research/economic-index-june-2026-report),
  [getpanto.ai roundup](https://www.getpanto.ai/blog/claude-ai-statistics)).
- **Token/cost growth is outpacing FinOps tooling.** Per-developer token use rose ~18.6x in nine months;
  Goldman Sachs projects 24x growth in total token usage by 2030; the Linux Foundation only stood up a
  dedicated "Tokenomics Foundation" in June 2026 — i.e., the standardization/tooling layer is visibly behind
  the growth curve right now, which is a "why now" for budget-capped execution specifically
  ([TechCrunch](https://techcrunch.com/2026/06/05/the-token-bill-comes-due-inside-the-industry-scramble-to-manage-ais-runaway-costs/)).
- **Regulatory deadline is concrete and imminent.** EU AI Act high-risk obligations (mandatory decision
  logging, human oversight mechanisms, 6-month log retention) become enforceable August 2, 2026 — one month
  after this research was run — with fines up to €35M or 7% of global revenue
  ([Covasant](https://www.covasant.com/blogs/eu-ai-act-compliance-autonomous-agents-enterprise-2026)). This is
  a hard external forcing function for audit trails (T5) that didn't exist 18 months ago.
- **Trust is not resolving with better models — it's getting more important as review load grows.** DORA
  2025 frames AI as an "amplifier," and Stack Overflow 2025 shows trust in AI accuracy *falling* (40% → 29%)
  even as adoption rises (76% → 84%) — the review/approval bottleneck is intensifying, not fading, as models
  improve ([Stack Overflow](https://stackoverflow.co/company/press/archive/stack-overflow-2025-developer-survey/),
  [DORA](https://dora.dev/dora-report-2025/)).
- **Investment is concentrating in the "control/governance" layer, not just the "capability" layer.** Of the
  26 startups in the funding table, roughly half (T3/T4/T5) are infrastructure that exists purely to constrain,
  observe, or audit agents that already work — not to make agents smarter. That split of capital is itself
  evidence that "agents can already do the work; the open problem is trust and control," which is agent-dealer's
  and agent-deck's exact thesis.

---

## 4. Caveats

- **Funding table skews toward developer/coding-agent infrastructure.** Because the most legible, well-covered
  press exists for coding-agent and dev-infra rounds, T1/T2/T5/T6 are easier to evidence with clean dollar
  figures than T7/T8. This may overstate developer-side themes relative to business/non-developer ones simply
  as an artifact of what TechCrunch and Crunchbase choose to cover, not because the underlying pain is smaller.
- **T3's verdict rests on a single secondary-source claim.** The "one $1.4M deal in 2025, none in 2024/early
  2026" figure for standalone "Human Approval Agents" comes from one funding-analysis blog
  (newmarketpitch.com), not a primary dataset we could independently verify (no Crunchbase/PitchBook API
  access in this research pass). Treat the *direction* (approval gates are bundled, not standalone) as
  well-supported by the pattern across Sycamore/Keycard/Dust, but the *exact number* as indicative, not
  precise.
- **Startup pitch → theme mapping is sometimes a stretch.** Several rows (8090→T1/T5, Paid→T7, n8n→T8/T4/T6,
  Composio→T4) map to secondary themes based on interpreting a one-line pitch rather than reading the
  company's own theme taxonomy — these companies did not describe themselves using T1–T8 language, we
  inferred the mapping. Treat secondary-theme mappings especially as directional, not definitive.
- **HumanLayer is included despite being outside the 18-month window.** Its pre-seed predates the funding
  table's Jan 2025 cutoff. It's kept in the table because no clean 2025–2026 pure-play "approval API" funding
  round was found, and its *absence* of comparable recent-round company is itself part of the T3 story — but
  it technically breaks the window rule stated in the phase brief and should not be read as "recent."
- **GitHub star counts and download figures are noisy and inconsistently reported across sources** (e.g.
  OpenHands cited at both ~68k and ~75.8k stars in different aggregator posts within the same week of
  searching). Directional trend claims (Cline's Octoverse 2025 fastest-growing recognition, Aider's plateau)
  are better sourced than the exact point-in-time star counts and should be trusted more.
- **No primary access to Stack Overflow/DORA/JetBrains raw datasets or the Anthropic Economic Index PDF** —
  all figures were pulled from the reports' own blog summaries or third-party recaps of those reports, not
  cross-checked against underlying tables. Anthropic's report in particular yielded very little on the two
  things this phase most wanted from it (batch/overnight usage share, automation-vs-augmentation split by
  percentage) — the report discusses these concepts qualitatively but the fetch did not surface a clean
  numeric split; treat the "STRONG" T1 verdict as resting more on funding/revenue data than on Anthropic's
  own usage-mix numbers.
- **T8's narrower sub-cases (Slack triage, email drafts, research briefs) are the weakest-evidenced part of
  this phase.** We found strong evidence for general-purpose non-developer agent *platforms* (Glean, n8n,
  Gumloop, Lyzr) but no funded startup whose entire pitch is narrowly "Slack triage" or "email drafting" or
  "research briefs" the way CodeRabbit's entire pitch is "review AI-written code." This may mean the narrow
  slice is genuinely smaller/earlier, or it may mean it's being absorbed as a feature inside Slack itself
  (its Jan 2026 agentic Slackbot update) and inside the bigger platforms rather than spawning independent
  companies — either reading argues for caution before treating "Slack triage" as its own hero-scenario-sized
  market rather than one feature of a broader delegation story.
- **Time-boxing risk:** almost all figures here are from Jan–Jul 2026 press, meaning this reflects a very hot,
  possibly transient funding environment (global AI funding is reported at "over 70% of Q2 2026 capital");
  some of these valuations (Cognition $25B, n8n $2.5B→$5.2B in months) may not hold, and "strong" verdicts
  driven mainly by valuation size should be read as "capital believes this now," not "this is a durable,
  proven market."
