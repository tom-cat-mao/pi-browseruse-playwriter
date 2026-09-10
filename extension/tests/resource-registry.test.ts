import { describe, expect, test } from 'vitest'
import {
  addGroup,
  addTab,
  appendRequestLedgerEntry,
  buildCreateRequestFingerprint,
  buildInventory,
  classifyCreateRequestDedupe,
  classifyFailedCreateCleanup,
  classifyPendingCreateRecovery,
  clearGroupChromeBinding,
  clearTabAttachment,
  createEmptyRegistry,
  findActiveTabByChromeTabId,
  findGroup,
  findRequestLedgerEntry,
  findTab,
  isChromeTabTombstoned,
  listSessionGroups,
  listSessionTabs,
  parseRegistry,
  reconcileRegistry,
  releaseTab,
  removeRequestLedgerEntry,
  renameGroup,
  setGroupChromeBinding,
  setGroupState,
  setGroupWindowId,
  setTabAttachment,
  setTabPageInfo,
  updateRequestLedgerPhase,
} from '../src/resource-registry'
import type { ObservedChromeTab } from '../src/resource-registry'

const profileId = 'profile-1'
const epoch = 'epoch-a'

function createRegistryWithGroup() {
  let registry = createEmptyRegistry({ profileId, browserEpoch: epoch })
  registry = addGroup(registry, { groupId: 'pg-1', sessionId: 'session-1', name: 'tasks', browserEpoch: epoch })
  registry = setGroupChromeBinding(registry, { groupId: 'pg-1', chromeGroupId: 11, windowId: 7 })
  registry = addTab(registry, {
    tabId: 'pt-1',
    groupId: 'pg-1',
    sessionId: 'session-1',
    chromeTabId: 101,
    url: 'about:blank',
    title: '',
    browserEpoch: epoch,
  })
  registry = setTabAttachment(registry, { tabId: 'pt-1', targetId: 'target-1', cdpSessionId: 'pw-tab-1' })
  return registry
}

function observedTab(options: { chromeTabId: number; chromeGroupId: number }): ObservedChromeTab {
  return {
    chromeTabId: options.chromeTabId,
    chromeGroupId: options.chromeGroupId,
    windowId: 7,
    url: 'https://example.com/',
    title: 'Example',
  }
}

