import { goke } from 'goke'
import { createLogger, LogPrefix } from '../logger.js'
import { closeDb } from '../db.js'
import { runPlannotatorTunnel } from '../plannotator-tunnel.js'

const cli = goke('plannotator')
const logger = createLogger(LogPrefix.CLI)

cli
  .command('plannotator-tunnel', 'Internal bridge for remote Plannotator reviews')
  .action(async () => {
    const separatorIndex = process.argv.indexOf('--')
    const args = separatorIndex === -1 ? [] : process.argv.slice(separatorIndex + 1)
    const result = await runPlannotatorTunnel({ args })
    await closeDb()
    if (result instanceof Error) {
      logger.error(result.message)
      process.exit(1)
    }
    process.exit(result)
  })

export default cli
