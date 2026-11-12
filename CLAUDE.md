# Quack2 - Claude Working Agreements

> Trimmed copy of Brian's global working agreements, committed here because cloud
> sessions cannot read the user-level file. Direct instructions override this file.

## Cloud sessions
- Sessions here usually run in a cloud sandbox on a fresh clone. Nothing outside the
  repo exists: no local machine, no homelab, no user-level skills or settings.
- Commit finished units of work without asking, and push the task branch after each
  commit until its PR is marked ready: unpushed work is lost when the sandbox goes away.
  Once the review loop is done, open its PR (or find the draft the harness opened), mark
  it ready and enable auto-merge without asking (see Git workflow and Orchestration). A
  branch the session harness assigns is used as the task branch instead of creating one.
- Never push to `main`. Never force-push.

## Response style
- No flattering openers, no motivational language, no closing fluff.
- Lead with the answer or result. Be concise. Direct statements over prose.
- Don't narrate obvious actions or say "I will" / "now I am" unless reporting progress.
- Don't end with suggestions or speculative follow-ups unless asked for options.
- Plain ASCII punctuation; keep output copy-paste safe.
- When corrected: fix it and state what changed. No apology, no recap of the earlier
  mistake, no lesson-learned commentary. If the correction is wrong, say so.

## Session shape
- Capability comes from the tools actually held, never from the surface the session
  appears to run on.
- Say what kind of session this is in one line before the first tool call: which tools
  are actually held and therefore what can be verified here. Probe rather than assume.
- A thread begins at the first side-effectful step - an edit, a commit, a push.
  Questions, reviews and think-aloud are free and need no ceremony. An aside that touches
  the same files and takes a few minutes is just done and mentioned.
- State the session's task in the first substantive reply, then hold it. When a new idea
  arrives mid-task, don't just start on it: offer to park it (one bd issue, see
  Backlogs), fork it to a subagent if the work is genuinely self-contained, or take it to
  a fresh session. Default to parking. Never let an idea evaporate; a one-line issue is
  the floor.
- Size the work before starting. If it is more than one session, say that instead of
  starting. Three shipped and verified changes beat eight half-done.
- Recommend a fresh session for the next distinct item when this one has completed two
  threads or a visible token budget is under a third. Name which.
- End every session with a paste-ready prompt for the next one, not a summary. It must
  be self-contained: the task in one line, what is done and verified, what is not, the
  exact files and paths, the next concrete step, and any live state the next session
  must not assume. Never "continue where we left off".

## Source of truth
- Documentation and code comments describe **current state and intent**; keep them
  accurate in the same change that alters behavior.
- Git is the register of **change**: what changed, when, and why. Reasons and history
  belong in commit messages, not in docs. No dated changelog entries, "fixed on X"
  notes, or completed-task logs in docs or comments.
- Comments explain *why*, not *what* the code already says.
- Prefer repo files over chat history when they conflict.
- If a doc is wrong, say so and offer to fix it; never route around it silently.
- Don't restate one doc's content inside another; don't start a parallel doc for
  something that already has a home.
- This file is already loaded as instructions; never re-read it.
- A measured fact carries the date it was measured, and is re-measured before it is
  trusted again. Vendor docs are not a measurement.
- If a change breaks something a doc calls a contract, the contract doc is updated in the
  same commit. Otherwise the change is not finished.

## Working with a repo
- Before non-trivial work, read `README.md`, skim `docs/` for current-state and planning
  docs, and check the queue (see Backlogs). Don't assume a fixed set of filenames.
- Be explicit about status: implemented-and-verified vs scaffold/unverified vs
  blocked/awaiting-decision. Never describe unverified work as done.
- Check `./ideas` when it exists; treat `.md` files there as candidate issues.
- File roles: `README.md` is public-facing, `docs/` holds the deeper contract, `CLAUDE.md`
  is how to work *in* the repo. Read each; don't restate one inside another.

## Backlogs

