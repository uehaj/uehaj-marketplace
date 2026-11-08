import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Item, Mark } from '../types'

const PANE = 'decision-pane'
const FILE = 'decisions.md'
const OPEN = '- [ ] '
const HELD = '- [~] '
const PREFIX: Record<Mark, string> = { open: OPEN, held: HELD, done: '- [x] ' }
const COMMENT = '- コメント '
const CHOSEN = '- 選択: '
// A child line `- (a) text` is an option: the pane shows it as a button that settles the item with that choice.
const OPTION = /^- \(([a-z])\) (.+)$/i // one letter, so a note like `- (注) …` or `- (1) …` stays a note
const items = atom({ plugin: 'decision-pane', key: 'items' } as const, [] as Item[])
const isHeldOpen = atom({ plugin: 'decision-pane', key: 'isHeldOpen' } as const, false)
const isDoneOpen = atom({ plugin: 'decision-pane', key: 'isDoneOpen' } as const, false)
const hasFile = atom({ plugin: 'decision-pane', key: 'hasFile' } as const, true)
const lang = atom({ plugin: 'decision-pane', key: 'lang' } as const, 'en' as Lang)

// What the pane says. The marks it writes into decisions.md (承認, 保留, コメント, 回答) are the file's contract and
// stay Japanese in every language.
type Lang = 'en' | 'ja'
const T = {
  en: {
    status: (open: number, held: number) => `open ${open}${held ? ` · held ${held}` : ''}`,
    cmd: 'Show the open items of decisions.md in a pane', opened: 'Opened the Decisions pane.',
    you: 'you', ai: 'AI', lp: ' (', sep: ', ', rp: ')', held: (n: number) => `⏸ Held ${n}`, resume: '▶ Resume', reopen: '↩ Reopen', settled: (n: number) => `✅ Settled ${n}`,
    approved: 'approved', chose: 'chose', none: '✨ Nothing open', howTo: `Add a \`- [ ] text\` line to ${FILE} to list it here`,
    setup: `⚙ No ${FILE} yet. For the AI to write its questions there and get your OK and comments, CLAUDE.md needs a section (decision-pane README, "What to add to CLAUDE.md")`,
    open: (n: number) => `📋 Open ${n}`, aiTurn: '⏳ Waiting on the AI', yourTurn: '👉 Waiting on you',
    comment: 'Comment or question (Enter sends)', send: 'Send', hold: '⏸ Hold',
  },
  ja: {
    status: (open: number, held: number) => `未決 ${open}${held ? `・保留 ${held}` : ''}`,
    cmd: 'decisions.md の未決をペインに出す', opened: 'Decisions ペインを開いた。',
    you: 'あなた', ai: 'AI', lp: '（', sep: '・', rp: '）', held: (n: number) => `⏸ 保留 ${n} 件`, resume: '▶ 戻す', reopen: '↩ 未決に戻す', settled: (n: number) => `✅ 決着 ${n} 件`,
    approved: '承認', chose: '選択', none: '✨ 未決なし', howTo: `${FILE} に \`- [ ] 文面\` を足すとここに出る`,
    setup: `⚙ ${FILE} がまだ無い。AI に問いを書かせ、OK やコメントを届けるには、CLAUDE.md への追記が要る（decision-pane の README「CLAUDE.md に足すもの」）`,
    open: (n: number) => `📋 未決 ${n} 件`, aiTurn: '⏳ AI の回答待ち', yourTurn: '👉 あなたの判断待ち',
    comment: 'コメント・質問（Enter で送る）', send: '送る', hold: '⏸ 保留',
  },
}

// Claude Code's own language setting when /config has one, else LC_ALL / LANG; English otherwise.
async function langOf($: Engine): Promise<Lang> {
  const set = await $.config.list().then(rows => rows.find(r => r.key === 'language')?.value, () => undefined)
  const env = set === undefined || set === '' ? await $.env.get('LC_ALL').catch(() => undefined) || await $.env.get('LANG').catch(() => undefined) : undefined
  return /^(ja|japanese|日本語)/i.test(String(set ?? env ?? '')) ? 'ja' : 'en'
}

let seenMtime = -1

const isChild = (l: string) => /^\s+\S/.test(l)
const markOf = (l: string) => (Object.keys(PREFIX) as Mark[]).find(m => l.startsWith(PREFIX[m]))
const STAMPED = / \((?:保留|承認) ([^()]*)\)\s*$/
// The item's text: the line less its mark and its `(保留 ...)` or `(承認 ...)`.
const textOf = (l: string) => l.slice(OPEN.length).replace(STAMPED, '').trimEnd()
// a stamped item also matches by its stamp, so of two settled items with the same text the pressed one changes
const lineOf = (l: string, item: Item) =>
  l.startsWith(PREFIX[item.mark]) && textOf(l) === item.text && (item.at === undefined || l.match(STAMPED)?.[1] === item.at)

