import { expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { UIMessage } from "ai"
import { initializeDenBootstrapConfig, setDenBootstrapConfig, writeDenSettings } from "../src/app/lib/den"
import { stopRemoteThread } from "../src/react-app/domains/session/remote-threads/remote-thread-actions"
import { createSessionDraftStore, cloudSessionDraftScope } from "../src/react-app/domains/session/sync/draft-store"
import {
  REMOTE_THREAD_FOLLOW_MAX_MS,
  remoteThreadNeedsStatus,
  selectRemoteThreadKeysToCheck,
  useRemoteThreadStore,
  type RemoteThreadEntry,
} from "../src/react-app/domains/session/remote-threads/remote-thread-store"
import { remoteSessionRouteId } from "../src/lib/remote-session-route"
import { mergeRemoteThreadStart, parseRemoteStop, remoteThreadActivitiesFromToolPart } from "../src/lib/remote-session-thread"
import { conversationRemoteTasks } from "../src/react-app/domains/session/surface/composer/composer-subagent-tracker"
import {
  clearRemoteFollowUpDraftMessageId,
  remoteFollowUpDraftMessageId,
} from "../src/react-app/domains/session/remote-threads/remote-draft-message-id"

function makeEntry(overrides: Partial<RemoteThreadEntry> & { id: string }): RemoteThreadEntry {
  const now = overrides.firstSeenAt ?? 10_000
  return {
    start: {
      key: `command:${overrides.id}`,
      ref: { commandId: overrides.id },
      toolCallId: `call_${overrides.id}`,
      title: `Task ${overrides.id}`,
      prompt: null,
      target: "desktop",
      sessionId: null,
      workspaceId: null,
      computerId: null,
    },
    organizationId: overrides.organizationId ?? "org_a",
    version: overrides.version ?? null,
    status: overrides.status ?? null,
    stale: overrides.stale ?? false,
    checkedAt: overrides.checkedAt ?? null,
    activeSince: overrides.activeSince ?? now,
    firstSeenAt: now,
    followedUpAt: overrides.followedUpAt ?? null,
    followUpVersion: overrides.followUpVersion ?? null,
    revivedAt: overrides.revivedAt ?? null,
    owners: overrides.owners ?? {},
    viewers: overrides.viewers ?? 1,
    lastViewedAt: overrides.lastViewedAt ?? now,
  }
}

test("stop requires the target computer's affirmative receipt", () => {
  const desktopReceipt = { target: "desktop", sessionId: "ses_remote", stopped: true, reason: null }
  const cloudReceipt = { sessionId: "ses_remote", accepted: true }
  expect(parseRemoteStop(desktopReceipt, "desktop")).toEqual({ kind: "confirmed" })
  expect(parseRemoteStop(cloudReceipt, "cloud")).toEqual({ kind: "confirmed" })
  expect(parseRemoteStop(desktopReceipt, "cloud")).toEqual({ kind: "unconfirmed" })
  expect(parseRemoteStop(cloudReceipt, "desktop")).toEqual({ kind: "unconfirmed" })
  expect(parseRemoteStop({ accepted: false }, "cloud")).toEqual({ kind: "unconfirmed" })
  expect(parseRemoteStop({}, "desktop")).toEqual({ kind: "unconfirmed" })
})

test("pending and different-turn stop receipts are not confirmations", () => {
  const pending = { state: "pending", requestId: "rsr_stop" }
  const differentTurn = { stopped: false, reason: "different_turn" }
  expect(parseRemoteStop(pending, "desktop")).toEqual({ kind: "pending" })
  expect(parseRemoteStop(differentTurn, "desktop")).toEqual({ kind: "different_turn" })
  expect(parseRemoteStop(differentTurn, "cloud")).toEqual({ kind: "different_turn" })
})

test("stop preserves a reported request error", () => {
  expect(parseRemoteStop({ error: "stop_unavailable", message: "Stop is unavailable.", retryable: false }, "cloud")).toEqual({
    kind: "error", code: "stop_unavailable", message: "Stop is unavailable.", retryable: false,
  })
})

test("a pending stop polls its receipt without resending the guarded stop", async () => {
  const baseUrl = "https://den.example.test"
  const remoteSessionsPath = "/api/den/v1/remote-sessions"
  const requests: Array<{ path: string; body: unknown }> = []
  GlobalRegistrator.register({ url: "http://localhost:5173/" })
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname
    requests.push({ path, body: JSON.parse(String(init?.body)) })
    if (path === `${remoteSessionsPath}/stop`) return Response.json({ state: "pending", requestId: "rsr_stop" })
    if (path === `${remoteSessionsPath}/read`) return Response.json({ stopped: false, reason: "different_turn" })
    throw new Error(`Unexpected request: ${path}`)
  })
  try {
    await initializeDenBootstrapConfig()
    await setDenBootstrapConfig({ baseUrl, apiBaseUrl: baseUrl })
    writeDenSettings({ baseUrl, apiBaseUrl: baseUrl, authToken: "fixture-session", activeOrgId: "org_a" }, { persistBootstrap: false })
    const entry = makeEntry({ id: "rsc_stop" })
    entry.start = { ...entry.start, sessionId: "ses_remote", workspaceId: "ws_remote" }

    const result = await stopRemoteThread(entry, "msg_guard")

    expect(result).toMatchObject({ code: "different_turn", retryable: false })
    expect(requests).toEqual([
      { path: `${remoteSessionsPath}/stop`, body: { sessionId: "ses_remote", workspaceId: "ws_remote", messageId: "msg_guard" } },
      { path: `${remoteSessionsPath}/read`, body: { requestId: "rsr_stop" } },
    ])
  } finally {
    fetch.mockRestore()
    await GlobalRegistrator.unregister()
  }
})