describe('managed resource registry ownership', () => {
  test('a transport disconnect keeps ownership without tombstones', () => {
    const attached = createRegistryWithGroup()
    const disconnected = clearTabAttachment(attached, 'pt-1')

    expect({
      state: findTab(disconnected, 'pt-1')?.state,
      tombstoned: isChromeTabTombstoned(disconnected, 101),
      inventoryTabs: buildInventory(disconnected).tabs.map((tab) => {
        return { tabId: tab.tabId, state: tab.state, hasTarget: tab.targetId !== undefined }
      }),
    }).toMatchInlineSnapshot(`
      {
        "inventoryTabs": [
          {
            "hasTarget": false,
            "state": "disconnected",
            "tabId": "pt-1",
          },
        ],
        "state": "disconnected",
        "tombstoned": false,
      }
    `)
  })

  test('release writes a tombstone that reconcile never resurrects', () => {
    const attached = createRegistryWithGroup()
    const released = releaseTab(attached, 'pt-1')

    const result = reconcileRegistry(released, {
      browserEpoch: epoch,
      observedTabs: [observedTab({ chromeTabId: 101, chromeGroupId: 11 })],
      observedChromeGroupIds: [11],
    })

    expect({
      state: findTab(result.registry, 'pt-1')?.state,
      reattach: result.reattachTabIds,
      inventoryTabs: buildInventory(result.registry).tabs.map((tab) => {
        return {
          tabId: tab.tabId,
          state: tab.state,
          hasTarget: tab.targetId !== undefined,
          hasCdpSession: tab.cdpSessionId !== undefined,
        }
      }),
      listedTabs: listSessionTabs(result.registry, 'session-1').map((tab) => tab.tabId),
      changed: result.changed,
    }).toMatchInlineSnapshot(`
      {
        "changed": false,
        "inventoryTabs": [
          {
            "hasCdpSession": false,
            "hasTarget": false,
            "state": "released",
            "tabId": "pt-1",
          },
        ],
        "listedTabs": [],
        "reattach": [],
        "state": "released",
      }
    `)
  })

  test('released groups and their tabs stay published as tombstones without re-authorizing', () => {
    let registry = createRegistryWithGroup()
    registry = releaseTab(registry, 'pt-1')
    registry = setGroupState(registry, { groupId: 'pg-1', state: 'released' })

    const inventory = buildInventory(registry)

    expect({
      groups: inventory.groups.map((group) => {
        return { groupId: group.groupId, state: group.state }
      }),
      tabs: inventory.tabs.map((tab) => {
        return {
          tabId: tab.tabId,
          groupId: tab.groupId,
          state: tab.state,
          hasTarget: tab.targetId !== undefined,
          hasCdpSession: tab.cdpSessionId !== undefined,
        }
      }),
      activeLookup: findActiveTabByChromeTabId(registry, { chromeTabId: 101, browserEpoch: epoch }),
      listedGroups: listSessionGroups(registry, 'session-1').map((group) => group.groupId),
      listedTabs: listSessionTabs(registry, 'session-1').map((tab) => tab.tabId),
    }).toMatchInlineSnapshot(`
      {
        "activeLookup": undefined,
        "groups": [
          {
            "groupId": "pg-1",
            "state": "released",
          },
        ],
        "listedGroups": [],
        "listedTabs": [],
        "tabs": [
          {
            "groupId": "pg-1",
            "hasCdpSession": false,
            "hasTarget": false,
            "state": "released",
            "tabId": "pt-1",
          },
        ],
      }
    `)
  })

  test('session storage loss makes old records needs-rebind instead of reusing chrome ids', () => {
    const registry = createRegistryWithGroup()

    // Same Chrome process, but storage.session was cleared: a fresh epoch arrives
    // while the old chromeTabId/chromeGroupId numbers may already point at
    // unrelated tabs. These records must not be silently adopted.
    const result = reconcileRegistry(registry, {
      browserEpoch: 'epoch-after-storage-loss',
      observedTabs: [observedTab({ chromeTabId: 101, chromeGroupId: 11 })],
      observedChromeGroupIds: [11],
    })

    expect({
      tabState: findTab(result.registry, 'pt-1')?.state,
      tabKeptLogicalId: findTab(result.registry, 'pt-1')?.tabId,
      groupState: findGroup(result.registry, 'pg-1')?.state,
      groupChromeGroupId: findGroup(result.registry, 'pg-1')?.chromeGroupId,
      reattach: result.reattachTabIds,
    }).toMatchInlineSnapshot(`
      {
        "groupChromeGroupId": undefined,
        "groupState": "needs-rebind",
        "reattach": [],
        "tabKeptLogicalId": "pt-1",
        "tabState": "needs-rebind",
      }
    `)
  })

  test('same-epoch reconcile reattaches tabs still in the group and releases moved tabs', () => {
    let registry = createRegistryWithGroup()
    registry = addTab(registry, {
      tabId: 'pt-2',
      groupId: 'pg-1',
      sessionId: 'session-1',
      chromeTabId: 102,
      url: 'https://example.com/',
      title: 'Example',
      browserEpoch: epoch,
    })

    const result = reconcileRegistry(registry, {
      browserEpoch: epoch,
      observedTabs: [
        observedTab({ chromeTabId: 101, chromeGroupId: 11 }),
        observedTab({ chromeTabId: 102, chromeGroupId: -1 }),
      ],
      observedChromeGroupIds: [11],
    })

    expect({
      tabs: result.registry.tabs.map((tab) => {
        return { tabId: tab.tabId, state: tab.state }
      }),
      reattach: result.reattachTabIds,
    }).toMatchInlineSnapshot(`
      {
        "reattach": [
          101,
        ],
        "tabs": [
          {
            "state": "disconnected",
            "tabId": "pt-1",
          },
          {
            "state": "released",
            "tabId": "pt-2",
          },
        ],
      }
    `)
  })

  test('a chrome tab closed while offline becomes a tombstone and clears the binding', () => {
    const registry = createRegistryWithGroup()

    const result = reconcileRegistry(registry, {
      browserEpoch: epoch,
      observedTabs: [],
      observedChromeGroupIds: [],
    })

    expect({
      tabState: findTab(result.registry, 'pt-1')?.state,
      group: findGroup(result.registry, 'pg-1'),
      reattach: result.reattachTabIds,
    }).toMatchInlineSnapshot(`
      {
        "group": {
          "browserEpoch": "epoch-a",
          "groupId": "pg-1",
          "name": "tasks",
          "profileId": "profile-1",
          "revision": 5,
          "sessionId": "session-1",
          "state": "ready",
          "windowId": 7,
        },
        "reattach": [],
        "tabState": "released",
      }
    `)
  })

  test('a browser restart marks active records needs-rebind instead of adopting fresh tabs', () => {
    let registry = createRegistryWithGroup()
    registry = addTab(registry, {
      tabId: 'pt-2',
      groupId: 'pg-1',
      sessionId: 'session-1',
      chromeTabId: 102,
      url: 'https://example.com/',
      title: 'Example',
      browserEpoch: epoch,
    })
    registry = releaseTab(registry, 'pt-2')

    const restarted = reconcileRegistry(registry, {
      browserEpoch: 'epoch-b',
      observedTabs: [observedTab({ chromeTabId: 101, chromeGroupId: 11 })],
      observedChromeGroupIds: [11],
    })

    const secondPass = reconcileRegistry(restarted.registry, {
      browserEpoch: 'epoch-b',
      observedTabs: [],
      observedChromeGroupIds: [],
    })

    expect({
      browserEpoch: restarted.registry.browserEpoch,
      groups: restarted.registry.groups.map((group) => {
        return {
          groupId: group.groupId,
          state: group.state,
          chromeGroupId: group.chromeGroupId,
          windowId: group.windowId,
        }
      }),
      tabs: restarted.registry.tabs.map((tab) => {
        return { tabId: tab.tabId, state: tab.state, targetId: tab.targetId }
      }),
      reattach: restarted.reattachTabIds,
      needsRebindSurvivesSecondReconcile: findTab(secondPass.registry, 'pt-1')?.state,
    }).toMatchInlineSnapshot(`
      {
        "browserEpoch": "epoch-b",
        "groups": [
          {
            "chromeGroupId": undefined,
            "groupId": "pg-1",
            "state": "needs-rebind",
            "windowId": undefined,
          },
        ],
        "needsRebindSurvivesSecondReconcile": "needs-rebind",
        "reattach": [],
        "tabs": [
          {
            "state": "needs-rebind",
            "tabId": "pt-1",
            "targetId": undefined,
          },
        ],
      }
    `)
  })

  test('same-name groups stay separate and rename keeps group identity', () => {
    let registry = createEmptyRegistry({ profileId, browserEpoch: epoch })
    registry = addGroup(registry, { groupId: 'pg-1', sessionId: 'session-1', name: 'tasks', browserEpoch: epoch })
    registry = addGroup(registry, { groupId: 'pg-2', sessionId: 'session-1', name: 'tasks', browserEpoch: epoch })
    registry = addGroup(registry, { groupId: 'pg-3', sessionId: 'session-2', name: 'tasks', browserEpoch: epoch })
    registry = renameGroup(registry, { groupId: 'pg-1', name: 'tasks renamed' })

    expect({
      groups: registry.groups.map((group) => {
        return { groupId: group.groupId, sessionId: group.sessionId, name: group.name }
      }),
    }).toMatchInlineSnapshot(`
      {
        "groups": [
          {
            "groupId": "pg-1",
            "name": "tasks renamed",
            "sessionId": "session-1",
          },
          {
            "groupId": "pg-2",
            "name": "tasks",
            "sessionId": "session-1",
          },
          {
            "groupId": "pg-3",
            "name": "tasks",
            "sessionId": "session-2",
          },
        ],
      }
    `)
  })

  test('released resources disappear from session listings', () => {
    let registry = createRegistryWithGroup()
    registry = addTab(registry, {
      tabId: 'pt-2',
      groupId: 'pg-1',
      sessionId: 'session-1',
      chromeTabId: 102,
      url: 'https://example.com/',
      title: 'Example',
      browserEpoch: epoch,
    })
    registry = releaseTab(registry, 'pt-2')

    expect({
      listedTabs: listSessionTabs(registry, 'session-1').map((tab) => tab.tabId),
      otherSessionTabs: listSessionTabs(registry, 'session-2').map((tab) => tab.tabId),
      listedGroups: listSessionGroups(registry, 'session-1').map((group) => group.groupId),
    }).toMatchInlineSnapshot(`
      {
        "listedGroups": [
          "pg-1",
        ],
        "listedTabs": [
          "pt-1",
        ],
        "otherSessionTabs": [],
      }
    `)
  })

  test('a group chrome binding can be dropped without releasing the logical group', () => {
    const registry = createRegistryWithGroup()
    const cleared = clearGroupChromeBinding(registry, { groupId: 'pg-1' })

    expect({
      group: findGroup(cleared, 'pg-1'),
      tabStillActive: findTab(cleared, 'pt-1')?.state,
    }).toMatchInlineSnapshot(`
      {
        "group": {
          "browserEpoch": "epoch-a",
          "groupId": "pg-1",
          "name": "tasks",
          "profileId": "profile-1",
          "revision": 5,
          "sessionId": "session-1",
          "state": "ready",
          "windowId": 7,
        },
        "tabStillActive": "ready",
      }
    `)
  })

  test('revision grows monotonically and page info no-ops when unchanged', () => {
    const registry = createRegistryWithGroup()
    const samePageInfo = setTabPageInfo(registry, { tabId: 'pt-1', url: 'about:blank', title: '' })
    const nextRevision = renameGroup(registry, { groupId: 'pg-1', name: 'renamed' }).revision

    expect({
      revisions: {
        initial: registry.revision,
        samePageInfoKeptReference: samePageInfo === registry,
        afterRename: nextRevision,
      },
    }).toMatchInlineSnapshot(`
      {
        "revisions": {
          "afterRename": 5,
          "initial": 4,
          "samePageInfoKeptReference": true,
        },
      }
    `)
  })

  test('create dedup ledger persists payload fingerprints and prunes old entries', () => {
    const tabsFingerprint = buildCreateRequestFingerprint({
      kind: 'tabs.create',
      groupId: 'pg-1',
      url: 'https://example.com/',
    })
    let registry = createEmptyRegistry({ profileId, browserEpoch: epoch })
    registry = appendRequestLedgerEntry(registry, {
      entry: {
        sessionId: 'session-1',
        requestId: 'req-1',
        operation: 'tabs.create',
        fingerprint: tabsFingerprint,
        createdAt: 1000,
        tabId: 'pt-1',
      },
      now: 1000,
      maxEntries: 2,
      maxAgeMs: 1000,
    })
    registry = appendRequestLedgerEntry(registry, {
      entry: {
        sessionId: 'session-1',
        requestId: 'req-2',
        operation: 'tabs.create',
        fingerprint: tabsFingerprint,
        createdAt: 1500,
        tabId: 'pt-2',
      },
      now: 1500,
      maxEntries: 2,
      maxAgeMs: 1000,
    })
    // Overwriting the same sessionId+requestId replaces the old entry; the age
    // filter then drops req-2 because its payload is older than 1000ms.
    registry = appendRequestLedgerEntry(registry, {
      entry: {
        sessionId: 'session-1',
        requestId: 'req-1',
        operation: 'tabs.create',
        fingerprint: 'changed',
        createdAt: 2600,
        tabId: 'pt-3',
      },
      now: 2600,
      maxEntries: 2,
      maxAgeMs: 1000,
    })

    expect({
      req1: findRequestLedgerEntry(registry, { sessionId: 'session-1', requestId: 'req-1' }),
      req2: findRequestLedgerEntry(registry, { sessionId: 'session-1', requestId: 'req-2' }),
      otherSession: findRequestLedgerEntry(registry, { sessionId: 'session-2', requestId: 'req-1' }),
      fingerprints: {
        groups: buildCreateRequestFingerprint({ kind: 'groups.create', name: 'tasks' }),
        tabs: tabsFingerprint,
      },
    }).toMatchInlineSnapshot(`
      {
        "fingerprints": {
          "groups": "groups.create|name=tasks",
          "tabs": "tabs.create|groupId=pg-1|url=https://example.com/",
        },
        "otherSession": undefined,
        "req1": {
          "createdAt": 2600,
          "fingerprint": "changed",
          "operation": "tabs.create",
          "requestId": "req-1",
          "sessionId": "session-1",
          "tabId": "pt-3",
        },
        "req2": undefined,
      }
    `)
  })

  test('create request dedup decisions reject payload reuse and replay completed creates', () => {
    const entry = {
      sessionId: 'session-1',
      requestId: 'req-1',
      operation: 'tabs.create' as const,
      fingerprint: 'tabs.create|groupId=pg-1|url=https://example.com/',
      phase: 'completed' as const,
      createdAt: 1000,
      tabId: 'pt-1',
    }

    expect({
      noEntry: classifyCreateRequestDedupe({
        ledgerEntry: undefined,
        operation: 'tabs.create',
        fingerprint: entry.fingerprint,
      }),
      replay: classifyCreateRequestDedupe({
        ledgerEntry: entry,
        operation: 'tabs.create',
        fingerprint: entry.fingerprint,
      }),
      pending: classifyCreateRequestDedupe({
        ledgerEntry: { ...entry, phase: 'pending' },
        operation: 'tabs.create',
        fingerprint: entry.fingerprint,
      }),
      differentPayload: classifyCreateRequestDedupe({
        ledgerEntry: entry,
        operation: 'tabs.create',
        fingerprint: 'tabs.create|groupId=pg-1|url=https://other.example/',
      }),
      differentOperation: classifyCreateRequestDedupe({
        ledgerEntry: entry,
        operation: 'groups.create',
        fingerprint: entry.fingerprint,
      }),
    }).toMatchInlineSnapshot(`
      {
        "differentOperation": "reject-payload-mismatch",
        "differentPayload": "reject-payload-mismatch",
        "noEntry": "proceed",
        "pending": "recover-pending",
        "replay": "replay",
      }
    `)
  })

  test('pending create recovery only resumes verifiably owned tabs', () => {
    const base = {
      hasRecord: true,
      recordState: 'disconnected' as const,
      recordBrowserEpoch: epoch,
      browserEpoch: epoch,
      chromeTabExists: true,
      observedChromeGroupId: 11,
      expectedChromeGroupId: 11,
    }
    const cases: Array<{ name: string; options: Parameters<typeof classifyPendingCreateRecovery>[0] }> = [
      { name: 'owned-tab', options: base },
      { name: 'no-record', options: { ...base, hasRecord: false } },
      { name: 'released', options: { ...base, recordState: 'released' as const } },
      { name: 'old-epoch', options: { ...base, recordBrowserEpoch: 'epoch-a', browserEpoch: 'epoch-b' } },
      { name: 'tab-gone', options: { ...base, chromeTabExists: false } },
      { name: 'tab-moved', options: { ...base, observedChromeGroupId: 99 } },
      { name: 'unbound-group', options: { ...base, expectedChromeGroupId: undefined } },
    ]

    expect(
      cases.map((entry) => {
        return { name: entry.name, decision: classifyPendingCreateRecovery(entry.options) }
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "decision": "resume-attach",
          "name": "owned-tab",
        },
        {
          "decision": "resource-not-recorded",
          "name": "no-record",
        },
        {
          "decision": "released",
          "name": "released",
        },
        {
          "decision": "unknown",
          "name": "old-epoch",
        },
        {
          "decision": "unknown",
          "name": "tab-gone",
        },
        {
          "decision": "unknown",
          "name": "tab-moved",
        },
        {
          "decision": "resume-attach",
          "name": "unbound-group",
        },
      ]
    `)
  })

  test('ledger phase updates and removal are explicit transactions', () => {
    let registry = createRegistryWithGroup()
    registry = appendRequestLedgerEntry(registry, {
      entry: {
        sessionId: 'session-1',
        requestId: 'req-1',
        operation: 'tabs.create',
        fingerprint: 'fp',
        phase: 'pending',
        createdAt: 1000,
        tabId: 'pt-1',
      },
      now: 1000,
      maxEntries: 10,
      maxAgeMs: 10000,
    })
    const completed = updateRequestLedgerPhase(registry, {
      sessionId: 'session-1',
      requestId: 'req-1',
      phase: 'completed',
      chromeTabId: 101,
    })
    const removed = removeRequestLedgerEntry(completed, { sessionId: 'session-1', requestId: 'req-1' })

    expect({
      pending: findRequestLedgerEntry(registry, { sessionId: 'session-1', requestId: 'req-1' }),
      completed: findRequestLedgerEntry(completed, { sessionId: 'session-1', requestId: 'req-1' }),
      removed: findRequestLedgerEntry(removed, { sessionId: 'session-1', requestId: 'req-1' }),
    }).toMatchInlineSnapshot(`
      {
        "completed": {
          "chromeTabId": 101,
          "createdAt": 1000,
          "fingerprint": "fp",
          "operation": "tabs.create",
          "phase": "completed",
          "requestId": "req-1",
          "sessionId": "session-1",
          "tabId": "pt-1",
        },
        "pending": {
          "createdAt": 1000,
          "fingerprint": "fp",
          "operation": "tabs.create",
          "phase": "pending",
          "requestId": "req-1",
          "sessionId": "session-1",
          "tabId": "pt-1",
        },
        "removed": undefined,
      }
    `)
  })

  test('reconcile never releases records written after the observed snapshot', () => {
    const registryBeforeObserve = createRegistryWithGroup()
    const revisionBeforeObserve = registryBeforeObserve.revision
    // A tab created while Chrome was being observed: it is not in the snapshot.
    const registry = addTab(registryBeforeObserve, {
      tabId: 'pt-2',
      groupId: 'pg-1',
      sessionId: 'session-1',
      chromeTabId: 202,
      url: 'about:blank',
      title: '',
      browserEpoch: epoch,
    })
    const observed = [observedTab({ chromeTabId: 101, chromeGroupId: 11 })]

    const withoutFence = reconcileRegistry(registry, {
      browserEpoch: epoch,
      observedTabs: observed,
      observedChromeGroupIds: [11],
    })
    const withFence = reconcileRegistry(registry, {
      browserEpoch: epoch,
      observedTabs: observed,
      observedChromeGroupIds: [11],
      ignoreRecordsNewerThan: revisionBeforeObserve,
    })

    expect({
      withoutFence: findTab(withoutFence.registry, 'pt-2')?.state,
      withFence: findTab(withFence.registry, 'pt-2')?.state,
      withFenceReattach: withFence.reattachTabIds,
      withoutFenceReattach: withoutFence.reattachTabIds,
    }).toMatchInlineSnapshot(`
      {
        "withFence": "disconnected",
        "withFenceReattach": [],
        "withoutFence": "released",
        "withoutFenceReattach": [
          101,
        ],
      }
    `)
  })

  test('chrome-id lookups are pinned to the current epoch and skip released/needs-rebind', () => {
    let registry = createRegistryWithGroup()
    registry = addTab(registry, {
      tabId: 'pt-2',
      groupId: 'pg-1',
      sessionId: 'session-1',
      chromeTabId: 102,
      url: 'https://example.com/',
      title: 'Example',
      browserEpoch: epoch,
    })
    registry = releaseTab(registry, 'pt-2')
    const restarted = reconcileRegistry(registry, {
      browserEpoch: 'epoch-b',
      observedTabs: [],
      observedChromeGroupIds: [],
    }).registry

    expect({
      currentEpoch: findActiveTabByChromeTabId(registry, { chromeTabId: 101, browserEpoch: epoch })?.tabId,
      released: findActiveTabByChromeTabId(registry, { chromeTabId: 102, browserEpoch: epoch }),
      wrongEpoch: findActiveTabByChromeTabId(restarted, { chromeTabId: 101, browserEpoch: 'epoch-b' }),
      tombstoneCurrentEpoch: isChromeTabTombstoned(registry, 102, { browserEpoch: epoch }),
      tombstoneWrongEpoch: isChromeTabTombstoned(registry, 102, { browserEpoch: 'epoch-b' }),
    }).toMatchInlineSnapshot(`
      {
        "currentEpoch": "pt-1",
        "released": undefined,
        "tombstoneCurrentEpoch": true,
        "tombstoneWrongEpoch": false,
        "wrongEpoch": undefined,
      }
    `)
  })

  test('failed create cleanup only removes tabs that are still provably ours', () => {
    const cases: Array<{ name: string; options: Parameters<typeof classifyFailedCreateCleanup>[0] }> = [
      {
        name: 'still-ours',
        options: {
          recordState: 'ready',
          recordBrowserEpoch: epoch,
          browserEpoch: epoch,
          approvedChromeGroupId: 11,
          observedChromeGroupId: 11,
        },
      },
      {
        name: 'user-released',
        options: {
          recordState: 'released',
          recordBrowserEpoch: epoch,
          browserEpoch: epoch,
          approvedChromeGroupId: 11,
          observedChromeGroupId: 11,
        },
      },
      {
        name: 'user-moved',
        options: {
          recordState: 'ready',
          recordBrowserEpoch: epoch,
          browserEpoch: epoch,
          approvedChromeGroupId: 11,
          observedChromeGroupId: 99,
        },
      },
      {
        name: 'epoch-mismatch',
        options: {
          recordState: 'ready',
          recordBrowserEpoch: 'epoch-a',
          browserEpoch: 'epoch-b',
          approvedChromeGroupId: 11,
          observedChromeGroupId: 11,
        },
      },
      {
        name: 'missing-record-in-group',
        options: {
          recordState: 'missing',
          recordBrowserEpoch: undefined,
          browserEpoch: epoch,
          approvedChromeGroupId: 11,
          observedChromeGroupId: 11,
        },
      },
      {
        name: 'missing-record-moved',
        options: {
          recordState: 'missing',
          recordBrowserEpoch: undefined,
          browserEpoch: epoch,
          approvedChromeGroupId: 11,
          observedChromeGroupId: 99,
        },
      },
      {
        name: 'tab-gone',
        options: {
          recordState: 'missing',
          recordBrowserEpoch: undefined,
          browserEpoch: epoch,
          approvedChromeGroupId: 11,
          observedChromeGroupId: null,
        },
      },
    ]

    expect(
      cases.map((entry) => {
        return { name: entry.name, decision: classifyFailedCreateCleanup(entry.options) }
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "decision": "remove-chrome-tab",
          "name": "still-ours",
        },
        {
          "decision": "leave-user-tab",
          "name": "user-released",
        },
        {
          "decision": "leave-user-tab",
          "name": "user-moved",
        },
        {
          "decision": "leave-user-tab",
          "name": "epoch-mismatch",
        },
        {
          "decision": "remove-chrome-tab",
          "name": "missing-record-in-group",
        },
        {
          "decision": "leave-user-tab",
          "name": "missing-record-moved",
        },
        {
          "decision": "remove-chrome-tab",
          "name": "tab-gone",
        },
      ]
    `)
  })

  test('group window binding follows the user moving the group', () => {
    const registry = createRegistryWithGroup()
    const moved = setGroupWindowId(registry, { groupId: 'pg-1', windowId: 12 })
    const same = setGroupWindowId(moved, { groupId: 'pg-1', windowId: 12 })

    expect({
      windowId: findGroup(moved, 'pg-1')?.windowId,
      noopKeepsReference: same === moved,
    }).toMatchInlineSnapshot(`
      {
        "noopKeepsReference": true,
        "windowId": 12,
      }
    `)
  })

  test('persisted registries round-trip and malformed payloads are rejected', () => {
    const registry = createRegistryWithGroup()
    const roundTripped = parseRegistry(JSON.parse(JSON.stringify(registry)))
    const legacyPayload: Record<string, unknown> = JSON.parse(JSON.stringify(registry))
    delete legacyPayload.requestLedger

    expect({
      roundTripped: roundTripped,
      legacyWithoutLedger: parseRegistry(legacyPayload)?.requestLedger,
      wrongVersion: parseRegistry({ ...JSON.parse(JSON.stringify(registry)), version: 2 }),
      badGroupsShape: parseRegistry({
        version: 1,
        profileId,
        browserEpoch: epoch,
        revision: 0,
        groups: 'nope',
        tabs: [],
      }),
      missingField: parseRegistry({
        version: 1,
        profileId,
        browserEpoch: epoch,
        revision: 0,
        groups: [{}],
        tabs: [],
      }),
    }).toMatchInlineSnapshot(`
      {
        "badGroupsShape": null,
        "legacyWithoutLedger": [],
        "missingField": null,
        "roundTripped": {
          "browserEpoch": "epoch-a",
          "groups": [
            {
              "browserEpoch": "epoch-a",
              "chromeGroupId": 11,
              "groupId": "pg-1",
              "name": "tasks",
              "profileId": "profile-1",
              "revision": 2,
              "sessionId": "session-1",
              "state": "ready",
              "windowId": 7,
            },
          ],
          "profileId": "profile-1",
          "requestLedger": [],
          "revision": 4,
          "tabs": [
            {
              "browserEpoch": "epoch-a",
              "cdpSessionId": "pw-tab-1",
              "chromeTabId": 101,
              "groupId": "pg-1",
              "profileId": "profile-1",
              "revision": 4,
              "sessionId": "session-1",
              "state": "ready",
              "tabId": "pt-1",
              "targetId": "target-1",
              "title": "",
              "url": "about:blank",
            },
          ],
          "version": 1,
        },
        "wrongVersion": null,
      }
    `)
  })
})
