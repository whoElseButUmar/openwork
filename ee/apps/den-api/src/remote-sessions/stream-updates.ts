import type { RemoteSessionReadResult } from "@openwork/types/automations"
import type { BoundRemoteSession, RemoteSessionStreamUpdateEvent } from "@openwork/types/den/remote-sessions"

const STREAM_TAILS_PER_POLL = 5

type Tail = { updatedAt: number; payload: RemoteSessionReadResult }

function sessionRevisions(sessions: readonly BoundRemoteSession[]) {
  return new Map(sessions.map((session) => [session.threadKey, {
    version: session.status.version,
    tailUpdatedAt: session.tailUpdatedAt,
  }]))
}

export function createRemoteSessionStreamUpdates(initial: readonly BoundRemoteSession[], options: {
  readTail: (threadKey: string) => Promise<Tail | null>
  publish: (update: RemoteSessionStreamUpdateEvent) => Promise<void>
}) {
  let observed = sessionRevisions(initial)
  const pendingTails = new Map<string, number>()

  return async function publishUpdates(latest: readonly BoundRemoteSession[]): Promise<boolean> {
    const changed: BoundRemoteSession[] = []
    for (const session of latest) {
      const previous = observed.get(session.threadKey)
      const tailUpdatedAt = session.tailUpdatedAt
      const tailChanged = tailUpdatedAt !== null && tailUpdatedAt !== previous?.tailUpdatedAt
      if (session.status.version !== previous?.version || tailChanged) {
        changed.push(session)
      }
      if (tailChanged) {
        pendingTails.set(session.threadKey, tailUpdatedAt)
      }
    }

    observed = sessionRevisions(latest)
    for (const threadKey of pendingTails.keys()) {
      const session = observed.get(threadKey)
      if (!session || session.tailUpdatedAt === null) {
        pendingTails.delete(threadKey)
      }
    }

    const tails: Record<string, RemoteSessionReadResult> = {}
    for (const [threadKey, updatedAt] of [...pendingTails].slice(0, STREAM_TAILS_PER_POLL)) {
      pendingTails.delete(threadKey)
      pendingTails.set(threadKey, updatedAt)
      const stored = await options.readTail(threadKey)
      if (stored?.updatedAt === updatedAt) {
        tails[threadKey] = stored.payload
      }
    }

    const deliveredKeys = Object.keys(tails)
    if (changed.length === 0 && deliveredKeys.length === 0) {
      return false
    }

    await options.publish({
      type: "update",
      sessions: changed,
      ...(deliveredKeys.length > 0 ? { tails } : {}),
    })
    for (const threadKey of deliveredKeys) {
      pendingTails.delete(threadKey)
    }
    return true
  }
}
