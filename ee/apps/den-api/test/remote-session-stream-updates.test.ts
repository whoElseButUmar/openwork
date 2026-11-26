import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteSessionReadResult } from "@openwork/types/automations"
import type { BoundRemoteSession, RemoteSessionStreamUpdateEvent } from "@openwork/types/den/remote-sessions"
import { createRemoteSessionStreamUpdates } from "../src/remote-sessions/stream-updates.js"

function boundSession(threadKey: string, tailUpdatedAt: number): BoundRemoteSession {
  return {
    threadKey,
    commandId: threadKey,
    parentSessionId: null,
    parentWorkspaceId: null,
    title: "Remote task",
    prompt: null,
    target: "desktop",
    status: {
      ref: threadKey,
      changed: true,
      version: "initial",
      target: "desktop",
      state: "idle",
      waitingFor: null,
      title: null,
      computerId: null,
      computerLabel: null,
      sessionId: null,
      workspaceId: null,
      messageCount: null,
      preview: null,
      error: null,
      observedAt: null,
    },
    activeSince: 0,
    updatedAt: 0,
    tailUpdatedAt,
  }
}

const payload: RemoteSessionReadResult = {
  title: "Remote task",
  status: "idle",
  waitingFor: null,
  lastError: null,
  messageCount: 0,
  from: "end",
  messages: [],
  nextCursor: null,
}

test("a sixth changed transcript is sent on the next poll without a new write", async () => {
  const keys = Array.from({ length: 6 }, (_, index) => `command:task-${index + 1}`)
  const initial = keys.map((key) => boundSession(key, 1_000))
  const latest = keys.map((key) => boundSession(key, 2_000))
  const reads: string[] = []
  const events: RemoteSessionStreamUpdateEvent[] = []
  const publishUpdates = createRemoteSessionStreamUpdates(initial, {
    async readTail(threadKey) {
      reads.push(threadKey)
      return { updatedAt: 2_000, payload }
    },
    async publish(event) {
      events.push(event)
    },
  })

  assert.equal(await publishUpdates(latest), true)
  assert.deepEqual(reads, keys.slice(0, 5))
  assert.deepEqual(events[0]?.sessions, latest)
  assert.deepEqual(Object.keys(events[0]?.tails ?? {}), keys.slice(0, 5))

  assert.equal(await publishUpdates(latest), true)
  assert.deepEqual(reads, keys)
  assert.deepEqual(events[1]?.sessions, [])
  assert.deepEqual(Object.keys(events[1]?.tails ?? {}), keys.slice(5))

  assert.equal(await publishUpdates(latest), false)
  assert.deepEqual(reads, keys)
  assert.equal(events.length, 2)
})

test("missing or stale reads leave the advertised transcript queued", async () => {
  const threadKey = "command:retry"
  const latest = [boundSession(threadKey, 2_000)]
  const events: RemoteSessionStreamUpdateEvent[] = []
  let stored: { updatedAt: number; payload: RemoteSessionReadResult } | null = null
  const publishUpdates = createRemoteSessionStreamUpdates([boundSession(threadKey, 1_000)], {
    async readTail() {
      return stored
    },
    async publish(event) {
      events.push(event)
    },
  })

  assert.equal(await publishUpdates(latest), true)
  assert.deepEqual(events[0]?.sessions, latest)
  assert.equal(events[0]?.tails, undefined)

  stored = { updatedAt: 1_000, payload }
  assert.equal(await publishUpdates(latest), false)
  assert.equal(events.length, 1)

  stored = { updatedAt: 2_000, payload }
  assert.equal(await publishUpdates(latest), true)
  assert.deepEqual(events[1]?.tails, { [threadKey]: payload })
  assert.equal(await publishUpdates(latest), false)
})

test("ordinary status changes are published without rereading an unchanged transcript", async () => {
  const initial = boundSession("command:status", 1_000)
  const latest = { ...initial, status: { ...initial.status, version: "updated" } }
  let reads = 0
  const events: RemoteSessionStreamUpdateEvent[] = []
  const publishUpdates = createRemoteSessionStreamUpdates([initial], {
    async readTail() {
      reads += 1
      return { updatedAt: 1_000, payload }
    },
    async publish(event) {
      events.push(event)
    },
  })

  assert.equal(await publishUpdates([initial]), false)
  assert.equal(await publishUpdates([latest]), true)
  assert.deepEqual(events, [{ type: "update", sessions: [latest] }])
  assert.equal(reads, 0)
})
