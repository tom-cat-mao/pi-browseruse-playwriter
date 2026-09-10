import fs from 'node:fs'
import path from 'node:path'
import type { BrowserResponse } from './browser-protocol.js'
import {
  encodeManagedWorkerMessage,
  parseManagedWorkerCommand,
  splitManagedWorkerLines,
  type ManagedExecutorWorkerCommand,
  type ManagedExecutorWorkerWireMessage,
} from './managed-executor-protocol.js'

function writeMessage(message: ManagedExecutorWorkerWireMessage): void {
  process.stdout.write(encodeManagedWorkerMessage(message))
}

function commandPath({ cwd, name }: { cwd: string | undefined; name: string }): string {
  return path.join(cwd ?? process.cwd(), name)
}

async function handleCommand(command: ManagedExecutorWorkerCommand): Promise<void> {
  if (command.type === 'dispose') {
    writeMessage({ type: 'disposed', id: command.id })
    process.stdout.end(() => {
      process.exit(0)
    })
    return
  }

  const request = command.execution.request
  if (request.operation.kind !== 'page.execute') {
    writeMessage({
      type: 'response',
      id: command.id,
      response: failureResponse({ requestId: request.requestId, message: 'fixture only handles page.execute' }),
    })
    return
  }

  if (request.operation.code === 'silent-startup') {
    fs.writeFileSync(commandPath({ cwd: request.cwd, name: 'silent-started.txt' }), String(process.pid))
    setTimeout(() => {
      fs.writeFileSync(commandPath({ cwd: request.cwd, name: 'silent-late.txt' }), String(process.pid))
    }, 120)
    return
  }

  if (request.operation.code === 'delayed-80') {
    fs.writeFileSync(commandPath({ cwd: request.cwd, name: 'dispatched.txt' }), String(process.pid))
    setTimeout(() => {
      fs.writeFileSync(commandPath({ cwd: request.cwd, name: 'late.txt' }), String(process.pid))
      writeMessage({
        type: 'response',
        id: command.id,
        response: successResponse({ requestId: request.requestId, pid: process.pid }),
      })
    }, 80)
    return
  }

  writeMessage({
    type: 'response',
    id: command.id,
    response: successResponse({ requestId: request.requestId, pid: process.pid }),
  })
}

function successResponse({ requestId, pid }: { requestId: string; pid: number }): BrowserResponse {
  return {
    requestId,
    ok: true,
    data: { value: { pid } },
  }
}

function failureResponse({ requestId, message }: { requestId: string; message: string }): BrowserResponse {
  return {
    requestId,
    ok: false,
    error: { code: 'execution-failed', message, outcome: 'not-started' },
  }
}

async function main(): Promise<void> {
  writeMessage({ type: 'ready', protocolVersion: 1 })
  let buffer = ''
  let queue: Promise<void> = Promise.resolve()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    const split = splitManagedWorkerLines({ buffer, chunk })
    buffer = split.remainder
    split.lines.forEach((line) => {
      const command = parseManagedWorkerCommand(line)
      if (!command) {
        return
      }
      queue = queue.then(async () => {
        await handleCommand(command)
      })
    })
  })
}

void main()
