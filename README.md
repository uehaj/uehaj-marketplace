# uehaj/uehaj-marketplace

Claude Code plugin marketplace by [uehaj](https://github.com/uehaj). Two plugins:
`uehaj` holds the skills, so every skill is `/uehaj:<skill>`; `playground` holds function-hook
experiments that draw in a pane.

```sh
claude plugin marketplace add uehaj/uehaj-marketplace   # or: /plugin marketplace add uehaj/uehaj-marketplace
claude plugin install uehaj@uehaj-marketplace           # the skills
claude plugin install playground@uehaj-marketplace      # the pane experiments
```

Update later with `claude plugin marketplace update uehaj-marketplace`.

To install a single skill instead of the whole plugin, use the [skills CLI](https://skills.sh/).
It copies the skill into `~/.claude/skills/` (with `-g`) or `./.claude/skills/`, and the skill is then
invoked without the plugin prefix (`/sys1grep` instead of `/uehaj:sys1grep`).

```sh
npx skills add uehaj/uehaj-marketplace --skill sys1grep -a claude-code -g
```

## Skills

| Skill | What it does | Needs |
|---|---|---|
| `/uehaj:sys1grep <meaning> [files]` | grep by meaning, with sys1grep 0.5.0-next.0 (the renamed semgrep): the same, plus git commits (`-g`) and auto-scope by time, language, place, author and git state. | [`@uehaj/sys1grep@0.5.0-next.0`](https://github.com/uehaj/sys1grep), run through `npx`, and a TypeSafe API key |
| `/uehaj:semgrep <meaning> [files]` | grep by meaning. Finds lines that match a described meaning, in any language, with AND / OR / NOT. | [`@uehaj/semgrep`](https://github.com/uehaj/jev-semgrep) (`npm install -g @uehaj/semgrep`, or the skill falls back to `npx`) and a TypeSafe API key |

## Playground

Experiments on Claude Code's function-hooks API, which draws in a pane beside the transcript.
They need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in `~/.claude/settings.json`.

| Command | What it does |
|---|---|
| `/img </abs/path.png>` | shows a PNG in a pane, through the terminal surface's native `Image` element |
| `/mandel [cx cy width]` | draws the Mandelbrot set, computed into RGBA bytes and handed to the same element |

Both use kitty graphics, so they need a terminal that has it (kitty, Ghostty). Claude Code decides
by the name the terminal reports, and a libghostty-based multiplexer such as herdr reports
`libghostty`, which is not on that list — the image then falls back to its alt text. Set
`CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` there; the probe itself succeeds, only the name check fails.

## Layout

```
.claude-plugin/marketplace.json     the catalog (marketplace name: uehaj-marketplace)
plugins/uehaj/
  .claude-plugin/plugin.json        the plugin (name: uehaj)
  skills/<skill>/SKILL.md           one folder per skill
plugins/playground/
  .claude-plugin/plugin.json        the plugin (name: playground)
  hooks/hooks.json                  names the module the engine loads
  hooks/register.tsx                registers both commands, then each file's hooks
  hooks/{img,mandel}.tsx            one command each
  hooks/pane.ts                     base64 without Buffer, and the pane's size in cells
```

Tools the skills call live in their own repositories; this repository holds only the skills.

## License

MIT
