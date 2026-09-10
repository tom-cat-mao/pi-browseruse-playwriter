import { describe, expect, test } from 'vitest'
import {
  addGroup,
  addTab,
  buildInventory,
  clearGroupChromeBinding,
  clearTabAttachment,
  createEmptyRegistry,
  findGroup,
  findTab,
  isChromeTabTombstoned,
  listSessionGroups,
  listSessionTabs,
  parseRegistry,
  reconcileRegistry,
  releaseTab,
  renameGroup,
  setGroupChromeBinding,
  setTabAttachment,
  setTabPageInfo,
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
      inventoryTabs: buildInventory(result.registry).tabs.length,
      changed: result.changed,
    }).toMatchInlineSnapshot(`
      {
        "changed": false,
        "inventoryTabs": 0,
        "reattach": [],
        "state": "released",
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

  test('persisted registries round-trip and malformed payloads are rejected', () => {
    const registry = createRegistryWithGroup()
    const roundTripped = parseRegistry(JSON.parse(JSON.stringify(registry)))

    expect({
      roundTripped: roundTripped,
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
