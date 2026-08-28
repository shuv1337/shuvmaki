// E2e test for shuvcode plugin loading.
// Spawns `shuvcode serve` directly with our plugin in OPENCODE_CONFIG_CONTENT,
// waits for the health endpoint, then checks stderr for plugin errors.
// No Discord infrastructure needed — just the shuvcode server process.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'
import { buildShuvcodeServeArgs, resolveOpencodeCommand } from './opencode.js'
import { getSpawnCommandAndArgs } from './opencode-command.js'
import { buildShuvcodeBasicAuthHeader } from './shuvcode-server-auth.js'
import { chooseLockPort } from './test-utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function waitForHealth({
  port,
  authorization,
  maxAttempts = 30,
}: {
  port: number
  authorization: string
  maxAttempts?: number
}): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Authorization: authorization },
      })
      if (response.status >= 200 && response.status < 300) {
        return true
      }
    } catch {
      // connection refused, retry
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1000)
    })
  }
  return false
}

test(
  'opencode server loads plugin without errors',
  async () => {
    const projectDir = path.resolve(process.cwd(), 'tmp', 'plugin-loading-e2e')
    fs.mkdirSync(projectDir, { recursive: true })

    const port = chooseLockPort({ key: 'opencode-plugin-loading-e2e' })
    const pluginPath = new URL('../src/kimaki-opencode-plugin.ts', import.meta.url).href
    const stderrLines: string[] = []
    const isolatedOpencodeRoot = path.join(projectDir, 'opencode-test-home')
    const xdgDirectories = {
      OPENCODE_CONFIG_DIR: path.join(isolatedOpencodeRoot, '.opencode-kimaki'),
      XDG_CONFIG_HOME: path.join(isolatedOpencodeRoot, '.config'),
      XDG_DATA_HOME: path.join(isolatedOpencodeRoot, '.local', 'share'),
      XDG_CACHE_HOME: path.join(isolatedOpencodeRoot, '.cache'),
      XDG_STATE_HOME: path.join(isolatedOpencodeRoot, '.local', 'state'),
    }

    fs.mkdirSync(isolatedOpencodeRoot, { recursive: true })
    Object.values(xdgDirectories).forEach((directory) => {
      fs.mkdirSync(directory, { recursive: true })
    })

    const {
      command,
      args,
      windowsVerbatimArguments,
    } = getSpawnCommandAndArgs({
      resolvedCommand: resolveOpencodeCommand(),
      baseArgs: buildShuvcodeServeArgs({ port }),
    })

    const serveAuth = {
      username: 'opencode',
      password: 'plugin-loading-e2e-secret',
    }

    const serverProcess: ChildProcess = spawn(command, args, {
      stdio: 'pipe',
      cwd: projectDir,
      windowsVerbatimArguments,
      env: {
        ...process.env,
        OPENCODE_PASSWORD: serveAuth.password,
        OPENCODE_SERVER_PASSWORD: serveAuth.password,
        OPENCODE_SERVER_USERNAME: serveAuth.username,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          lsp: false,
          formatter: false,
          plugin: [pluginPath],
        }),
        OPENCODE_TEST_HOME: isolatedOpencodeRoot,
        ...xdgDirectories,
      },
    })

    serverProcess.stderr?.on('data', (data) => {
      stderrLines.push(...data.toString().split('\n').filter(Boolean))
    })

    try {
      const healthy = await waitForHealth({
        port,
        authorization: buildShuvcodeBasicAuthHeader(serveAuth),
      })
      expect(healthy).toBe(true)

      // Check no plugin-related errors in stderr
      const pluginErrorPatterns = [
        /plugin.*error/i,
        /failed to load plugin/i,
        /cannot find module/i,
        /ERR_MODULE_NOT_FOUND/i,
        /plugin.*failed/i,
        /plugin.*crash/i,
      ]
      const errorLines = stderrLines.filter((line) => {
        return pluginErrorPatterns.some((pattern) => {
          return pattern.test(line)
        })
      })
      expect(errorLines).toEqual([])
    } finally {
      serverProcess.kill('SIGTERM')
    }
  },
  60_000,
)
