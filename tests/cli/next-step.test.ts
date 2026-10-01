import { afterEach, describe, expect, test, vi } from 'vitest'
import { PRODUCT_VERSION } from '../../src/brand.js'
import { noAdminsYetNotice } from '../../src/cli/admin-token.js'
import {
  anchorHeadHint,
  cliCommand,
  exportReportHint,
  heldCallNotice,
  keygenHint,
  listApprovalsHint,
  noJournalMessage,
  noPendingApprovalsHint,
  recordFirstSessionHint,
  resolveApprovalHint,
  shellArg,
  showSessionHint,
  spawnFailureHint,
  unknownSessionMessage,
  verifyReportHint,
} from '../../src/cli/next-step.js'

/**
 * Every hint ends in a command the operator can paste as is. The Quick start
 * runs mcpcut through `npx`, where a bare `mcpcut …` is "command not found",
 * so the hint names the command the way this process was started.
 */

const NPX = `npx -y mcpcut@${PRODUCT_VERSION}`

afterEach(() => {
  vi.unstubAllEnvs()
})

function asNpx(): void {
  vi.stubEnv('npm_command', 'exec')
}

function asInstalled(): void {
  vi.stubEnv('npm_command', '')
}

describe('cliCommand', () => {
  test('is the pinned npx form when npm exec (npx) started this process', () => {
    expect(cliCommand({ npm_command: 'exec' })).toBe(NPX)
  })

  test('is the bare binary for a global install or any other launcher', () => {
    expect(cliCommand({})).toBe('mcpcut')
    expect(cliCommand({ npm_command: 'run-script' })).toBe('mcpcut')
  })

  test('reads the live environment by default', () => {
    asNpx()
    expect(cliCommand()).toBe(NPX)
    asInstalled()
    expect(cliCommand()).toBe('mcpcut')
  })
})

describe('shellArg', () => {
  test('leaves a plain path or id alone', () => {
    expect(shellArg('/tmp/report-1')).toBe('/tmp/report-1')
    expect(shellArg('01M3P0EZZ56F7K5EWPXH7Z4YYS')).toBe('01M3P0EZZ56F7K5EWPXH7Z4YYS')
  })

  test('single-quotes anything a shell would split or expand', () => {
    expect(shellArg('/tmp/my report')).toBe("'/tmp/my report'")
    expect(shellArg('$HOME/x')).toBe("'$HOME/x'")
  })

  test("escapes an embedded single quote so the paste stays one argument", () => {
    expect(shellArg("it's")).toBe(`'it'\\''s'`)
  })

  test('keeps a long path whole: a cut path would paste as a different one', () => {
    const long = `/tmp/${'a'.repeat(300)}`
    expect(shellArg(long)).toBe(long)
  })

  test('replaces control characters so a hint cannot drive the terminal', () => {
    expect(shellArg('a\u001b[2Jb')).not.toContain('\u001b')
  })
})

describe('hints name the next command with real values', () => {
  test('an empty journal says how to record the first session', () => {
    asNpx()
    const hint = recordFirstSessionHint()
    expect(hint).toContain(`${NPX} wrap -- `)
    expect(hint.endsWith('\n')).toBe(true)
  })

  test('a session list offers the latest session by id', () => {
    asInstalled()
    expect(showSessionHint('01ABC')).toContain('mcpcut show 01ABC')
  })

  test('an unknown session names it and points back at the list', () => {
    asNpx()
    const message = unknownSessionMessage('nope')
    expect(message).toContain('"nope"')
    expect(message).toContain(`${NPX} sessions`)
  })

  test('an empty approvals queue says what puts a call there', () => {
    asInstalled()
    const hint = noPendingApprovalsHint()
    expect(hint).toContain('require-approval')
    expect(hint).toContain('--policy')
  })

  test('with no policy in the default places it does not claim there is none: wrap may run with --policy elsewhere', () => {
    asInstalled()
    const hint = noPendingApprovalsHint()
    expect(hint).not.toContain('No policy file yet')
    expect(hint).toContain('If you have no policy yet')
  })

  test('an empty approvals queue with a known policy names that file, with no placeholder', () => {
    asInstalled()
    const hint = noPendingApprovalsHint('/work/proj/.mcpcut-project/policy.json')
    expect(hint).toContain('wrap --policy /work/proj/.mcpcut-project/policy.json --')
    expect(hint).not.toContain('<')
  })

  test('a pending approval gets ready approve and deny commands', () => {
    asNpx()
    const hint = resolveApprovalHint('01XYZ')
    expect(hint).toContain(`${NPX} approvals approve 01XYZ`)
    expect(hint).toContain(`${NPX} approvals deny 01XYZ`)
  })

  test('an unknown approval id points at the pending list', () => {
    asInstalled()
    expect(listApprovalsHint()).toContain('mcpcut approvals list')
  })

  test('a fresh key leads to a signed report, and a report to its check', () => {
    asInstalled()
    expect(exportReportHint()).toContain('mcpcut export --report --out ./report')
    expect(verifyReportHint('/tmp/my report')).toContain("mcpcut verify --report '/tmp/my report'")
  })

  test('a report directory named like an option is pasted as a path', () => {
    asInstalled()
    expect(verifyReportHint('-r')).toContain('verify --report ./-r')
  })

  test('a missing key names the keygen command', () => {
    asNpx()
    expect(keygenHint()).toContain(`${NPX} keygen`)
  })

  test('a missing journal names the directory and the way to fill it', () => {
    asInstalled()
    const message = noJournalMessage('/data/j')
    expect(message).toContain('"/data/j"')
    expect(message).toContain('nothing has been journaled there yet')
    expect(message).toContain('mcpcut wrap -- ')
  })

  test('a journal path with control characters cannot drive the terminal', () => {
    expect(noJournalMessage('/d\u001b[2J')).not.toContain('\u001b')
  })
})

