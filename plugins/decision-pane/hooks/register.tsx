import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Item, Mark } from '../types'

const PANE = 'decision-pane'
const FILE = 'decisions.md'
const OPEN = '- [ ] '
const HELD = '- [~] '
const PREFIX: Record<Mark, string> = { open: OPEN, held: HELD, done: '- [x] ' }
const COMMENT = '- コメント '
const items = atom({ plugin: 'decision-pane', key: 'items' } as const, [] as Item[])
const isHeldOpen = atom({ plugin: 'decision-pane', key: 'isHeldOpen' } as const, false)
const isDoneOpen = atom({ plugin: 'decision-pane', key: 'isDoneOpen' } as const, false)

let seenMtime = -1

const isChild = (l: string) => /^\s+\S/.test(l)
const markOf = (l: string) => (Object.keys(PREFIX) as Mark[]).find(m => l.startsWith(PREFIX[m]))
const STAMPED = / \((?:保留|承認) ([^()]*)\)\s*$/
// The item's text: the line less its mark and its `(保留 ...)` or `(承認 ...)`.
const textOf = (l: string) => l.slice(OPEN.length).replace(STAMPED, '').trimEnd()
const lineOf = (l: string, item: Item) => l.startsWith(PREFIX[item.mark]) && textOf(l) === item.text

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

async function load($: Engine, force = false) {
  const stat = await $.fs.stat(FILE).catch(() => undefined)
  const mtime = stat?.mtimeMs ?? 0
  if (!force && mtime === seenMtime) return
  seenMtime = mtime
  const all = parse(stat ? await $.fs.read(FILE) : '')
  await update($, items, () => all)
  const held = all.filter(item => item.mark === 'held').length
  const open = all.filter(item => item.mark === 'open').length
  $.ui.status(open || held ? `未決 ${open}${held ? `・保留 ${held}` : ''}` : undefined)
}

function stamp(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Rewrites the file around the item's line; a line gone since the draw is left alone.
async function edit($: Engine, item: Item, change: (lines: string[], i: number, at: string) => void) {
  const lines = (await $.fs.read(FILE)).split('\n')
  const i = lines.findIndex(l => lineOf(l, item))
  if (i >= 0) {
    change(lines, i, stamp(await $.clock.now()))
    await $.fs.write(FILE, lines.join('\n'))
  }
  await load($, true)
}

const approve = ($: Engine, item: Item) =>
  edit($, item, (lines, i, at) => { lines[i] = `- [x] ${item.text} (承認 ${at})` })

const hold = ($: Engine, item: Item) =>
  edit($, item, (lines, i, at) => { lines[i] = `${HELD}${item.text} (保留 ${at})` })

const resume = ($: Engine, item: Item) =>
  edit($, item, (lines, i) => { lines[i] = `${OPEN}${item.text}` })

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
    await $.command.register({ name: 'decisions', description: 'decisions.md の未決をペインに出す' })
    void $.ui.open({ id: PANE, title: 'Decisions' })
    await load($, true)
    $.clock.every(3000, () => load($))
    return next(e)
  })

  on('command.run', { command: 'decisions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Decisions' })
    return { text: 'Decisions ペインを開いた。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Input = 'Input' in table ? table.Input : undefined
    const all = await read($, items)
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
      if (c) return <Text><Text color="suggestion" bold>💬 あなた</Text> <Text dimColor>{c[1]}</Text>  {c[2]}</Text>
      const a = note.match(/^- 回答: (.*)$/)
      if (a) return <Text><Text color="claude" bold>🤖 AI</Text>  {a[1]}</Text>
      return <Text dimColor>{note}</Text>
    }

    const heldSection = held.length > 0 && (
      <Box flexDirection="column" marginTop={1}>
        <Button key="held-toggle" plain onPress={() => update($, isHeldOpen, v => !v)}>
          {showHeld ? '▾' : '▸'} <Text color="subtle">⏸ 保留 {held.length} 件</Text>
        </Button>
        {showHeld && held.map((item, j) => (
          <Box key={`held-${j}`} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text dimColor>⏸ {item.text}</Text>
            {item.notes.map(noteLine)}
            <Button key={`resume-${j}`} onPress={() => resume($, item)}>▶ 戻す</Button>
          </Box>
        ))}
      </Box>
    )

    const doneSection = done.length > 0 && (
      <Box flexDirection="column" marginTop={held.length > 0 ? 0 : 1}>
        <Button key="done-toggle" plain onPress={() => update($, isDoneOpen, v => !v)}>
          {showDone ? '▾' : '▸'} <Text color="success">✅ 決着 {done.length} 件</Text>
        </Button>
        {showDone && done.map((item, j) => (
          <Box key={`done-${j}`} flexDirection="column" borderStyle="round" borderColor="success" paddingX={1}>
            <Text><Text color="success">✅</Text> {item.text}</Text>
            {item.at && <Text dimColor>承認 {item.at}</Text>}
            {item.notes.map(noteLine)}
          </Box>
        ))}
      </Box>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text color="success" bold>✨ 未決なし</Text>
          <Text dimColor>{FILE} に `- [ ] 文面` を足すとここに出る</Text>
          {heldSection}
          {doneSection}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>
          📋 未決 {list.length} 件
          <Text dimColor>（<Text color="warning">あなた {list.length - waitingAi}</Text>・AI {waitingAi}）</Text>
        </Text>
        {list.map((item, i) => {
          const isAi = aiTurn(item)
          return (
            <Box key={`row-${i}`} flexDirection="column" borderStyle="round"
              borderColor={isAi ? 'subtle' : 'warning'} paddingX={1}>
              {isAi
                ? <Text color="subtle">⏳ AI の回答待ち</Text>
                : <Text color="warning" bold>👉 あなたの判断待ち</Text>}
              <Text bold>❓ {item.text}</Text>
              {item.notes.map(noteLine)}
              {Input && (
                <Input key={`c-${i}`} label="💬 " placeholder="コメント・質問（Enter で送る）" submitLabel="送る"
                  onSubmit={value => comment($, item, value)} />
              )}
              <Box flexDirection="row" gap={1}>
                <Button key={`ok-${i}`} variant="primary" onPress={() => approve($, item)}>✔ OK</Button>
                <Button key={`hold-${i}`} onPress={() => hold($, item)}>⏸ 保留</Button>
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
