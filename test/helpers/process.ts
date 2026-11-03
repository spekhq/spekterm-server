/** Runs the real server and admin command line as child processes. */
import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

export const SERVER_ENTRY = fileURLToPath(new URL('../../src/server.ts', import.meta.url))
export const ADMIN_ENTRY = fileURLToPath(new URL('../../src/admin.ts', import.meta.url))

export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

export interface ServerProcess {
  child: ChildProcess
  port: number
  output: () => string
  exited: Promise<number | null>
}

/** Starts `src/server.ts` and waits until it logs that it is listening. */
export async function spawnServer(env: Record<string, string>, nodeArgs: string[] = []): Promise<ServerProcess> {
  const port = await freePort()
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...nodeArgs, SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.on('data', (d) => (output += String(d)))
  child.stderr!.on('data', (d) => (output += String(d)))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (output.includes('listening on port')) resolve()
    }
    child.stdout!.on('data', check)
    exited.then((code) => reject(new Error(`server exited with ${code}:\n${output}`)))
  })
  return { child, port, output: () => output, exited }
}

export interface AdminResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Runs `src/admin.ts` with arguments and returns its exit status and output. */
export function runAdmin(args: string[], env: Record<string, string>): Promise<AdminResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ADMIN_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += String(d)))
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('exit', (status) => resolve({ status, stdout, stderr }))
  })
}