Issues live in this repo's Beads database (`.beads/`). What next is `bd ready`; in-progress
work is `bd list --status in_progress`. Tech debt a session notices is an ordinary issue
labelled `debt`. Text containing `"` goes in through a file. After a session's writes:
`bd dolt push`, and commit `.beads/issues.jsonl` on the task branch, so it reaches `main`
with that task's PR: `main` takes no direct commits (Git workflow). The database is the
source; the file is safe to regenerate (`bd export -o <repo>/.beads/issues.jsonl`).

Milestones are epics, each blocked by the one before, so `bd ready` serves the current
milestone's items; an item that needs Brian (game data, a real machine, a decision)
carries the `human` label. The next item is the oldest of
`bd ready --exclude-type epic --exclude-label human --sort oldest`. A cloud session has no `bd`: it reads `.beads/issues.jsonl`
and lists anything to file or close in its PR body, for a session with `bd` to apply.

## Secrets
- Never commit secrets. The pattern is `.env` generated from a committed `.env.example`,
  with the real `.env` gitignored.

## Consent and blast radius
- Read the relevant files and propose the approach before changing code.
- Ask first for anything that changes live behavior or cannot be undone: deploys,
  anything visible to other people or machines beyond the task branch and its PR, deleting
  data, or committing in a repo the session was not asked to commit in. Opening the PR, marking
  it ready, enabling squash auto-merge and the green squash merge in Orchestration are
  pre-approved; any other merge is not.
- Deletions: count first, abort if the count is surprising, never delete on a wildcard.
- Check the clock before anything time-sensitive.

## Editing discipline
- Read before editing; never edit blind. Prefer minimal, scoped edits to existing files
  over rewrites. Don't touch unrelated files.
- If a targeted edit fails twice on the same file, stop and rewrite it cleanly; don't
  loop. Never make >2 consecutive edits to a file without re-reading it.
- Spot an out-of-scope refactor worth doing? File it as a `debt` issue; don't expand the
  current change. In-scope cleanups still go inline.

## After changes
- Verify after every change against the live effect (the running value, the rendered
  page, the test output). "It parsed" is not verification. If you couldn't check, say so.
- Run the smallest relevant validation (test/lint/typecheck/build). If you couldn't
  validate, say so plainly.
- Conventional commits (`feat:`/`fix:`/`docs:`/...), one concern per PR: squash merge
  lands each PR on `main` as one commit. Don't bump versions or tag unless the change
  warrants it.
- Installers and scripts are idempotent and rerunnable.

## Review loop
For each unit of work:

1. **Work, noting concerns as you hit them,** each with its measurement, in a running
   list outside the repo. Not at the end. At commit the list goes under a `Concerns:`
   heading in the commit message body and into the reviewer's brief; any still open when
   the PR is marked ready move to the PR body or a `debt` issue.
2. **Commit and push.** Record the commit ID. This is what makes "review what changed"
   answerable. The push is only a backup: a draft PR the harness opens for it cannot
   auto-merge. Don't mark the PR ready or enable auto-merge until step 6. Once it is
   ready any push can merge, so only what Orchestration's PR step 3 drives (CI fixes, review
   fixes, merges from `main`) goes on that branch; other work starts a new one.
3. **Adversarial review, scoped to that commit,** at its tier (below). Hand it to a fresh
   reviewer (subagent or separate session), read-only. It reports; it does not fix.
   Brief it to:
   - Assume something was done incorrectly
   - Verify against the code and data, never against the write-up
   - Report false alarms too: a suspicion checked and cleared is worth knowing
   - Rank findings: BROKEN / MISSED / RISKY / COSMETIC
   - Paste actual output as evidence; an unsupported claim is worth nothing

   Self-review can't find this class of bug: the mistake and the review share the same
   assumptions.
4. **Fix findings and your noted concerns in one pass, as one new commit,** so the next
   review gets one coherent diff. A reviewer's diagnosis is a claim, not a finding. Verify
   the cause, not just the symptom; a reviewer can be right that something is broken and
   wrong about why.
