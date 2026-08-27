// Separate-process helper for shuvcode-server-auth.test.ts.
// Discovers the bot's serve port via localhost /kimaki/opencode-port and
// the password from the 0600 data-dir file, then checks /api/health.
// Env must not already contain OPENCODE_PASSWORD.

import { getDataDir, getLockPort, setDataDir } from './config.js'
import {
  applyShuvcodeServerAuth,
  buildShuvcodeBasicAuthHeader,
  resolveShuvcodeServerHandoff,
} from './shuvcode-server-auth.js'

const dataDir = process.env.KIMAKI_TEST_DATA_DIR
if (dataDir) {
  setDataDir(dataDir)
}

if (process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD) {
  process.stderr.write('child env already has a serve password\n')
  process.exit(2)
}

const handoff = await resolveShuvcodeServerHandoff({
  lockPort: getLockPort(),
  dataDir: getDataDir(),
})
if (handoff instanceof Error) {
  process.stderr.write(`${handoff.message}\n`)
  process.exit(1)
}

applyShuvcodeServerAuth({ auth: handoff.auth })

const health = await fetch(`http://127.0.0.1:${handoff.port}/api/health`, {
  headers: {
    Authorization: buildShuvcodeBasicAuthHeader(handoff.auth),
  },
}).catch((cause) => {
  process.stderr.write(`health fetch failed: ${cause}\n`)
  process.exit(1)
})

process.stdout.write(
  JSON.stringify({
    port: handoff.port,
    status: health.status,
  }),
)
process.exit(health.status === 200 ? 0 : 1)
