import { afterAll, expect, test } from 'vitest'
import { closeDb, getDb } from './db.js'
import { cancelPendingIpcRequest, claimPendingIpcRequests, createIpcRequest } from './database.js'
import * as schema from './schema.js'

afterAll(async () => {
  await closeDb()
})

test('cancels only review links the Discord poller has not claimed', async () => {
  const db = await getDb()
  const threadId = 'plannotator-ipc-thread'
  await db.insert(schema.thread_sessions).values({
    thread_id: threadId,
    session_id: 'ses_plannotatoripc',
  })

  const pending = await createIpcRequest({
    type: 'plannotator_review',
    sessionId: 'ses_plannotatoripc',
    threadId,
    payload: '{}',
  })
  expect(
    await cancelPendingIpcRequest({
      id: pending.id,
      response: JSON.stringify({ error: 'timed out' }),
    }),
  ).toBe(true)

  const processing = await createIpcRequest({
    type: 'plannotator_review',
    sessionId: 'ses_plannotatoripc',
    threadId,
    payload: '{}',
  })
  expect((await claimPendingIpcRequests()).map((request) => request.id)).toContain(processing.id)
  expect(
    await cancelPendingIpcRequest({
      id: processing.id,
      response: JSON.stringify({ error: 'timed out' }),
    }),
  ).toBe(false)
})
