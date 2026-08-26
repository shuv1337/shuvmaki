import { expect, test } from 'vitest'
import { PlannotatorStartGate } from './plannotator-start-gate.js'

test('serializes callers that acquire on the same settled tail', async () => {
  const gate = new PlannotatorStartGate()
  const order: string[] = []

  const first = gate.acquire().then((release) => {
    order.push('first')
    return release
  })
  const second = gate.acquire().then((release) => {
    order.push('second')
    return release
  })

  const releaseFirst = await first
  await Promise.resolve()
  expect(order).toEqual(['first'])
  releaseFirst()
  const releaseSecond = await second
  expect(order).toEqual(['first', 'second'])
  releaseSecond()
})
