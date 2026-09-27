# Changelog

Changes to the plugins in the `uehaj-marketplace` marketplace. Versions are the plugin version in
`plugins/<plugin>/.claude-plugin/plugin.json` (kept equal to the entry in `.claude-plugin/marketplace.json`).

## [Unreleased]

### Added
- `uehaj` 0.2.0: `sys1grep`, beside `/uehaj:semgrep`. It runs `@uehaj/sys1grep@0.5.0-next.0` (the renamed
  semgrep) through `npx`. Unlike `semgrep` it is model-invoked: Claude reaches for it on its own when a question
  is about meaning rather than a known string (why did it fail, which commit changed X, where is the key read),
  in place of Grep or reading the whole file. It chooses the deliverable first: `--summarize -Q` for an answer
  (the lines never enter Claude's context), `-n` for locations, and reads only `-C` context or a `sed -n` range
  afterwards. Covers `-g` for git commits, `--dedup` for machine logs, regex prefilters and auto-scope. Measured on
  this repository's git log (1,242 lines): 33,152 input tokens and $0.070 reading it whole, 1,272 tokens and $0.005
  through sys1grep, same answer. Key from `SYS1GREP_API_KEY` or `~/.config/sys1grep/.env`. `/uehaj:semgrep` is unchanged.
- `playground` 0.1.0: function-hook experiments drawing in a pane. `/img` shows a PNG, `/mandel`
  draws the Mandelbrot set, both through the terminal surface's `Image` element.

### Changed
- The marketplace is `uehaj-marketplace` (was `uehaj-skills`) and lives in `uehaj/uehaj-marketplace`
  (was `uehaj/skills`). Installed plugins carry the marketplace name, so an existing install is
  re-added: `/plugin marketplace remove uehaj-skills`, then add the new one.

## [0.1.7] - 2026-09-20

### Changed
- `semgrep`: after a match, do not open the whole target (that cancels the saving); read surroundings with `-C N`
  and only the remaining spots with a `sed -n` line range.

## [0.1.6] - 2026-09-20

### Changed
- `semgrep`: the first pay-off condition is now stated as "you can expect not to read the whole target after
  seeing the matches"; extract-lines tasks qualify, comprehension tasks do not.

## [0.1.5] - 2026-09-20

### Changed
- `semgrep`: step 1 now says when semgrep pays off (extract-lines task, vocabulary not greppable, more than a few
  dozen lines; break-even measured at about 50 lines) and to fall back to direct reading or grep otherwise,
  saying so in one line.

## [0.1.4] - 2026-09-20

### Changed
- `semgrep`: the git log example now folds each commit into one line with subject, body and changed file
  names (`git log --name-only --format='%x00%h %s %b' | tr ... | semgrep`). Subject lines alone miss commits
  whose subject does not mention what they changed.

## [0.1.3] - 2026-09-20

### Changed
- `semgrep`: back to explicit invocation only (`/uehaj:semgrep` or `/semgrep`); `disable-model-invocation: true`
  restored and the trigger conditions removed from the description. Evaluation showed the skill adds nothing
  when Claude picks it for tasks such as whole-codebase comprehension (same accuracy, about 50% more cost),
  so the user decides when to use it.

## [0.1.2] - 2026-09-20

### Changed
- `semgrep`: Claude can now invoke the skill on its own when the user asks to find lines by meaning
  (`disable-model-invocation` removed; trigger conditions moved into the description).
  When invoked without a slash command, the last user message is treated as the arguments.

## [0.1.1] - 2026-09-19

### Changed
- `semgrep`: arguments starting with `-` are passed to semgrep unchanged (`-r`, `-C 2`, `--level strict`, ...).
  If the user writes `-e` / `-a` / `-v` themselves, the expression is used as is.
- Marketplace renamed to `uehaj-skills` (install with `claude plugin install uehaj@uehaj-skills`).
- README: single-skill install via the skills CLI (`npx skills add uehaj/skills --skill semgrep -a claude-code -g`).

## [0.1.0] - 2026-09-19

### Added
- Marketplace `uehaj` with plugin `uehaj`.
- `/uehaj:semgrep`: grep by meaning via `@uehaj/semgrep`; falls back to `npx @uehaj/semgrep` when the CLI is not installed.
