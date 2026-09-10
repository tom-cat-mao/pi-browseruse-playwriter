import * as fs from 'node:fs'
import * as path from 'node:path'

const worktreeTmpDir = path.resolve(process.cwd(), 'tmp')

/** Temp dirs for tests always live inside the worktree ./tmp directory. */
export function makeTestTmpDir(prefix: string): string {
  fs.mkdirSync(worktreeTmpDir, { recursive: true })
  return fs.mkdtempSync(path.join(worktreeTmpDir, `${prefix}-`))
}

export function removeTestTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}
