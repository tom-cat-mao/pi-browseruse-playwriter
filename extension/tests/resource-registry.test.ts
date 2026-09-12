import {
  activeFirefoxTab,
  emptyFirefoxRegistry,
  firefoxInventory,
  firefoxPageSupported,
  firefoxRequestFingerprint,
  ownedFirefoxTab,
  parseFirefoxRegistry,
  reconcileFirefoxRegistry,
  releaseFirefoxTabs,
} from '../src/firefox-resources'
import type { FirefoxRegistry } from '../src/firefox-resources'
import { parseFirefoxBrowserRequest } from '../src/firefox-request-validation'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CoalescedPublisher, compareDiscoveredTabs } from '../src/managed-groups'
import type { DiscoverySortableTab } from '../src/managed-groups'
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
  function firefoxFixture(): FirefoxRegistry {
    const registry = emptyFirefoxRegistry({ profileId: 'firefox-profile', browserEpoch: 'firefox-epoch' })
    registry.revision = 1
    registry.groups.push({
      groupId: 'firefox-group',
      sessionId: 'session-1',
      profileId: registry.profileId,
      name: 'Existing tab',
      browserEpoch: registry.browserEpoch,
      revision: 1,
      state: 'ready',
      origin: 'existing',
    })
    registry.tabs.push({
      tabId: 'firefox-tab',
      groupId: 'firefox-group',
      sessionId: 'session-1',
      profileId: registry.profileId,
      browserEpoch: registry.browserEpoch,
      revision: 1,
      state: 'ready',
      chromeTabId: -1,
      browserTabId: 42,
      url: 'https://example.com',
      title: 'Example',
      origin: 'existing',
    })
    return registry
  }

  test('Firefox persisted identity roundtrips without inventing CDP bindings', () => {
    const registry = firefoxFixture()
    expect(parseFirefoxRegistry(JSON.parse(JSON.stringify(registry)))).toEqual(registry)
    expect(firefoxInventory(registry).tabs[0]).toMatchObject({ chromeTabId: -1, browserTabId: 42 })
    expect(firefoxInventory(registry)).not.toHaveProperty('ledger')
    expect(
      parseFirefoxRegistry({ ...registry, tabs: [{ ...registry.tabs[0], targetId: 'fake-cdp-target' }] }),
    ).toBeNull()
    expect(parseFirefoxRegistry({ ...registry, tabs: [{ ...registry.tabs[0], chromeTabId: 42 }] })).toBeNull()
    expect(
      parseFirefoxRegistry({ ...registry, tabs: [{ ...registry.tabs[0], sessionId: 'other-session' }] }),
    ).toBeNull()
    expect(
      parseFirefoxRegistry({
        ...registry,
        tabs: [registry.tabs[0], { ...registry.tabs[0], tabId: 'duplicate-physical' }],
      }),
    ).toBeNull()
  })

  test('Firefox attach-in-place mappings survive same-epoch reconnect without group inference', () => {
    const registry = firefoxFixture()
    const restored = reconcileFirefoxRegistry({
      registry,
      browserEpoch: registry.browserEpoch,
      observedTabs: [
        {
          id: 42,
          windowId: 999,
          active: false,
          incognito: false,
          groupId: 731,
          url: 'https://example.com/changed',
          title: 'Changed',
        },
      ],
    })
    expect(restored.tabs[0]).toMatchObject({ state: 'ready', browserTabId: 42, url: 'https://example.com/changed' })
    expect(restored.groups[0]).not.toHaveProperty('browserGroupId')
    expect(ownedFirefoxTab({ registry: restored, sessionId: 'session-1', tabId: 'firefox-tab' }).tabId).toBe(
      'firefox-tab',
    )
  })

  test('Firefox release tombstones survive reconnect even when the physical tab still exists', () => {
    const released = releaseFirefoxTabs({ registry: firefoxFixture(), tabIds: ['firefox-tab'] })
    const restored = reconcileFirefoxRegistry({
      registry: released,
      browserEpoch: released.browserEpoch,
      observedTabs: [
        { id: 42, windowId: 1, active: true, incognito: false, url: 'https://example.com', title: 'Example' },
      ],
    })
    expect(restored.tabs[0].state).toBe('released')
    expect(activeFirefoxTab({ registry: restored, browserTabId: 42 })).toBeUndefined()
    expect(() => {
      ownedFirefoxTab({ registry: restored, sessionId: 'session-1', tabId: 'firefox-tab' })
    }).toThrow('released')
  })

  test('Firefox browser restart never adopts a reused physical ID', () => {
    const registry = firefoxFixture()
    const restarted = reconcileFirefoxRegistry({
      registry,
      browserEpoch: 'new-firefox-epoch',
      observedTabs: [
        {
          id: 42,
          windowId: 1,
          active: true,
          incognito: false,
          url: registry.tabs[0].url,
          title: registry.tabs[0].title,
        },
      ],
    })
    expect(restarted.tabs[0].state).toBe('needs-rebind')
    expect(restarted.groups[0].state).toBe('needs-rebind')
    expect(activeFirefoxTab({ registry: restarted, browserTabId: 42 })).toBeUndefined()
    expect(() => {
      ownedFirefoxTab({ registry: restarted, sessionId: 'session-1', tabId: 'firefox-tab' })
    }).toThrow('restarted')
  })

  test('Firefox background suspension keeps ownership while a lost session epoch still rebinds', () => {
    const registry = firefoxFixture()
    const observedTabs = [
      {
        id: 42,
        windowId: 1,
        active: false,
        incognito: false,
        url: 'https://example.com',
        title: 'Example',
      },
    ]
    const woken = reconcileFirefoxRegistry({
      registry,
      browserEpoch: registry.browserEpoch,
      observedTabs,
    })
    expect(woken.browserEpoch).toBe(registry.browserEpoch)
    expect(woken.tabs[0]).toMatchObject({
      state: 'ready',
      browserTabId: 42,
      browserEpoch: registry.browserEpoch,
    })
    expect(woken.groups[0].state).toBe('ready')
    expect(
      ownedFirefoxTab({
        registry: woken,
        sessionId: 'session-1',
        tabId: 'firefox-tab',
        browserEpoch: woken.browserEpoch,
      }).tabId,
    ).toBe('firefox-tab')
    const restarted = reconcileFirefoxRegistry({
      registry: woken,
      browserEpoch: 'firefox-epoch-after-restart',
      observedTabs,
    })
    expect(restarted.tabs[0].state).toBe('needs-rebind')
    expect(restarted.groups[0].state).toBe('needs-rebind')
    expect(() => {
      ownedFirefoxTab({ registry: restarted, sessionId: 'session-1', tabId: 'firefox-tab' })
    }).toThrow('restarted')
  })

  test('Firefox session and execution epoch are checked independently', () => {
    const registry = firefoxFixture()
    expect(() => {
      ownedFirefoxTab({ registry, sessionId: 'session-2', tabId: 'firefox-tab' })
    }).toThrow('another Pi session')
    expect(() => {
      ownedFirefoxTab({ registry, sessionId: 'session-1', tabId: 'firefox-tab', browserEpoch: 'stale-epoch' })
    }).toThrow('earlier Firefox run')
    const released = releaseFirefoxTabs({ registry, tabIds: [], groupIds: ['firefox-group'] })
    expect(() => {
      ownedFirefoxTab({ registry: released, sessionId: 'session-1', tabId: 'firefox-tab' })
    }).toThrow('owning group')
  })

  test('Firefox empty task groups discard stale native bindings before another create', () => {
    const registry = firefoxFixture()
    registry.groups[0] = { ...registry.groups[0], origin: 'task', browserGroupId: 17, windowId: 3 }
    const released = releaseFirefoxTabs({ registry, tabIds: ['firefox-tab'] })
    expect(released.groups[0].state).toBe('ready')
    expect(released.groups[0]).not.toHaveProperty('browserGroupId')
    expect(released.groups[0]).not.toHaveProperty('windowId')
  })

  test('Firefox task tabs moved out of a native group become tombstones', () => {
    const registry = firefoxFixture()
    registry.groups[0] = { ...registry.groups[0], origin: 'task', browserGroupId: 17 }
    const restored = reconcileFirefoxRegistry({
      registry,
      browserEpoch: registry.browserEpoch,
      observedTabs: [
        {
          id: 42,
          windowId: 1,
          groupId: 18,
          active: false,
          incognito: false,
          url: 'https://example.com',
          title: 'Example',
        },
      ],
    })
    expect(restored.tabs[0].state).toBe('released')
    expect(restored.groups[0]).not.toHaveProperty('browserGroupId')
  })

  test('Firefox browser request parser rejects missing identity, unknown fields and invalid ranges', () => {
    const request = {
      requestId: 'request',
      sessionId: 'session',
      operation: { kind: 'page.fill', tabId: 'tab', selector: '#name', value: '' },
    }
    expect(parseFirefoxBrowserRequest(request)).toEqual(request)
    expect(parseFirefoxBrowserRequest({ ...request, operation: { ...request.operation, force: true } })).toBeNull()
    expect(
      parseFirefoxBrowserRequest({ ...request, operation: { kind: 'page.fill', selector: '#name', value: '' } }),
    ).toBeNull()
    expect(
      parseFirefoxBrowserRequest({ ...request, operation: { kind: 'page.logs', tabId: 'tab', limit: 0 } }),
    ).toBeNull()
    expect(
      parseFirefoxBrowserRequest({
        ...request,
        operation: { kind: 'page.network', tabId: 'tab', action: 'dump-all-tabs' },
      }),
    ).toBeNull()
    expect(parseFirefoxBrowserRequest({ ...request, timeoutMs: Infinity })).toBeNull()
    expect(parseFirefoxBrowserRequest({ ...request, browserEpoch: 'spoofed' })).toBeNull()
  })

  test('Firefox dedup fingerprints bind operation and tab while ignoring object property order', () => {
    const request = {
      requestId: 'request',
      sessionId: 'session',
      operation: { kind: 'tabs.create' as const, groupId: 'group', url: 'https://example.com' },
    }
    expect(firefoxRequestFingerprint(request)).toBe(
      firefoxRequestFingerprint({
        ...request,
        operation: { url: 'https://example.com', groupId: 'group', kind: 'tabs.create' },
      }),
    )
    expect(firefoxRequestFingerprint(request)).not.toBe(
      firefoxRequestFingerprint({ ...request, operation: { ...request.operation, groupId: 'other' } }),
    )
    expect(
      firefoxRequestFingerprint({
        sessionId: 'session',
        tabId: 'tab-a',
        browserEpoch: 'epoch',
        command: { method: 'page', action: 'title' },
      }),
    ).not.toBe(
      firefoxRequestFingerprint({
        sessionId: 'session',
        tabId: 'tab-b',
        browserEpoch: 'epoch',
        command: { method: 'page', action: 'title' },
      }),
    )
  })

  test('Firefox rejects privileged URLs before page execution', () => {
    for (const url of [
      'about:config',
      'file:///etc/passwd',
      'moz-extension://other/popup.html',
      'https://addons.mozilla.org/',
      'javascript:alert(1)',
    ])
      expect(firefoxPageSupported(url)).toBe(false)
    expect(firefoxPageSupported('https://example.com/')).toBe(true)
    expect(firefoxPageSupported('http://127.0.0.1:12345/fixture')).toBe(true)
  })

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

  test('page info refresh keeps ownership and cannot resurrect a released tab', () => {
    let registry = createRegistryWithGroup()
    registry = setTabPageInfo(registry, {
      tabId: 'pt-1',
      url: 'https://example.com/invoice',
      title: 'Invoice',
    })
    const refreshedInventory = buildInventory(registry)
    const refreshedTab = findTab(registry, 'pt-1')
    const refreshedInventoryTab = refreshedInventory.tabs.find((tab) => {
      return tab.tabId === 'pt-1'
    })

    expect({
      refreshed: {
        url: refreshedTab?.url,
        title: refreshedTab?.title,
        state: refreshedTab?.state,
        sessionId: refreshedTab?.sessionId,
        groupId: refreshedTab?.groupId,
        targetId: refreshedTab?.targetId,
        cdpSessionId: refreshedTab?.cdpSessionId,
      },
      inventory: {
        url: refreshedInventoryTab?.url,
        revision: refreshedInventory.revision,
        registryRevision: registry.revision,
      },
    }).toEqual({
      refreshed: {
        url: 'https://example.com/invoice',
        title: 'Invoice',
        state: 'ready',
        sessionId: 'session-1',
        groupId: 'pg-1',
        targetId: 'target-1',
        cdpSessionId: 'pw-tab-1',
      },
      inventory: {
        url: 'https://example.com/invoice',
        revision: registry.revision,
        registryRevision: registry.revision,
      },
    })

    // A late onUpdated event for a released tab must not revive it.
    const released = releaseTab(registry, 'pt-1')
    const afterRelease = setTabPageInfo(released, {
      tabId: 'pt-1',
      url: 'https://example.com/late',
      title: 'Late title',
    })
    expect(afterRelease).toBe(released)
    expect(findTab(afterRelease, 'pt-1')).toMatchObject({
      url: 'https://example.com/invoice',
      title: 'Invoice',
      state: 'released',
      sessionId: 'session-1',
    })
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

  test('a tab attached in place survives reconcile and keeps its origin and source', () => {
    // An in-place group has no Chrome group binding on purpose: it must not be
    // released for "not being in a task group", which is what a task tab would
    // get for the same observed state.
    let registry = createEmptyRegistry({ profileId, browserEpoch: epoch })
    registry = addGroup(registry, {
      groupId: 'pg-1',
      sessionId: 'session-1',
      name: 'Invoice draft',
      browserEpoch: epoch,
      origin: 'existing',
    })
    registry = addTab(registry, {
      tabId: 'pt-1',
      groupId: 'pg-1',
      sessionId: 'session-1',
      chromeTabId: 101,
      url: 'https://billing.example.com/draft',
      title: 'Invoice draft',
      browserEpoch: epoch,
      origin: 'existing',
    })
    registry = setTabAttachment(registry, { tabId: 'pt-1', targetId: 'target-1', cdpSessionId: 'pw-tab-1' })
    registry = addTab(registry, {
      tabId: 'pt-2',
      groupId: 'pg-1',
      sessionId: 'session-1',
      chromeTabId: 102,
      url: 'https://example.com/ref',
      title: 'Reference',
      browserEpoch: epoch,
      origin: 'existing',
      sourceTabId: 'pt-1',
    })

    const result = reconcileRegistry(registry, {
      browserEpoch: epoch,
      observedTabs: [
        observedTab({ chromeTabId: 101, chromeGroupId: -1 }),
        observedTab({ chromeTabId: 102, chromeGroupId: -1 }),
      ],
      observedChromeGroupIds: [],
    })

    expect({
      groupOrigin: findGroup(result.registry, 'pg-1')?.origin,
      groupChromeGroupId: findGroup(result.registry, 'pg-1')?.chromeGroupId,
      tabs: result.registry.tabs.map((tab) => {
        return { tabId: tab.tabId, state: tab.state, origin: tab.origin, sourceTabId: tab.sourceTabId }
      }),
      reattach: result.reattachTabIds,
    }).toMatchInlineSnapshot(`
      {
        "groupChromeGroupId": undefined,
        "groupOrigin": "existing",
        "reattach": [
          101,
          102,
        ],
        "tabs": [
          {
            "origin": "existing",
            "sourceTabId": undefined,
            "state": "disconnected",
            "tabId": "pt-1",
          },
          {
            "origin": "existing",
            "sourceTabId": "pt-1",
            "state": "disconnected",
            "tabId": "pt-2",
          },
        ],
      }
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

function discoveryTab(options: { windowId: number; index: number; active?: boolean }): DiscoverySortableTab {
  return { windowId: options.windowId, index: options.index, active: options.active ?? false }
}

function summarizeDiscoveryTabs(tabs: DiscoverySortableTab[]): string[] {
  return tabs.map((candidate) => {
    return `${candidate.windowId}/${candidate.index}${candidate.active ? ' active' : ''}`
  })
}

function orderDiscoveryTabs(options: {
  tabs: DiscoverySortableTab[]
  focusedWindowIds: number[]
}): DiscoverySortableTab[] {
  const focused = new Set(options.focusedWindowIds)
  return [...options.tabs].sort((a, b) => {
    return compareDiscoveredTabs({ a, b, focusedWindowIds: focused })
  })
}

describe('tabs.discover ordering', () => {
  test('active tabs of every window lead and the focused window only orders ties', () => {
    const tabs: DiscoverySortableTab[] = [
      discoveryTab({ windowId: 7, index: 0 }),
      discoveryTab({ windowId: 9, index: 0 }),
      discoveryTab({ windowId: 9, index: 2, active: true }),
      discoveryTab({ windowId: 7, index: 3, active: true }),
      discoveryTab({ windowId: 9, index: 1 }),
      discoveryTab({ windowId: 7, index: 1 }),
    ]

    expect(summarizeDiscoveryTabs(orderDiscoveryTabs({ tabs, focusedWindowIds: [7] }))).toEqual([
      '7/3 active',
      '9/2 active',
      '7/0',
      '7/1',
      '9/0',
      '9/1',
    ])
  })

  test('each window keeps its own active tab when no window has OS focus', () => {
    const tabs: DiscoverySortableTab[] = [
      discoveryTab({ windowId: 5, index: 0 }),
      discoveryTab({ windowId: 2, index: 0, active: true }),
      discoveryTab({ windowId: 5, index: 2, active: true }),
      discoveryTab({ windowId: 5, index: 1 }),
      discoveryTab({ windowId: 2, index: 1 }),
    ]

    expect(summarizeDiscoveryTabs(orderDiscoveryTabs({ tabs, focusedWindowIds: [] }))).toEqual([
      '2/0 active',
      '5/2 active',
      '2/1',
      '5/0',
      '5/1',
    ])
  })

  test('the focused window leads inactive tabs but never outranks another active tab', () => {
    const tabs: DiscoverySortableTab[] = [
      discoveryTab({ windowId: 3, index: 0, active: true }),
      discoveryTab({ windowId: 8, index: 0, active: true }),
      discoveryTab({ windowId: 3, index: 1 }),
      discoveryTab({ windowId: 8, index: 1 }),
    ]

    expect(summarizeDiscoveryTabs(orderDiscoveryTabs({ tabs, focusedWindowIds: [8] }))).toEqual([
      '8/0 active',
      '3/0 active',
      '8/1',
      '3/1',
    ])
  })

  test('the listing is deterministic and does not depend on input enumeration order', () => {
    const tabs: DiscoverySortableTab[] = [
      discoveryTab({ windowId: 4, index: 1 }),
      discoveryTab({ windowId: 4, index: 0, active: true }),
      discoveryTab({ windowId: 1, index: 2 }),
      discoveryTab({ windowId: 1, index: 0 }),
    ]
    const reversed: DiscoverySortableTab[] = [...tabs].reverse()

    const first = orderDiscoveryTabs({ tabs, focusedWindowIds: [1] })
    const second = orderDiscoveryTabs({ tabs: reversed, focusedWindowIds: [1] })
    expect(summarizeDiscoveryTabs(first)).toEqual(['4/0 active', '1/0', '1/2', '4/1'])
    expect(summarizeDiscoveryTabs(second)).toEqual(summarizeDiscoveryTabs(first))
  })
})

describe('CoalescedPublisher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a burst flushes once and later updates do not push the deadline forward', () => {
    vi.useFakeTimers()
    let flushes = 0
    const publisher = new CoalescedPublisher({
      delayMs: 250,
      flush: () => {
        flushes += 1
      },
    })

    publisher.schedule()
    vi.advanceTimersByTime(100)
    publisher.schedule()
    vi.advanceTimersByTime(100)
    publisher.schedule()
    expect(flushes).toBe(0)

    vi.advanceTimersByTime(50)
    expect(flushes).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(flushes).toBe(1)
  })

  test('continuous updates flush on a bounded interval instead of starving', () => {
    vi.useFakeTimers()
    let flushes = 0
    const publisher = new CoalescedPublisher({
      delayMs: 250,
      flush: () => {
        flushes += 1
      },
    })

    // 1000ms of updates every 10ms: a sliding debounce would never fire.
    for (let i = 0; i < 100; i += 1) {
      publisher.schedule()
      vi.advanceTimersByTime(10)
    }
    expect(flushes).toBe(4)

    publisher.schedule()
    vi.advanceTimersByTime(250)
    expect(flushes).toBe(5)
  })
})
