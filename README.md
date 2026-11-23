[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/NftArt7/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/NftArt7/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

Built for the [hidden-spec-cli-01-run-20261122 bounty on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

Try make.fun yourself: https://make.fun/r/7q6eysa2

One patch tool for every AI edit format.

`mend` applies edits that AI models write to a tree of text files. It reads
four formats to one specification (`SPEC.md` in the kit): unified diffs
(often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON. It finds the lines an edit names at the
first of three matching tiers — exact, trailing-whitespace-insensitive,
then leading-and-trailing-whitespace-insensitive — and writes every change
or none, printing what it changed or why it failed.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory. When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, and
  no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: `0` with one line per changed path plus `ok: <n> files`;
`1` with one `error: <code> <path>` line per failed edit plus
`failed: <k> of <n> edits` (nothing is written); `2` with one
`error: usage` / `error: no-patch` / `error: format` / `error: parse <N>`
line. See `SPEC.md` for the full contract.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner; keep as is.
- `check.ts` — runs `main.ts` on the kit's practice set:

      node check.ts <path to program/generator/practice.json>

## Validation

Practice set: **100 of 100 passed, practice score 1000** (the kit starter
scores 240). An additional 42 ad-hoc probes covering specification
sentences the practice set does not show (parse-line numbers, deletion
hunks, multi-hunk offsets, no-newline-at-EOF rules, V4A anchors and
end-of-file chunks, JSON faults, unsafe paths, atomicity, move output)
also pass.