5. **Second review, scoped to step 4's commit only,** when that commit changes a
   full-loop file or fixes a BROKEN or MISSED finding, in any tier. Not a re-sweep. Fixes
   introduce defects. Otherwise skip it.
6. **Fix in a new commit and push,** then open the PR or mark it ready and enable
   auto-merge together, per Git workflow and Orchestration's PR steps.
   Don't amend or rebase to tidy up: squash merge collapses the branch into one commit on
   `main`, and pushed commits are never rewritten.

**Tiers**, by blast radius, not size; a commit takes the tier of its riskiest file:
- Full loop: any file that is not Markdown, and any file under `.claude/`: code, tests,
  fixtures, scripts, CI, package, build and tool config, permissions, agents, skills.
- Docs: other Markdown, CLAUDE.md included. One review that checks every claim against
  the code, CI config and tool behavior; a second only as step 5 says.
- No review: typo or format fixes in Markdown, and the `.beads/issues.jsonl` snapshot.
  The PR body says `Review: skipped (<reason>)`.

**What gets fixed now:** decide by coupling, not timing. Caused by this change, or blocks
the next one: fix now. Belongs to code that's about to be replaced: defer.

## Orchestration
Brian is involved only when a decision is his to make. Sessions do the work, review it
and merge it themselves.

### Within a session: delegate the implementation
- After reading and sizing, split the task into parts with clear interfaces (a module
  and its tests, a smoke case, a reference-source summary). Hand each independent part
  to a subagent (`Agent`, `isolation: "worktree"`) with a self-contained brief: goal,
  files, the interface it must meet, the checks that must pass, and what not to touch.
- Parts that depend on each other's measured output stay serial; tightly coupled work
  stays with the lead. Never split one function across agents.
- The lead integrates the results into the task branch, runs `pnpm check` (and
  `pnpm smoke` for renderer changes), and runs the Review loop on the integrated commit.
  Subagents never commit to the task branch, push, or open PRs.

### Between sessions
No chain runs: cloud sessions have no `bd` to take an item from the queue and close it.
Each session is started with its item named, from `bd ready` (see Backlogs).

### Driving the PR to merged
After step 6 of the Review loop:
1. Find the branch's PR (`list_pull_requests` by head; the harness may already
   have opened it as a draft), else open it. Mark it ready (`update_pull_request` with
   `draft: false`; CI re-runs on `ready_for_review`), then enable squash auto-merge
   while `check` is pending. GitHub refuses auto-merge on a draft.
2. If auto-merge is refused with "clean status": when `check` is green on the PR's
   current head with no review thread open, squash-merge it (`merge_pull_request`,
   `SQUASH`); when it is pending, wait for it and decide again; when it is red, fix it.
3. Subscribe to the PR (`subscribe_pr_activity`) and drive it to merged: fix CI and
   review findings on the same branch. On a conflict, merge `main` in, run `pnpm check`
   (and `pnpm smoke` for renderer changes) and push. The merge should wake the
   session; as a fallback, keep one `send_later` check-in armed, 50 minutes out, that
   reads the PR (`pull_request_read`) and re-arms itself until the PR is merged or the
   session escalates.

### Escalation: when a session stops for Brian
Stop and escalate for:
- a design choice with lasting consequences that the code, the docs, the engine source
  and the Constraints do not settle (data layout, matching an engine quirk versus exact
  values, a public interface other milestones will build on);
- CI still red, or a BROKEN review finding still open, after two fix rounds;
- anything Consent and blast radius says to ask first about, other than what it and
  Driving the PR to merged pre-approve.
To escalate: send `PushNotification` with the question in one line, then ask with
`AskUserQuestion` (options, recommendation first) and wait; where that tool is not
available, end the turn with the question as text. On the answer, continue. Everything
else is decided in-session.