function parse(text: string): Item[] {
  const lines = text.split('\n')
  return lines.flatMap((l, i) => {
    const mark = markOf(l)
    if (!mark) return []
    const notes: string[] = []
    for (let j = i + 1; j < lines.length && isChild(lines[j]!); j++) notes.push(lines[j]!.trim())
    const at = l.match(STAMPED)?.[1]
    return [{ text: textOf(l), notes, mark, ...(at && mark !== 'open' ? { at } : {}) }]
  })
}

// The decisions.md this pane shows: the nearest regular file (not a link) at or above the working directory, but
// never above the repository root (the first folder with a .git directory; a worktree's .git file does not stop the
// walk), so a session that cd's into a subfolder or a nested worktree keeps the repository's list, and a stray
// decisions.md above the repository is never read or written. Outside any repository: the working directory's own.
let path = FILE
const UP = 12
async function find($: Engine) {
  const stat = (p: string) => $.fs.stat(p).catch(() => undefined)
  const regular = (st: Awaited<ReturnType<typeof stat>>) => (st?.kind === 'file' && !st.isLink ? st : undefined)
  let found: { p: string, stat: Awaited<ReturnType<typeof stat>> } | undefined
  for (let k = 0; k <= UP; k++) {
    const up = '../'.repeat(k)
    const f = await stat(up + FILE)
    if (!found && regular(f)) found = { p: up + FILE, stat: f }
    if ((await stat(up + '.git'))?.kind === 'dir') return found ?? { p: FILE, stat: regular(await stat(FILE)) }
  }
  const here = await stat(FILE) // no repository root within reach: only the working directory's own
  return { p: FILE, stat: regular(here) }
}

async function load($: Engine, force = false) {
  const { p, stat } = await find($)
  const mtime = stat?.mtimeMs ?? 0
  if (!force && p === path && mtime === seenMtime) return
  path = p
  seenMtime = mtime
  const all = parse(stat ? await $.fs.read(path) : '')
  await update($, items, () => all)
  await update($, hasFile, () => !!stat)
  const held = all.filter(item => item.mark === 'held').length
  const open = all.filter(item => item.mark === 'open').length
  $.ui.status(open || held ? T[await read($, lang)].status(open, held) : undefined)
}

