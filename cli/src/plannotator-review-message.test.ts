import { expect, test } from 'vitest'
import { formatPlannotatorReviewMessage } from './ipc-polling.js'

test('describes the capability link and its lifetime', () => {
  expect(
    formatPlannotatorReviewMessage({
      url: 'https://0123456789abcdef0123456789abcdef-tunnel.shuv.bot',
      password: 'abcdef0123456789abcdef0123456789',
    }),
  ).toMatchInlineSnapshot(`
    "Plan review ready. Anyone with this unique link and password can approve or request changes. The tunnel closes when the review ends or after 60 minutes.
    <https://0123456789abcdef0123456789abcdef-tunnel.shuv.bot>
    Password: ||\`abcdef0123456789abcdef0123456789\`||"
  `)
})