## Git workflow
- Never commit directly to `main`.
- For each task, branch off an up-to-date `main`: `git checkout main && git pull`, then
  `git checkout -b <type>/<short-desc>` (e.g. `feat/multi-map-loader`), or use the
  harness-assigned branch (see Cloud sessions).
- Make focused commits with clear messages.
- Push the branch after each commit (Review loop step 2). When the review loop is done:
  open a PR with `gh pr create` (a real title, and a body summarizing what changed and
  why), or mark the existing draft ready, then run `gh pr merge --auto --squash`. A draft
  PR must be marked ready first.
- If CI checks fail, fix them on the same branch and push again. Never bypass checks or
  merge with `--admin`.
- After the merge, switch back to `main` and pull.
- Where `gh` is not authenticated (cloud sessions), use the GitHub MCP equivalents:
  `create_pull_request`, `update_pull_request` with `draft: false`, then
  `enable_pr_auto_merge` with `SQUASH`.
- `main` is protected and requires the CI `check` job (as of 2026-10-03), so auto-merge
  waits for it. Enable auto-merge as soon as the PR is ready (step 6 of the Review
  loop), while `check` is still pending. If GitHub refuses with "clean status" (nothing
  pending: checks already passed, or the requirement has lapsed), squash-merge it when
  Orchestration's PR step 2 allows; otherwise stop and ask
  the user to merge.

## Project

Quack2: a browser arena shooter that loads Quake 2 BSP (IBSP v38) maps from an open
community map pool. pnpm workspace, TypeScript strict, vitest.

### Commands
- `pnpm install` - install (Node >= 22, pnpm 10).
- `pnpm test` - vitest, all packages.
- `pnpm typecheck` - `tsc` per package; sim is checked twice (src without DOM/Node, tests with Node).
- `pnpm check` - typecheck then test. Run before every commit.
- `pnpm build` / `pnpm dev` - bundle the client with esbuild into `packages/client/dist`
  (fixture BSPs copied to `dist/maps`); `dev` also serves it on :8000 and rebuilds on change.
- `pnpm smoke` - `scripts/smoke-render.mjs`: builds, renders the fixture in headless
  Chromium via Playwright, checks pixels and PVS stats, writes screenshots. Run after
  renderer changes; not part of `check`.
- `scripts/build-ericw-tools.sh` - build the pinned ericw-tools into `.tools/bin` (needs
  cmake, a C++ compiler, `libtbb-dev`, `libembree-dev`). Idempotent.
- `scripts/build-fixture.sh [name]` - compile `fixtures/maps/<name>.map` to `.bsp` and
  regenerate `<name>.golden.json`. Output is byte-identical across runs; if the `.bsp`
  changes, the expected counts in `packages/sim/test/bsp.test.ts` must be re-measured.

### Constraints
- No id Software assets in the repo, ever: no pak files, textures, models, sounds, or
  maps derived from them. `assets/` is gitignored for local game data. Fixture maps are
  original geometry with `quack/*` texture names.
- Missing textures are never fatal, in the compiler pipeline, the parser, or the renderer.
- `packages/sim` uses no DOM and no Node-only APIs; `tsconfig.json` there enforces it
  with `lib: ["ES2022"]` and `types: []`. Node APIs are allowed only in `packages/sim/test`.
- Ports of the C match an SSE (x86-64) build of the engine: C float rounds to IEEE single
  (Math.fround at each float operation and store), C double stays double, and (int) is
  `cInt` (INT_MIN for NaN and out of range), or Math.trunc (GLSL int() in shaders) where
  the value cannot leave int's range or the result is the same. The win32 x87 build (24-bit
  precision from `_controlfp(_PC_24)`, MSVC `_ftol`) is not the reference; comments note
  where it differs only when that is known.
- All coordinates are float. Integer fields on disk (node/leaf bounds) are widened to
  Float32Array at parse time.
- The player box (stock 32x32x56) is defined once, in `packages/sim/src/constants.ts`.
- License GPL-2.0-or-later. Later work ports pmove and trace from the Quake 2 source;
  keep SPDX headers on every source file.
