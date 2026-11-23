# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wordbadha/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wordbadha/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

A single Node 22 CLI (`main.ts`) that applies AI-written edits to a tree of
files, in four formats: unified diffs, SEARCH/REPLACE blocks, V4A patches,
and JSON tool calls — built for the make.fun bounty [Build mend, one patch
tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
It finds the lines to change even when the patch's line
numbers are wrong and its whitespace or indentation drifted, and it changes
every file or none: a failed edit changes nothing, later edits still run, and
the run reports every failure.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a patch file, or `-` / omitted to read stdin.
- `--format` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (default). Auto-detection looks at the first non-blank line and the shape
  of the lines: `*** Begin Patch` is V4A, a leading `[` or `{` is JSON, a
  `<<<<<<< SEARCH` line is SEARCH/REPLACE, a `diff --git` or `--- `+`+++ `
  pair is a unified diff; anything else is a format error.
- `--check` applies nothing; it only reports what would change.
- `--strict` matches lines exactly (tier 0 only). Without it, a block is
  found at the first tier that matches at least once: exact, then trailing
  whitespace ignored, then leading and trailing whitespace ignored. Context
  lines are written as the file's own matched lines, and at the loosest tier
  replacement lines are re-indented to the file's indentation.

## Exit codes and output

- `0` — all edits applied (or, with `--check`, would apply). Prints one
  `A`/`D`/`M` line per changed file, or `R <old> -> <new>` for a move, then
  `ok: <n> file(s)`. With no changes the output is just `ok: 0 files`.
- `1` — one or more edits failed. Prints `error: <code> <path>` per failed
  edit (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`) and then
  `failed: <k> of <n> edits`. No file is written.
- `2` — usage, no-patch, format, or parse error. Prints a single
  `error: <code>` line (`usage`, `no-patch`, `format`, or `parse <n>`).

## Safety

- Paths must be non-empty, relative, and contain no backslash or empty,
  `.`, or `..` segments; anything else is `error: unsafe <path>`.
- All paths are checked before anything is applied, and the tree is written
  only after every edit succeeds, so a failed run leaves every file intact.
- Files are UTF-8; a file keeps its own line break (CRLF iff its first line
  break is CRLF) and its final line break unless the patch says otherwise.
  Created files use LF and end with a line break. No file is larger than
  1 MiB, and the source tree is under 4 MiB in total.

## Files

- `main.ts` — the CLI (Node 22 standard library only; run with
  `node main.ts`, no build step, nothing installed).
- `runner.ts` — the kit's trial runner, kept as provided; it takes over when
  `MAKEFUN_ENV_URL` is set.

## License

MIT — see `LICENSE`.
