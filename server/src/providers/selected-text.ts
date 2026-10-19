import { execFile as nodeExecFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'

const execFile = promisify(nodeExecFile)
const SWIFT = '/usr/bin/swift'
const HELPER = fileURLToPath(new URL('./selected-text-native.swift', import.meta.url))
const TIMEOUT_MS = 5000
const NativeResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string() }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['permission-required', 'secure-field', 'no-selection', 'unavailable']) }).strict(),
])

export type SelectedTextResult = z.infer<typeof NativeResult>
export type SelectedTextRunner = (file: string, args: string[]) => Promise<string>

const runProgram: SelectedTextRunner = async (file, args) => {
  const { stdout } = await execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024, shell: false })
  return stdout
}

/** Reads the current focused selection through Accessibility without activating an app or touching the pasteboard. */
export function createSelectedTextReader(run: SelectedTextRunner = runProgram): () => Promise<SelectedTextResult> {
  return async () => {
    try {
      const response = NativeResult.safeParse(JSON.parse(await run(SWIFT, [HELPER, 'read'])))
      return response.success ? response.data : { ok: false, error: 'unavailable' }
    } catch {
      return { ok: false, error: 'unavailable' }
    }
  }
}

export const readSelectedText = createSelectedTextReader()
