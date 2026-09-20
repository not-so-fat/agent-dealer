# Muse Code PoC results (NOT-183, epic NOT-164)

Protocol: [`README.md`](./README.md). Tasks: [`tasks.json`](./tasks.json). Nothing in the tasks or thresholds was changed after the first run.

## Privacy acceptance (recorded before the first candidate run)

The operator (Yusuke Muraoka) accepted that prompts and completions from these runs may be used to improve Meta products. Recorded from the operator's message in the session that ran this PoC, on 2026-09-20: "ok, you run it, make sure you'll use contributor model, not normal model, I am interested in using only contributor models". Terms: the catalog description for `muse-spark-1.3-contributor` ("Your content, including inter-session messages, may be used for product improvement."). All 5 tasks are marked `non_sensitive` in `tasks.json`.

## Subjects and versions

| | Value |
|---|---|
| Candidate | Muse Code 1.3.0 (1.3.0-R3401.1), `MUSE_NO_AUTO_UPDATE=1`, `--model muse-spark-1.3-contributor`, default reasoning effort (high) |
| Baseline | `claude -p`, `--model claude-sonnet-5 --effort high`, Claude Code 2.1.278 |
| Muse plan | Not observable (NOT-177 blocker `plan_identifier_observability`); the `-contributor` model id is the only tier signal |

A candidate run counts only if every `model_completed.model` in its session log is `muse-spark-1.3-contributor`.