test("opening an old remote task can resolve its session without polling it in the background", () => {
  const now = REMOTE_THREAD_FOLLOW_MAX_MS + 1000
  const entry = makeEntry({ id: "rsc_old", activeSince: 100, firstSeenAt: now, viewers: 1 })
  expect(remoteThreadNeedsStatus(entry, "org_a", now)).toBe(true)
  expect(remoteThreadNeedsStatus({ ...entry, viewers: 0 }, "org_a", now)).toBe(false)
  expect(remoteThreadNeedsStatus(entry, "org_b", now)).toBe(false)
})

test("switching organization resets a watched remote thread entry instead of stranding it", () => {
  const start = makeEntry({ id: "rsc_switch" }).start
  const stopA = useRemoteThreadStore.getState().watch(start, {
    owner: { workspaceId: "ws_1", sessionId: "ses_1" },
    organizationId: "org_a",
    startedAt: 1_000,
  })
  expect(useRemoteThreadStore.getState().threads[start.key]?.organizationId).toBe("org_a")
  const stopB = useRemoteThreadStore.getState().watch(start, {
    owner: { workspaceId: "ws_2", sessionId: "ses_2" },
    organizationId: "org_b",
    startedAt: 2_000,
  })
  const entry = useRemoteThreadStore.getState().threads[start.key]
  expect(entry?.organizationId).toBe("org_b")
  expect(entry?.status).toBeNull()
  expect(Object.keys(entry?.owners ?? {})).toEqual(["ws_2:ses_2"])
  stopA()
  stopB()
})

test("status polling rotates unsettled tasks when more than ten exist", () => {
  const now = 50_000
  const threads: Record<string, RemoteThreadEntry> = {}
  for (let index = 0; index < 12; index += 1) {
    const id = `rsc_${String(index).padStart(2, "0")}`
    threads[`command:${id}`] = makeEntry({
      id,
      firstSeenAt: now - 10_000,
      checkedAt: index < 10 ? now - (10 - index) * 1000 : null,
      viewers: 1,
    })
  }
  const selected = selectRemoteThreadKeysToCheck(threads, "org_a", now)
  expect(selected).toHaveLength(10)
  expect(selected[0]).toBe("command:rsc_10")
  expect(selected[1]).toBe("command:rsc_11")
  expect(selected[2]).toBe("command:rsc_00")
})

test("a long chat discovers remote tasks from send and multi-call scripts without misattributing send output to create or owning status-only checks", () => {
  const now = 100_000
  const messages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Is it working on it?" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [{
        type: "dynamic-tool",
        toolCallId: "call_script_1",
        toolName: "execute",
        state: "output-available",
        input: { code: "return await tools['openwork-cloud'].execute_capability({ name: 'remote-session:send', body: { sessionId: 'ses_remote', prompt: 'Continue' } })" },
        output: JSON.stringify({
          target: "desktop",
          requestId: "rsr_1",
          sessionId: "ses_remote",
          workspaceId: "ws_remote",
          commandId: "rsc_long_chat",
          state: "accepted",
        }),
        callProviderMetadata: {
          openwork: {
            toolStartedAt: now - 5_000,
            codeMode: {
              calls: [
                {
                  tool: "openwork-cloud.execute_capability",
                  status: "completed",
                  input: { name: "remote-session:send", body: { sessionId: "ses_remote", workspaceId: "ws_remote", prompt: "Continue" } },
                },
                {
                  tool: "openwork-cloud.execute_capability",
                  status: "completed",
                  input: { name: "remote-session:create", body: { target: "desktop", title: "Other task", prompt: "Other" } },
                },
              ],
              details: [],
            },
          },
        },
      }],
    },
  ]

  const tasks = conversationRemoteTasks(messages, now)
  expect(tasks.current.map((task) => task.start.key)).toEqual(["command:rsc_long_chat"])
  expect(tasks.current[0]?.start.title).toBe("Task")
  expect(tasks.current[0]?.start.sessionId).toBe("ses_remote")

  const statusOnly: UIMessage[] = [
    { id: "u0", role: "user", parts: [{ type: "text", text: "How are my tasks?" }] },
    {
      id: "a0",
      role: "assistant",
      parts: [{
        type: "dynamic-tool",
        toolCallId: "call_status",
        toolName: "openwork-cloud_execute_capability",
        state: "output-available",
        input: { name: "remote-session:status", body: { threads: [{ commandId: "rsc_good" }, { commandId: "rsc_bogus" }] } },
        output: JSON.stringify({
          threads: [
            { ref: "rsc_good", changed: true, target: "desktop", title: "Build clip", sessionId: "ses_good", workspaceId: "ws_good", computerId: "cmp_1" },
            { ref: "rsc_bogus", changed: true, target: "desktop", state: "error", error: { code: "unknown_command", message: "Not available" } },
          ],
        }),
      }],
    },
    { id: "u1", role: "user", parts: [{ type: "text", text: "Thanks" }] },
  ]
  const statusActivities = remoteThreadActivitiesFromToolPart(statusOnly[1]!.parts[0] as never)
  expect(statusActivities.map((activity) => activity.start.key)).toEqual(["command:rsc_good"])
  expect(conversationRemoteTasks(statusOnly, now).earlier).toEqual([])
})

