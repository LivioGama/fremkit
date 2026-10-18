import { execFile } from 'node:child_process'
import { assertSecretKey, type SecretStore } from './types.js'
import { tr } from '../i18n.js'

/** Keychain service under which every Fremkit secret is filed. */
export const KEYCHAIN_SERVICE = 'fremkit'

export type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>

const TIMEOUT_MS = 5000

export const execFileAsync: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve({ stdout })
    })
  })

/** `security`, by absolute path: never whatever a `PATH` lookup would find first. */
export const SECURITY_TOOL = '/usr/bin/security'

/**
 * Runs `security` with `args`, and with `input` on its standard input when given. What comes back
 * on stderr matters: `find-generic-password -g` prints the password there.
 */
export type SecurityRun = (args: string[], input?: string) => Promise<{ stdout: string; stderr: string }>

export const runSecurity: SecurityRun = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(SECURITY_TOOL, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve({ stdout, stderr })
    })
    // A broken pipe (security exited first) surfaces as the exit status above.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })

/**
 * The longest command line `security -i` reads whole; past it the line is cut and the command
 * fails. A bit under the 4096 bytes it actually takes, to leave room for the keychain argument.
 */
const MAX_INTERACTIVE_LINE = 3900

/**
 * The password argument of an `add-generic-password` line for `security -i`.
 *
 * Printable ASCII goes as a double-quoted `-w`, with `\` and `"` escaped (the interactive
 * parser's rules); anything else — a newline, a non-ASCII character — as `-X` and hex, which has
 * nothing to quote. The value only ever travels on stdin, never on a command line.
 */
export function passwordArgument(value: string): string {
  if (/^[\x20-\x7e]+$/.test(value)) return `-w "${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`
  if (value === '') return '-w ""'
  return `-X ${Buffer.from(value, 'utf8').toString('hex')}`
}

/**
 * The password out of `find-generic-password -g`'s stderr: `password: "text"` when every byte is
 * printable, `password: 0xHEX  "…"` otherwise, `password: ` when empty. `-w` is not used to read:
 * it prints the value as is *or* as bare hex, and a token that happens to be made of hex digits
 * cannot be told from the hex dump of something else.
 */
export function parsePassword(stderr: string): string | null {
  const line = stderr.split('\n').find((l) => l.startsWith('password: ') || l === 'password:')
  if (line === undefined) return null
  const rest = line.slice('password:'.length).replace(/^ /, '')
  if (rest.trim() === '') return ''
  const hex = /^0x([0-9A-Fa-f]*)/.exec(rest)
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8')
  const quoted = /^"(.*)"\s*$/.exec(rest)
  return quoted ? quoted[1] : null
}

/** Exit status `security` uses for "the item is not in the keychain". */
const ERR_ITEM_NOT_FOUND = 44

function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: unknown }
  if (e?.code === ERR_ITEM_NOT_FOUND) return true
  // Fallback only: `security`'s stderr text is locale-dependent (a non-English system locale
  // phrases it differently), so the exit code above is the reliable check and this is best-effort.
  return typeof e?.stderr === 'string' && /could not be found/i.test(e.stderr)
}

/**
 * Describes a failed `security` call **without its message**.
 *
 * Nothing secret is on the command line any more, but stderr can carry a password (`-g`) and
 * the message of a failed call is not something to forward anyway: only the exit status ever
 * leaves this module.
 */
function describe(err: unknown): string {
  const e = err as { code?: unknown; signal?: unknown }
  if (typeof e?.code === 'number') return `code ${e.code}`
  if (typeof e?.code === 'string') return e.code
  if (typeof e?.signal === 'string') return `signal ${e.signal}`
  return 'erreur inconnue'
}

/**
 * Secrets in the macOS keychain, via the `security` command line tool.
 *
 * No secret is ever on a command line: any account on the Mac can read every process's arguments
 * with `ps`. Writing feeds `add-generic-password` to `security -i` on stdin (see
 * `passwordArgument`); reading uses `-g`, which prints the password on stderr. A value too long
 * for one interactive line (about 1,900 bytes when it is not plain ASCII, 3,800 when it is) is
 * refused rather than truncated.
 *
 * `keychain` names a keychain file instead of the default search list; the tests use a throwaway
 * one. It goes on the interactive line, so it may not contain spaces or quotes.
 */
export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly run: SecurityRun = runSecurity,
    private readonly service: string = KEYCHAIN_SERVICE,
    private readonly keychain?: string,
  ) {
    if (keychain !== undefined && !/^[^\s"'\\]+$/.test(keychain)) throw new Error('keychain path must not contain spaces or quotes')
  }

  private get keychainArgs(): string[] {
    return this.keychain === undefined ? [] : [this.keychain]
  }

  async get(key: string): Promise<string | null> {
    assertSecretKey(key)
    let stderr: string
    try {
      ;({ stderr } = await this.run(['find-generic-password', '-s', this.service, '-a', key, '-g', ...this.keychainArgs]))
    } catch (err) {
      if (isNotFound(err)) return null
      throw new Error(`${tr(undefined, 'secrets.readFailed')} (${describe(err)})`)
    }
    const value = parsePassword(stderr)
    if (value === null) throw new Error(`${tr(undefined, 'secrets.readFailed')} (format)`)
    return value
  }

  async set(key: string, value: string): Promise<void> {
    assertSecretKey(key)
    const line = ['add-generic-password', '-U', '-s', this.service, '-a', key, passwordArgument(value), ...this.keychainArgs].join(' ')
    if (line.length > MAX_INTERACTIVE_LINE) throw new Error(`${tr(undefined, 'secrets.writeFailed')} (too long)`)
    try {
      await this.run(['-i'], `${line}\n`)
    } catch (err) {
      throw new Error(`${tr(undefined, 'secrets.writeFailed')} (${describe(err)})`)
    }
  }

  async delete(key: string): Promise<void> {
    assertSecretKey(key)
    try {
      await this.run(['delete-generic-password', '-s', this.service, '-a', key, ...this.keychainArgs])
    } catch (err) {
      if (isNotFound(err)) return
      throw new Error(`${tr(undefined, 'secrets.deleteFailed')} (${describe(err)})`)
    }
  }
}
