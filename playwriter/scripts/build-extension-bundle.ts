import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const playwriterDir = path.join(__dirname, '..')
const repoRoot = path.join(playwriterDir, '..')
const extensionDir = path.join(repoRoot, 'extension')
const bundleTargets = [
  { script: 'build', output: 'dist-packaged', bundle: 'extension' },
  { script: 'build:firefox', output: 'dist-firefox', bundle: 'extension-firefox' },
]

function runCommand({
  command,
  args,
  cwd,
  env,
}: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`))
    })
  })
}

async function main(): Promise<void> {
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

  for (const target of bundleTargets) {
    if (process.argv.includes('--firefox') && target.bundle !== 'extension-firefox') {
      continue
    }
    await runCommand({
      command: pnpmCommand,
      args: [target.script],
      cwd: extensionDir,
      env: {
        ...process.env,
        PLAYWRITER_EXTENSION_DIST: target.output,
        PI_BROWSER_FIREFOX_DIST: target.output,
        PLAYWRITER_OPEN_WELCOME_PAGE: '0',
      },
    })

    const bundledExtensionDir = path.join(playwriterDir, 'dist', target.bundle)
    fs.rmSync(bundledExtensionDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(bundledExtensionDir), { recursive: true })
    fs.cpSync(path.join(extensionDir, target.output), bundledExtensionDir, { recursive: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