test("merging remote thread starts keeps a longer prompt over a truncated cached one", () => {
  const truncated = makeEntry({ id: "rsc_prompt" }).start
  const merged = mergeRemoteThreadStart(
    { ...truncated, prompt: "Short cached…" },
    { ...truncated, prompt: "Full prompt from the original message history" },
  )
  expect(merged.prompt).toBe("Full prompt from the original message history")
})

test("a fresh draft store reopens a remote follow-up for the same member only and mints a fresh message id when edited", () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const scope = cloudSessionDraftScope({ principalId: "member_1", organizationId: "org_1" })
  const otherScope = cloudSessionDraftScope({ principalId: "member_2", organizationId: "org_1" })
  const route = remoteSessionRouteId("command:rsc_draft")
  const first = createSessionDraftStore({ storage })
  expect(first.save(scope, "remote", route, { text: "Also check the dates", mode: "prompt" }).status).toBe("saved")
  first.dispose()
  const reopened = createSessionDraftStore({ storage })
  expect(reopened.get(scope, "remote", route)?.text).toBe("Also check the dates")
  expect(reopened.get(otherScope, "remote", route)).toBeNull()
  reopened.clear(scope, "remote", route)
  expect(createSessionDraftStore({ storage }).get(scope, "remote", route)).toBeNull()

  const firstId = remoteFollowUpDraftMessageId(scope, "command:rsc_draft", "Also check the dates")
  expect(remoteFollowUpDraftMessageId(scope, "command:rsc_draft", "  Also check the dates  ")).toBe(firstId)
  const editedId = remoteFollowUpDraftMessageId(scope, "command:rsc_draft", "Also check the dates and totals")
  expect(editedId).not.toBe(firstId)
  clearRemoteFollowUpDraftMessageId(scope, "command:rsc_draft")

  useRemoteThreadStore.getState().applyBoundSessions("org_1", [{
    threadKey: "command:rsc_bound",
    commandId: "rsc_bound",
    parentSessionId: "ses_parent_1",
    parentWorkspaceId: "ws_parent_1",
    title: "Release notes",
    prompt: "Check the release notes",
    target: "desktop",
    status: {
      ref: "rsc_bound",
      changed: true,
      version: "v_bound",
      target: "desktop",
      state: "running",
      waitingFor: null,
      title: "Release notes",
      computerId: "cmp_1",
      computerLabel: "Studio computer",
      sessionId: "ses_remote_1",
      workspaceId: "ws_remote_1",
      messageCount: 2,
      preview: null,
      latestStep: "Reading changelog",
      error: null,
      observedAt: 1000,
      pending: null,
    },
    activeSince: 500,
    updatedAt: 1000,
    tailUpdatedAt: 1000,
  }], {
    replace: true,
    tails: {
      "command:rsc_bound": {
        title: "Release notes",
        nextCursor: null,
        messages: [{ id: "m1", role: "assistant", text: "Ready", toolCalls: [], error: null, createdAt: 1, completedAt: 2 }],
      },
    },
  })
  const bound = useRemoteThreadStore.getState().threads["command:rsc_bound"]
  expect(bound?.status?.computerLabel).toBe("Studio computer")
  expect(bound?.owners["ws_parent_1:ses_parent_1"]).toEqual({ workspaceId: "ws_parent_1", sessionId: "ses_parent_1" })
  expect(useRemoteThreadStore.getState().tailsByKey["command:rsc_bound"]?.messages[0]?.text).toBe("Ready")
  useRemoteThreadStore.getState().clearAll()
})
