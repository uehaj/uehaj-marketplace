# decision-pane

English | [日本語](README.ja.md)

A Claude Code mod that lists the open lines of the nearest `decisions.md` (in the working directory or above it) in a pane, and rewrites one as approved with a single OK button. It calls no model.

![The Decisions pane beside the transcript: one card per open item with OK and Hold buttons, the folded held and settled sections, and the counts in the status line](docs/screenshot.png)

<img src="docs/screenshot-desktop.png" width="320" alt="The same pane in the desktop app: cards with a comment field, a Send button, and OK and Hold buttons">

## Usage

- The pane opens when a session starts. When the terminal is too narrow for it to open, open it with `/decisions`.
- The status line shows the counts (`open N`, or `open N · held M` when something is held).
- Each open item shows its child lines (comments and the AI's answers), option buttons (if any), a comment field, and the OK and Hold buttons. The comment field appears only in the terminal and the desktop app (mobile has no input element).
- The `decisions.md` used is the first one found going up from the working directory to the top of the git repository (where the `.git` folder is), so a subfolder or a worktree inside still shows the repository's. Outside a repository, only the working directory's. Symbolic links are not read.
- `decisions.md` is checked every 3 seconds and read again only when its modification time changes.
- The pane text is in English or Japanese: Claude Code's language from `/config` when set, else `LC_ALL` / `LANG`; English otherwise. The marks written into `decisions.md` (`承認`, `保留`, `コメント`, `回答`, `選択`) stay Japanese in every language, since they are the contract below.

## The format of decisions.md (the contract)

| Line | Meaning |
|---|---|
| starts with `- [ ] ` | Open. Shown in the pane |
| starts with `- [x] ` | Approved (settled). Shown in the folded settled section, newest approval first |
| starts with `- [~] ` | Held. Shown in the folded held section. Neither the AI's turn nor yours |

Indented lines right after an open line are shown as that item's child lines.

**OK** rewrites the line as below and moves it to the settled section. It does not touch the child lines or any other line.

```
- [ ] text
↓
- [x] text (承認 YYYY-MM-DD HH:MM)
```

**Options**: child lines of the form `- (a) description` (one ASCII letter in the parentheses; `(注)` or `(1)` stay ordinary child lines) are shown as buttons instead of child lines. Pressing one rewrites the line as `- [x] … (承認 …)`, like OK, and adds the choice as the last child line.

```
- [ ] Storage: which one. Recommended: (a)
  - (a) SQLite
  - (b) Postgres
↓ press (b)
- [x] Storage: which one. Recommended: (a) (承認 YYYY-MM-DD HH:MM)
  - (a) SQLite
  - (b) Postgres
  - 選択: (b) Postgres
```

OK still works when there are options; it means approval of the recommended one.

Typing in the **comment field** and pressing Enter adds the comment as the last child line, and the item stays open.

```
- [ ] text
  - 回答: ...                              ← a child line the AI wrote earlier
  - コメント YYYY-MM-DD HH:MM: body        ← added by the mod
```

An AI that gets a comment answers by adding `  - 回答: ...` as a child line, and rewrites the text after `- [ ] ` if needed. The mod tells items apart by their text, so the child lines follow a rewritten text.

**Hold** rewrites the open line as below and moves it to the folded held section below the pane, child lines and all. Open the held section and press **Resume** to put it back as `- [ ] text`.

```
- [ ] text
↓
- [~] text (保留 YYYY-MM-DD HH:MM)
```

Open the settled section and press **Reopen** to turn `- [x] text (承認 …)` back into `- [ ] text`. Child lines starting with `- 選択: ` (added by an option button or by hand) are removed; other child lines stay.

Times are local time.

## How a change reaches the AI

This mod sends nothing to the AI. Approvals and comments reach it through Claude Code itself: when a file the AI has read with the Read tool is changed from outside, Claude Code attaches the diff the next time the AI runs (when you send something, when a background task's completion notice arrives, and so on). So if the AI reads `decisions.md` with the Read tool at the start of the session, the buttons' rewrites reach it on the next exchange. Files read only through Bash, such as `cat` or `grep`, are not covered. Pressing a button alone does not make the AI run.

From the diff, the AI only needs to look at:

- `- [x] ` at the start of a line and `(承認 ...)` at its end mean approved: with the option in a `- 選択: (b) ...` child line if there is one, else the recommended one
- under an open `- [ ] ` item, a last child line starting with `- コメント ` means it is the AI's turn
- `- [~] ` at the start of a line means held: nobody's turn, safe to ignore

## What to add to CLAUDE.md

Installing the mod alone does not make the AI write its questions to `decisions.md` or notice the changes. Add a section like this to CLAUDE.md (`~/.claude/CLAUDE.md` for the user scope).

```markdown
## Write unanswered questions to decisions.md

- Questions and approvals waiting on the user that have no answer yet go into `decisions.md` in the working directory.
  One per line: `- [ ] <subject>: <what to decide>. Recommended: <option>`. Details go in child lines indented by 2 spaces.
  When there are several options, write one `  - (a) <option>` child line per option (they become buttons in the pane).
- A `- [x]` line with a `- 選択: (b) ...` child line was approved with that option; without one, with the recommended one.
- If the file does not exist, create it with a heading, and add `decisions.md` to `.git/info/exclude` to keep it out of commits.
- Do not rewrite `- [x]` (approved) or `- [~]` (held) lines.
- The first time in a session you touch `decisions.md`, read it with the Read tool, not Bash. Then approvals and comments in the pane reach you as a diff on the next exchange.
```

## No warranty

Provided as is.
