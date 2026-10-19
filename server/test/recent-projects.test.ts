import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecentProjectsProvider, type RecentProject } from '../src/providers/recent-projects.js'

const LOCAL = { loopback: true, paired: false }
const resolveTrustedExecutable = vi.fn(async (name: string) => `/trusted/bin/${name}`)
let dir = ''

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

describe('recent projects', () => {
  it('records only foreground Herdr working directories and persists bounded de-duplicated history', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const first = join(dir, 'first')
    const second = join(dir, 'second')
    const { mkdir, realpath, stat } = await import('node:fs/promises')
    await mkdir(first)
    await mkdir(second)
    const listPanes = vi.fn(async () => ({ panes: [
      { id: 'p1', cwd: first, foreground_cwd: first },
      { id: 'p2', cwd: second, foreground_cwd: second },
      { id: 'p3', cwd: '/not/observed', foreground_cwd: '' },
    ] }))
    const provider = createRecentProjectsProvider({ filePath: join(dir, 'history.json'), listPanes, now: () => 100 })

    const snapshot = await provider.poll!() as { projects: { path: string; lastSeen: number }[]; historyStartsAt: number }

    expect(new Set(snapshot.projects.map((project) => project.path))).toEqual(new Set(await Promise.all([first, second].map((path) => realpath(path)))))
    expect(snapshot.projects.every((project) => project.lastSeen === 100)).toBe(true)
    expect(snapshot.historyStartsAt).toBe(100)
    expect(JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'))).toMatchObject({ projects: snapshot.projects })
    expect((await stat(join(dir, 'history.json'))).mode & 0o777).toBe(0o600)
  })

  it('falls back to the pane cwd when foreground cwd is empty', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const project = join(dir, 'project')
    const { mkdir, realpath } = await import('node:fs/promises')
    await mkdir(project)
    const canonicalProject = await realpath(project)
    const provider = createRecentProjectsProvider({
      filePath: join(dir, 'history.json'),
      listPanes: vi.fn(async () => ({ panes: [{ cwd: project, foreground_cwd: '' }] })),
      now: () => 101,
    })

    const snapshot = await provider.poll!() as { projects: RecentProject[] }

    expect(snapshot.projects.map(({ path }) => path)).toEqual([canonicalProject])
  })

  it('opens only a recorded directory in a newly created pane and targets its new pane', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const project = join(dir, 'project')
    const { mkdir, writeFile, realpath } = await import('node:fs/promises')
    await mkdir(project)
    const canonicalProject = await realpath(project)
    await writeFile(join(dir, 'history.json'), JSON.stringify({ historyStartsAt: 1, projects: [{ path: canonicalProject, name: 'project', lastSeen: 2 }] }))
    const run = vi.fn(async (_file: string, args: string[]) => ({ stdout: args[1] === 'split' ? JSON.stringify({ result: { pane: { pane_id: 'new' } } }) : '' }))
    const listPanes = vi.fn().mockResolvedValueOnce({ panes: [{ pane_id: 'existing', cwd: canonicalProject, foreground_cwd: canonicalProject }] })
      .mockResolvedValueOnce({ panes: [{ pane_id: 'existing', cwd: canonicalProject, foreground_cwd: canonicalProject }, { pane_id: 'new', cwd: canonicalProject, foreground_cwd: canonicalProject }] })
    const provider = createRecentProjectsProvider({
      filePath: join(dir, 'history.json'),
      listPanes,
      run,
      resolveExecutable: resolveTrustedExecutable,
    })

    const result = await provider.commands!.open({ path: canonicalProject, target: 'codex' }, LOCAL)

    expect(result).toMatchObject({ ok: true })
    expect(listPanes).not.toHaveBeenCalled()
    expect(run.mock.calls).toEqual([
      ['/trusted/bin/herdr', ['pane', 'split', '--cwd', canonicalProject, '--direction', 'right', '--no-focus', '--env', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin:/trusted/bin']],
      ['/trusted/bin/herdr', ['pane', 'run', 'new', 'codex']],
    ])
  })

  it('fails closed when no trusted Herdr executable can be resolved', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const project = join(dir, 'project')
    const { mkdir, realpath, writeFile } = await import('node:fs/promises')
    await mkdir(project)
    const canonicalProject = await realpath(project)
    await writeFile(join(dir, 'history.json'), JSON.stringify({ historyStartsAt: 1, projects: [{ path: canonicalProject, name: 'project', lastSeen: 2 }] }))
    const run = vi.fn()
    const provider = createRecentProjectsProvider({
      filePath: join(dir, 'history.json'),
      run,
      resolveExecutable: vi.fn(async () => undefined),
    })

    expect(await provider.commands!.open({ path: canonicalProject, target: 'codex' }, LOCAL)).toMatchObject({ ok: false, error: 'herdr-unconfigured' })
    expect(run).not.toHaveBeenCalled()
  })

  it('uses one trusted absolute resolver for Claude Code and Codex launch targets', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const project = join(dir, 'project')
    const { mkdir, realpath, writeFile } = await import('node:fs/promises')
    await mkdir(project)
    const canonicalProject = await realpath(project)
    await writeFile(join(dir, 'history.json'), JSON.stringify({ historyStartsAt: 1, projects: [{ path: canonicalProject, name: 'project', lastSeen: 2 }] }))
    const run = vi.fn(async (_file: string, args: string[]) => ({ stdout: args[1] === 'split' ? JSON.stringify({ result: { pane: { pane_id: 'new' } } }) : '' }))
    const resolver = vi.fn(async (name: string) => `/trusted/bin/${name}`)
    const provider = createRecentProjectsProvider({ filePath: join(dir, 'history.json'), run, resolveExecutable: resolver })

    await provider.commands!.open({ path: canonicalProject, target: 'claude' }, LOCAL)
    await provider.commands!.open({ path: canonicalProject, target: 'codex' }, LOCAL)

    expect(resolver.mock.calls).toEqual([['herdr'], ['claude'], ['herdr'], ['codex']])
    expect(run.mock.calls.filter(([, args]) => args[1] === 'run').map(([, args]) => args[3])).toEqual(['claude', 'codex'])
    expect(run.mock.calls.filter(([, args]) => args[1] === 'split').map(([, args]) => args.slice(-2))).toEqual([
      ['--env', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin:/trusted/bin'],
      ['--env', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin:/trusted/bin'],
    ])
  })

  it('targets the exact pane returned by each concurrent split for the same folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const project = join(dir, 'project')
    const { mkdir, realpath, writeFile } = await import('node:fs/promises')
    await mkdir(project)
    const canonicalProject = await realpath(project)
    await writeFile(join(dir, 'history.json'), JSON.stringify({ historyStartsAt: 1, projects: [{ path: canonicalProject, name: 'project', lastSeen: 2 }] }))

    let splitCount = 0
    let releaseSplits!: () => void
    const bothSplitsStarted = new Promise<void>((resolve) => { releaseSplits = resolve })
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[1] !== 'split') return { stdout: '' }
      const paneId = splitCount++ === 0 ? 'new-a' : 'new-b'
      if (splitCount === 2) releaseSplits()
      await bothSplitsStarted
      return { stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }) }
    })
    const listPanes = vi.fn(async () => ({ panes: [{ pane_id: 'existing', cwd: canonicalProject, foreground_cwd: canonicalProject }] }))
    const provider = createRecentProjectsProvider({ filePath: join(dir, 'history.json'), listPanes, run, resolveExecutable: resolveTrustedExecutable })

    const results = await Promise.all([
      provider.commands!.open({ path: canonicalProject, target: 'codex' }, LOCAL),
      provider.commands!.open({ path: canonicalProject, target: 'claude' }, LOCAL),
    ])

    expect(results).toMatchObject([{ ok: true }, { ok: true }])
    expect(run.mock.calls.filter(([, args]) => args[1] === 'run').map(([, args]) => args[2]).sort()).toEqual(['new-a', 'new-b'])
  })

  it('reads Herdr’s JSON CLI envelope without inspecting pane contents', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const project = join(dir, 'project')
    const { mkdir, realpath } = await import('node:fs/promises')
    await mkdir(project)
    const canonicalProject = await realpath(project)
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ id: 'read-only', result: { type: 'pane.list', panes: [{ pane_id: 'p', cwd: canonicalProject, foreground_cwd: canonicalProject, scroll: 'ignored' }] } }) }))
    const provider = createRecentProjectsProvider({ filePath: join(dir, 'history.json'), run, now: () => 9, resolveExecutable: resolveTrustedExecutable })

    const snapshot = await provider.poll!() as { projects: RecentProject[]; coverage: string }

    expect(run).toHaveBeenCalledWith('/trusted/bin/herdr', ['pane', 'list'])
    expect(snapshot.projects.map(({ path }) => path)).toEqual([canonicalProject])
    expect(snapshot.coverage).toBe('herdr-cwd-since-first-observation')
  })

  it('keeps the history bounded to the 50 most recently observed folders', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const { mkdir, realpath } = await import('node:fs/promises')
    const paths = Array.from({ length: 51 }, (_, index) => join(dir, `project-${index}`))
    await Promise.all(paths.map((path) => mkdir(path)))
    const canonicalPaths = await Promise.all(paths.map((path) => realpath(path)))
    const provider = createRecentProjectsProvider({
      filePath: join(dir, 'history.json'),
      listPanes: vi.fn(async () => ({ panes: canonicalPaths.map((foreground_cwd) => ({ foreground_cwd })) })),
      now: () => 5,
    })

    const snapshot = await provider.poll!() as { projects: RecentProject[] }

    expect(snapshot.projects).toHaveLength(50)
    expect(snapshot.projects.every((project) => canonicalPaths.includes(project.path))).toBe(true)
  })

  it('rejects custom executables before pane creation because Herdr pane run accepts only PATH command names', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const project = join(dir, 'project')
    const { mkdir, realpath, writeFile } = await import('node:fs/promises')
    await mkdir(project)
    const canonicalProject = await realpath(project)
    await writeFile(join(dir, 'history.json'), JSON.stringify({ historyStartsAt: 1, projects: [{ path: canonicalProject, name: 'project', lastSeen: 2 }] }))
    const run = vi.fn()
    const listPanes = vi.fn().mockResolvedValueOnce({ panes: [{ pane_id: 'existing', cwd: canonicalProject }] })
      .mockResolvedValueOnce({ panes: [{ pane_id: 'existing', cwd: canonicalProject }, { pane_id: 'new', cwd: canonicalProject }] })
    const provider = createRecentProjectsProvider({ filePath: join(dir, 'history.json'), run, listPanes, resolveExecutable: resolveTrustedExecutable })

    expect(await provider.commands!.open({ path: canonicalProject, target: 'custom', customCommand: 'my-editor' }, LOCAL)).toMatchObject({ ok: false, error: 'custom-target-unsupported' })
    expect(await provider.commands!.open({
      path: canonicalProject,
      target: 'custom',
      customExecutable: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      customArgs: ['--reuse-window'],
    }, LOCAL)).toMatchObject({ ok: false, error: 'custom-target-unsupported' })
    expect(await provider.commands!.open({
      path: canonicalProject,
      target: 'custom',
      customExecutable: '/tmp/my-editor',
      customArgs: [';$(touch /tmp/pwned)'],
    }, LOCAL)).toMatchObject({ ok: false, error: 'custom-target-unsupported' })
    expect(run).not.toHaveBeenCalled()
    expect(listPanes).not.toHaveBeenCalled()
  })

  it('refuses arbitrary paths and non-loopback commands without launching anything', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const project = join(dir, 'project')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(project)
    await writeFile(join(dir, 'history.json'), JSON.stringify({ historyStartsAt: 1, projects: [{ path: project, name: 'project', lastSeen: 2 }] }))
    const run = vi.fn()
    const provider = createRecentProjectsProvider({ filePath: join(dir, 'history.json'), listPanes: vi.fn(), run })

    expect(await provider.commands!.open({ path: '/tmp/not-recorded', target: 'claude' }, LOCAL)).toMatchObject({ ok: false })
    expect(await provider.commands!.open({ path: project, target: 'claude' }, { loopback: false, paired: false })).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps the saved history visible when Herdr cannot be queried', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-recent-projects-'))
    const project = join(dir, 'project')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(project)
    const canonicalProject = await (await import('node:fs/promises')).realpath(project)
    const filePath = join(dir, 'history.json')
    const saved = { historyStartsAt: 1, projects: [{ path: canonicalProject, name: 'project', lastSeen: 2 }] }
    await writeFile(filePath, JSON.stringify(saved))
    const provider = createRecentProjectsProvider({ filePath, listPanes: vi.fn().mockRejectedValue(new Error('Herdr unavailable')) })

    const snapshot = await provider.poll!() as typeof saved & { error: string }

    expect(snapshot).toMatchObject({ ...saved, error: 'herdr-unavailable' })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(saved)
  })
})