function stamp(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Rewrites the file around the item's line; a line gone since the draw is left alone.
async function edit($: Engine, item: Item, change: (lines: string[], i: number, at: string) => void) {
  // the file may have changed since find(): a link or a non-file now is left alone
  const st = await $.fs.stat(path).catch(() => undefined)
  if (st?.kind !== 'file' || st.isLink) return load($, true)
  const lines = (await $.fs.read(path)).split('\n')
  const i = lines.findIndex(l => lineOf(l, item))
  if (i >= 0) {
    change(lines, i, stamp(await $.clock.now()))
    await $.fs.write(path, lines.join('\n'))
  }
  await load($, true)
}

const settled = (item: Item, at: string) => `- [x] ${item.text} (承認 ${at})`

const approve = ($: Engine, item: Item) =>
  edit($, item, (lines, i, at) => { lines[i] = settled(item, at) })

// Settles the item with one of its options: the line as OK writes it, plus a `- 選択: (a) text` child line.
const choose = ($: Engine, item: Item, option: string) =>
  edit($, item, (lines, i, at) => {
    lines[i] = settled(item, at)
    let end = i + 1
    while (end < lines.length && isChild(lines[end]!)) end++
    lines.splice(end, 0, `  ${CHOSEN}${option}`)
  })

const hold = ($: Engine, item: Item) =>
  edit($, item, (lines, i, at) => { lines[i] = `${HELD}${item.text} (保留 ${at})` })

const resume = ($: Engine, item: Item) =>
  edit($, item, (lines, i) => { lines[i] = `${OPEN}${item.text}` })

// Puts a settled item back to open, dropping the `- 選択:` line its option button added.
const reopen = ($: Engine, item: Item) =>
  edit($, item, (lines, i) => {
    lines[i] = `${OPEN}${item.text}`
    for (let j = i + 1; j < lines.length && isChild(lines[j]!);) {
      if (lines[j]!.trim().startsWith(CHOSEN)) lines.splice(j, 1)
      else j++
    }
  })

const comment = ($: Engine, item: Item, body: string) =>
  body.trim()
    ? edit($, item, (lines, i, at) => {
        let end = i + 1
        while (end < lines.length && isChild(lines[end]!)) end++
        lines.splice(end, 0, `  ${COMMENT}${at}: ${body.trim()}`)
      })
    : undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const l = await langOf($)
    await update($, lang, () => l)
    await $.command.register({ name: 'decisions', description: T[await read($, lang)].cmd })
    void $.ui.open({ id: PANE, title: 'Decisions' })
    await load($, true)
    $.clock.every(3000, () => load($))
    return next(e)
  })

  on('command.run', { command: 'decisions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Decisions' })
    return { text: T[await read($, lang)].opened }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Input = 'Input' in table ? table.Input : undefined
    const all = await read($, items)
    const t = T[await read($, lang)]
    const list = all.filter(item => item.mark === 'open')
    const held = all.filter(item => item.mark === 'held')
    // Newest settlement first: an approved line stays where it was in the file.
    const done = all.filter(item => item.mark === 'done').sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    const showHeld = await read($, isHeldOpen)
    const showDone = await read($, isDoneOpen)
    const aiTurn = (item: Item) => item.notes.at(-1)?.startsWith(COMMENT) ?? false
    const waitingAi = list.filter(aiTurn).length

    const noteLine = (note: string) => {
      const c = note.match(/^- コメント \d{4}-\d\d-\d\d (\d\d:\d\d): (.*)$/)
      if (c) return <Text><Text color="suggestion" bold>💬 {t.you}</Text> <Text dimColor>{c[1]}</Text>  {c[2]}</Text>
      const a = note.match(/^- 回答: (.*)$/)
      if (a) return <Text><Text color="claude" bold>🤖 AI</Text>  {a[1]}</Text>
      if (note.startsWith(CHOSEN)) return <Text><Text color="success" bold>☑ {t.chose}</Text>  {note.slice(CHOSEN.length)}</Text>
      return <Text dimColor>{note}</Text>
    }

    const heldSection = held.length > 0 && (
      <Box flexDirection="column" marginTop={1}>
        <Button key="held-toggle" plain onPress={() => update($, isHeldOpen, v => !v)}>
          {showHeld ? '▾' : '▸'} <Text color="subtle">{t.held(held.length)}</Text>
        </Button>
        {showHeld && held.map((item, j) => (
          <Box key={`held-${j}`} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text dimColor>⏸ {item.text}</Text>
            {item.notes.map(noteLine)}
            <Button key={`resume-${j}`} onPress={() => resume($, item)}>{t.resume}</Button>
          </Box>
        ))}
      </Box>
    )

    const doneSection = done.length > 0 && (
      <Box flexDirection="column" marginTop={held.length > 0 ? 0 : 1}>
        <Button key="done-toggle" plain onPress={() => update($, isDoneOpen, v => !v)}>
          {showDone ? '▾' : '▸'} <Text color="success">{t.settled(done.length)}</Text>
        </Button>
        {showDone && done.map((item, j) => (
          <Box key={`done-${j}`} flexDirection="column" borderStyle="round" borderColor="success" paddingX={1}>
            <Text><Text color="success">✅</Text> {item.text}</Text>
            {item.at && <Text dimColor>{t.approved} {item.at}</Text>}
            {item.notes.map(noteLine)}
            <Button key={`reopen-${j}`} onPress={() => reopen($, item)}>{t.reopen}</Button>
          </Box>
        ))}
      </Box>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text color="success" bold>{t.none}</Text>
          <Text dimColor>{t.howTo}</Text>
          {!(await read($, hasFile)) && (
            // no decisions.md yet: the usual cause on a fresh install is a CLAUDE.md that never tells the AI to write one
            <Text color="warning">{t.setup}</Text>
          )}
          {heldSection}
          {doneSection}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>
          {t.open(list.length)}
          <Text dimColor>{t.lp}<Text color="warning">{t.you} {list.length - waitingAi}</Text>{t.sep}{t.ai} {waitingAi}{t.rp}</Text>
        </Text>
        {list.map((item, i) => {
          const isAi = aiTurn(item)
          return (
            <Box key={`row-${i}`} flexDirection="column" borderStyle="round"
              borderColor={isAi ? 'subtle' : 'warning'} paddingX={1}>
              {isAi
                ? <Text color="subtle">{t.aiTurn}</Text>
                : <Text color="warning" bold>{t.yourTurn}</Text>}
              <Text bold>❓ {item.text}</Text>
              {item.notes.filter(n => !OPTION.test(n)).map(noteLine)}
              {item.notes.filter(n => OPTION.test(n)).map((n, j) => (
                <Button key={`pick-${i}-${j}`} onPress={() => choose($, item, n.slice(2))}>{n.slice(2)}</Button>
              ))}
              {Input && (
                <Input key={`c-${i}`} label="💬 " placeholder={t.comment} submitLabel={t.send}
                  onSubmit={value => comment($, item, value)} />
              )}
              <Box flexDirection="row" gap={1}>
                <Button key={`ok-${i}`} variant="primary" onPress={() => approve($, item)}>✔ OK</Button>
                <Button key={`hold-${i}`} onPress={() => hold($, item)}>{t.hold}</Button>
              </Box>
            </Box>
          )
        })}
        {heldSection}
        {doneSection}
      </Box>
    )
  })
}