describe('the Prove and Stop steps name what comes next (0.2.3)', () => {
  test('a signed report leads to anchoring its head outside the host', () => {
    asNpx()
    const hint = anchorHeadHint()
    expect(hint).toContain(`${NPX} verify --sign`)
    expect(hint).toContain('cannot rewrite')
  })

  test('a held call names the tool, the server, the wait and ready commands', () => {
    asNpx()
    const notice = heldCallNotice({ approvalId: '01HELD', toolName: 'write_file', serverName: 'fs', waitMs: 60_000 })
    expect(notice).toContain('write_file')
    expect(notice).toContain('fs')
    expect(notice).toContain('60 s')
    expect(notice).toContain(`${NPX} approvals approve 01HELD`)
    expect(notice).toContain(`${NPX} approvals deny 01HELD`)
    expect(notice.endsWith('\n')).toBe(true)
  })

  test('a tool name the agent chose cannot drive the terminal', () => {
    const notice = heldCallNotice({ approvalId: '01HELD', toolName: 'evil\u001b[2J', serverName: 'fs', waitMs: 1_000 })
    expect(notice).not.toContain('\u001b')
  })

  test('the no-admins note names the admin command the way mcpcut was started', () => {
    asNpx()
    expect(noAdminsYetNotice()).toContain(`${NPX} admin add`)
    asInstalled()
    expect(noAdminsYetNotice()).toContain('"mcpcut admin add"')
  })
})

describe('spawnFailureHint: the wrapped server could not be started', () => {
  const SERVER = ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\project']

  test('on Windows, an npm command (npx) gets the cmd /c form with its own arguments', () => {
    const hint = spawnFailureHint({ command: 'npx', args: SERVER, code: 'ENOENT' }, 'win32')

    expect(hint).toContain('-- cmd /c npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me\\project')
    expect(hint.endsWith('\n')).toBe(true)
  })

  test('on Windows, a .cmd refused without a shell (EINVAL) gets the same form', () => {
    expect(spawnFailureHint({ command: 'npx.cmd', args: [], code: 'EINVAL' }, 'win32')).toContain('-- cmd /c npx.cmd')
  })

  test('on Windows, an argument with a space is double-quoted, the way cmd and PowerShell read it', () => {
    const hint = spawnFailureHint({ command: 'npx', args: ['-y', 'pkg', 'C:\\My Project'], code: 'ENOENT' }, 'win32')

    expect(hint).toContain('-- cmd /c npx -y pkg "C:\\My Project"')
  })

  test('on Windows, an argument with a shell metacharacter is quoted, so the paste runs the same server', () => {
    const hint = spawnFailureHint({ command: 'npx', args: ['-y', 'pkg', 'a&b', 'x|y', '(z)'], code: 'ENOENT' }, 'win32')

    expect(hint).toContain('-- cmd /c npx -y pkg "a&b" "x|y" "(z)"')
  })

  test('on Windows, a quoted argument ending in a backslash keeps its closing quote', () => {
    const hint = spawnFailureHint({ command: 'npx', args: ['C:\\a b\\'], code: 'ENOENT' }, 'win32')

    expect(hint).toContain('-- cmd /c npx "C:\\a b\\\\"')
  })

  test('on Windows, an argument cmd would expand or unquote gets the rule without a line to paste', () => {
    for (const awkward of ['%PATH%', 'say "hi"']) {
      const hint = spawnFailureHint({ command: 'npx', args: ['-y', 'pkg', awkward], code: 'ENOENT' }, 'win32')

      expect(hint).toContain('put "cmd /c" right after "--"')
      expect(hint).not.toContain(awkward)
    }
  })

  test('elsewhere, a missing command says to install it or give its full path', () => {
    const hint = spawnFailureHint({ command: 'uvx', args: ['some-server'], code: 'ENOENT' }, 'linux')

    expect(hint).toContain('uvx')
    expect(hint).toMatch(/not found/)
    expect(hint).toMatch(/full path/)
    expect(hint).not.toContain('cmd /c')
  })

  test('a Windows .exe that is missing is not sent to cmd', () => {
    expect(spawnFailureHint({ command: 'python.exe', args: [], code: 'ENOENT' }, 'win32')).not.toContain('cmd /c')
  })

  test('a failure that is not about finding the command adds nothing', () => {
    expect(spawnFailureHint({ command: 'npx', args: [], code: 'EACCES' }, 'linux')).toBe('')
  })
})
