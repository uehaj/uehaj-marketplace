import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Item } from '../types'

const PANE = 'decision-pane'
const FILE = 'decisions.md'
const OPEN = '- [ ] '
const items = atom({ plugin: 'decision-pane', key: 'items' } as const, [] as Item[])

let seenMtime = -1

const isChild = (l: string) => /^\s+\S/.test(l)
const textOf = (l: string) => l.slice(OPEN.length).trimEnd()

function parse(text: string): Item[] {
  const lines = text.split('\n')
  return lines.flatMap((l, i) => {
    if (!l.startsWith(OPEN)) return []
    const notes: string[] = []
    for (let j = i + 1; j < lines.length && isChild(lines[j]!); j++) notes.push(lines[j]!.trim())
    return [{ text: textOf(l), notes }]
  })
}

async function load($: Engine, force = false) {
  const stat = await $.fs.stat(FILE).catch(() => undefined)
  const mtime = stat?.mtimeMs ?? 0
  if (!force && mtime === seenMtime) return
  seenMtime = mtime
  const open = parse(stat ? await $.fs.read(FILE) : '')
  await update($, items, () => open)
  $.ui.status(open.length ? `未決 ${open.length}` : undefined)
}

function stamp(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Rewrites the file around the open line whose text is `text`; a line gone since the draw is left alone.
async function edit($: Engine, text: string, change: (lines: string[], i: number, at: string) => void) {
  const lines = (await $.fs.read(FILE)).split('\n')
  const i = lines.findIndex(l => l.startsWith(OPEN) && textOf(l) === text)
  if (i >= 0) {
    change(lines, i, stamp(await $.clock.now()))
    await $.fs.write(FILE, lines.join('\n'))
  }
  await load($, true)
}

const approve = ($: Engine, text: string) =>
  edit($, text, (lines, i, at) => { lines[i] = `- [x] ${text} (承認 ${at})` })

const comment = ($: Engine, text: string, body: string) =>
  body.trim()
    ? edit($, text, (lines, i, at) => {
        let end = i + 1
        while (end < lines.length && isChild(lines[end]!)) end++
        lines.splice(end, 0, `  - コメント ${at}: ${body.trim()}`)
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
    const list = await read($, items)
    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>未決なし（{FILE} に `- [ ] 文面` を足す）</Text>}
        {list.map((item, i) => (
          <Box key={`row-${i}`} flexDirection="column" marginBottom={1}>
            <Text bold>{item.text}</Text>
            {item.notes.map(note => <Text dimColor>  {note}</Text>)}
            {Input && (
              <Input key={`c-${i}`} placeholder="コメント・質問（Enter で送る）" submitLabel="送る"
                onSubmit={value => comment($, item.text, value)} />
            )}
            <Button key={`ok-${i}`} variant="primary" onPress={() => approve($, item.text)}>OK</Button>
          </Box>
        ))}
      </Box>
    )
  })
}
