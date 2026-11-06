import { expect, mock, test } from 'claude-code/testing'

const PROPS = { title: 'Decisions', isFocused: false, bodyColumns: 60, placement: 'dock' } as any
const STAMP = '\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`OK・コメント・保留・決着が decisions.md の契約どおりに書く (${surface})`, async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 12, 3, 30) })
    let file = '# memo\n- [x] 済み (承認 2026-10-01 09:00)\n- [ ] API は $1 REST\n  - 回答: 前の答え\n- [ ] 保存先は SQLite\n'
    on('fs.stat', () => ({ value: { kind: 'file', size: file.length, mtimeMs: file.length, isLink: false } }) as any)
    on('fs.read', () => ({ value: file }))
    on('fs.write', (_$, e) => { file = e.text; return { value: undefined } })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('config.list', () => ({ value: [] }) as any)
    on('env.get', (_$, e: any) => ({ value: e.name === 'LANG' ? 'ja_JP.UTF-8' : undefined }) as any)
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true } }) as any)
    on('ui.status', () => ({ value: undefined }))
    await $.session.start({ cwd: '/w', surface, isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'decision-pane', surface, component: 'Pane', props: PROPS, requestId: 'decision-pane' })
    const drawn = async () => JSON.stringify(await ui.drawn())

    await ui.input({ key: 'c-1', text: '  なぜ SQLite？  ' })
    await ui.input({ key: 'c-1', text: '   ' })
    let lines = file.split('\n')
    expect(lines[4]).toBe('- [ ] 保存先は SQLite')
    expect(lines[5]).toMatch(new RegExp(`^  - コメント ${STAMP}: なぜ SQLite？$`))
    expect(lines[6]).toBe('')
    expect(await drawn()).toContain('AI の回答待ち')

    await ui.press({ key: 'hold-0' })
    lines = file.split('\n')
    expect(lines[2]).toMatch(new RegExp(`^- \\[~\\] API は \\$1 REST \\(保留 ${STAMP}\\)$`))
    expect(lines[3]).toBe('  - 回答: 前の答え')
    expect(await ui.find({ key: 'resume-0' })).toBeUndefined()

    await ui.press({ key: 'held-toggle' })
    await ui.press({ key: 'resume-0' })
    expect(file.split('\n')[2]).toBe('- [ ] API は $1 REST')
    expect(await drawn()).not.toContain('保留 1 件')

    await ui.press({ key: 'ok-0' })
    lines = file.split('\n')
    expect(lines[2]).toMatch(new RegExp(`^- \\[x\\] API は \\$1 REST \\(承認 ${STAMP}\\)$`))
    expect(lines[3]).toBe('  - 回答: 前の答え')
    expect(lines[1]).toBe('- [x] 済み (承認 2026-10-01 09:00)')
    expect(await ui.find({ key: 'ok-1' })).toBeUndefined()

    expect(await drawn()).toContain('決着 2 件')
    expect(await ui.find({ key: 'done-0' })).toBeUndefined()
    await ui.press({ key: 'done-toggle' })
    const newest = JSON.stringify(await ui.find({ key: 'done-0' }))
    expect(newest).toContain('API は $1 REST')
    expect(JSON.stringify(await ui.find({ key: 'done-1' }))).toContain('2026-10-01 09:00')
  })
}

test('decisions.md が無いときだけ、CLAUDE.md への追記を案内する', async ($, on) => {
  let exists = false
  on('fs.stat', () => (exists ? { value: { kind: 'file', size: 0, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }) as any)
  on('fs.read', () => ({ value: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('config.list', () => ({ value: [] }) as any)
  on('env.get', (_$, e: any) => ({ value: e.name === 'LANG' ? 'ja_JP.UTF-8' : undefined }) as any)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }) as any)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'decision-pane', surface: 'terminal', component: 'Pane', props: PROPS, requestId: 'decision-pane' })
  expect(JSON.stringify(await ui.drawn())).toContain('CLAUDE.md への追記')

  exists = true
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true }) // reloads decisions.md
  expect(JSON.stringify(await ui.drawn())).not.toContain('CLAUDE.md への追記')
})

test('言語: /config の language が無く LANG も日本語でなければ英語で出す。ファイルの印は日本語のまま', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 12, 3, 30) })
  let file = '- [ ] Use SQLite\n'
  on('fs.stat', () => ({ value: { kind: 'file', size: file.length, mtimeMs: file.length, isLink: false } }) as any)
  on('fs.read', () => ({ value: file }))
  on('fs.write', (_$, e) => { file = e.text; return { value: undefined } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('config.list', () => ({ value: [] }) as any)
  on('env.get', (_$, e: any) => ({ value: e.name === 'LANG' ? 'en_US.UTF-8' : undefined }) as any)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'decision-pane', surface: 'terminal', component: 'Pane', props: PROPS, requestId: 'decision-pane' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Waiting on you')
  expect(drawn).not.toContain('判断待ち')
  await ui.press({ key: 'ok-0' })
  expect(file).toMatch(new RegExp(`^- \\[x\\] Use SQLite \\(承認 ${STAMP}\\)$`, 'm'))
})

test('言語: /config の language が日本語なら、LANG が英語でも日本語で出す', async ($, on) => {
  on('fs.stat', () => ({ value: { kind: 'file', size: 9, mtimeMs: 9, isLink: false } }) as any)
  on('fs.read', () => ({ value: '- [ ] x\n' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('config.list', () => ({ value: [{ key: 'language', value: 'japanese' }] }) as any)
  on('env.get', (_$, e: any) => ({ value: e.name === 'LANG' ? 'en_US.UTF-8' : undefined }) as any)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }) as any)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'decision-pane', surface: 'terminal', component: 'Pane', props: PROPS, requestId: 'decision-pane' })
  expect(JSON.stringify(await ui.drawn())).toContain('あなたの判断待ち')
})
