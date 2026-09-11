import { describe, expect, it } from 'vitest'
import type { Protocol } from 'devtools-protocol'
import {
  buildRawSnapshotTree,
  buildDomIndex,
  buildSnapshotLines,
  describeScopeCapture,
  describeScopeResolution,
  filterFullSnapshotTree,
  filterInteractiveSnapshotTree,
  finalizeSnapshotOutput,
  type SnapshotNode,
} from './aria-snapshot.js'

const roleValue = (value: string): Protocol.Accessibility.AXValue => {
  return { type: 'role', value }
}

const nameValue = (value: string): Protocol.Accessibility.AXValue => {
  return { type: 'string', value }
}

type DomInfoEntry = {
  nodeId: Protocol.DOM.NodeId
  parentId?: Protocol.DOM.NodeId
  backendNodeId: Protocol.DOM.BackendNodeId
  nodeName: string
  attributes: Map<string, string>
}

function domNode({
  nodeId,
  parentId,
  backendNodeId,
  nodeType,
  nodeName,
  attributes,
  shadowRootType,
}: {
  nodeId: number
  parentId?: number
  backendNodeId: number
  nodeType: number
  nodeName: string
  attributes?: string[]
  shadowRootType?: Protocol.DOM.ShadowRootType
}): Protocol.DOM.Node {
  return {
    nodeId: nodeId as Protocol.DOM.NodeId,
    ...(parentId === undefined ? {} : { parentId: parentId as Protocol.DOM.NodeId }),
    backendNodeId: backendNodeId as Protocol.DOM.BackendNodeId,
    nodeType,
    nodeName,
    localName: nodeType === 1 ? nodeName.toLowerCase() : '',
    nodeValue: '',
    ...(attributes ? { attributes } : {}),
    ...(shadowRootType ? { shadowRootType } : {}),
  }
}

describe('aria-snapshot tree filters', () => {
  it('builds a raw snapshot tree with scope pruning', () => {
    const rootId = '1' as Protocol.Accessibility.AXNodeId
    const mainId = '2' as Protocol.Accessibility.AXNodeId
    const navId = '3' as Protocol.Accessibility.AXNodeId
    const listId = '4' as Protocol.Accessibility.AXNodeId
    const listItemId = '5' as Protocol.Accessibility.AXNodeId
    const linkId = '6' as Protocol.Accessibility.AXNodeId
    const headingId = '7' as Protocol.Accessibility.AXNodeId
    const buttonId = '8' as Protocol.Accessibility.AXNodeId

    const axById = new Map<Protocol.Accessibility.AXNodeId, Protocol.Accessibility.AXNode>([
      [
        rootId,
        {
          nodeId: rootId,
          ignored: false,
          role: roleValue('rootwebarea'),
          childIds: [mainId, navId],
        },
      ],
      [
        mainId,
        {
          nodeId: mainId,
          ignored: false,
          role: roleValue('main'),
          childIds: [headingId, buttonId],
          backendDOMNodeId: 200 as Protocol.DOM.BackendNodeId,
        },
      ],
      [
        navId,
        {
          nodeId: navId,
          ignored: false,
          role: roleValue('navigation'),
          childIds: [listId],
          backendDOMNodeId: 201 as Protocol.DOM.BackendNodeId,
        },
      ],
      [
        listId,
        {
          nodeId: listId,
          ignored: false,
          role: roleValue('list'),
          childIds: [listItemId],
          backendDOMNodeId: 202 as Protocol.DOM.BackendNodeId,
        },
      ],
      [
        listItemId,
        {
          nodeId: listItemId,
          ignored: false,
          role: roleValue('listitem'),
          childIds: [linkId],
          backendDOMNodeId: 203 as Protocol.DOM.BackendNodeId,
        },
      ],
      [
        linkId,
        {
          nodeId: linkId,
          ignored: false,
          role: roleValue('link'),
          name: nameValue('Docs'),
          backendDOMNodeId: 204 as Protocol.DOM.BackendNodeId,
        },
      ],
      [
        headingId,
        {
          nodeId: headingId,
          ignored: false,
          role: roleValue('heading'),
          name: nameValue('Title'),
          backendDOMNodeId: 205 as Protocol.DOM.BackendNodeId,
        },
      ],
      [
        buttonId,
        {
          nodeId: buttonId,
          ignored: false,
          role: roleValue('button'),
          name: nameValue('Submit'),
          backendDOMNodeId: 206 as Protocol.DOM.BackendNodeId,
        },
      ],
    ])

    const allowed = new Set<Protocol.DOM.BackendNodeId>([204 as Protocol.DOM.BackendNodeId])
    const isNodeInScope = (node: Protocol.Accessibility.AXNode): boolean => {
      return Boolean(node.backendDOMNodeId && allowed.has(node.backendDOMNodeId))
    }

    const rawTree = buildRawSnapshotTree({ nodeId: rootId, axById, isNodeInScope })
    expect(rawTree).toMatchInlineSnapshot(`
      {
        "backendNodeId": undefined,
        "children": [
          {
            "backendNodeId": 201,
            "children": [
              {
                "backendNodeId": 202,
                "children": [
                  {
                    "backendNodeId": 203,
                    "children": [
                      {
                        "backendNodeId": 204,
                        "children": [],
                        "ignored": false,
                        "name": "Docs",
                        "role": "link",
                      },
                    ],
                    "ignored": false,
                    "name": "",
                    "role": "listitem",
                  },
                ],
                "ignored": false,
                "name": "",
                "role": "list",
              },
            ],
            "ignored": false,
            "name": "",
            "role": "navigation",
          },
        ],
        "ignored": false,
        "name": "",
        "role": "rootwebarea",
      }
    `)
  })

  it('filters interactive-only trees with labels and wrapper hoisting', () => {
    const rawTree: SnapshotNode = {
      role: 'main',
      name: '',
      ignored: false,
      children: [
        {
          role: 'navigation',
          name: '',
          ignored: false,
          children: [{ role: 'link', name: 'Home', backendNodeId: 2 as Protocol.DOM.BackendNodeId, children: [] }],
        },
        {
          role: 'labeltext',
          name: '',
          ignored: false,
          children: [{ role: 'statictext', name: 'Email', ignored: false, children: [] }],
        },
        {
          role: 'generic',
          name: '',
          ignored: false,
          children: [{ role: 'button', name: 'Save', backendNodeId: 1 as Protocol.DOM.BackendNodeId, children: [] }],
        },
        {
          role: 'generic',
          name: 'Wrapper',
          ignored: false,
          children: [
            { role: 'statictext', name: 'Wrapper', ignored: false, children: [] },
            { role: 'statictext', name: 'Hint', ignored: false, children: [] },
          ],
        },
        {
          role: 'generic',
          name: '',
          ignored: true,
          children: [
            { role: 'button', name: 'Ignored Action', backendNodeId: 3 as Protocol.DOM.BackendNodeId, children: [] },
          ],
        },
        { role: 'heading', name: 'Settings', ignored: false, children: [] },
      ],
    }

    const domByBackendId = new Map<
      Protocol.DOM.BackendNodeId,
      {
        nodeId: Protocol.DOM.NodeId
        parentId?: Protocol.DOM.NodeId
        backendNodeId: Protocol.DOM.BackendNodeId
        nodeName: string
        attributes: Map<string, string>
      }
    >([
      [
        1 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 10 as Protocol.DOM.NodeId,
          backendNodeId: 1 as Protocol.DOM.BackendNodeId,
          nodeName: 'BUTTON',
          attributes: new Map([['id', 'save-btn']]),
        },
      ],
      [
        2 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 11 as Protocol.DOM.NodeId,
          backendNodeId: 2 as Protocol.DOM.BackendNodeId,
          nodeName: 'A',
          attributes: new Map([['data-testid', 'nav-home']]),
        },
      ],
      [
        3 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 12 as Protocol.DOM.NodeId,
          backendNodeId: 3 as Protocol.DOM.BackendNodeId,
          nodeName: 'BUTTON',
          attributes: new Map([['id', 'ignored-action']]),
        },
      ],
    ])

    let refCounter = 0
    const createRefForNode = (options: {
      backendNodeId?: Protocol.DOM.BackendNodeId
      role: string
      name: string
    }): string => {
      refCounter += 1
      return `${options.role}-${options.name}-${refCounter}`
    }

    const filtered = filterInteractiveSnapshotTree({
      node: rawTree,
      ancestorNames: [],
      labelContext: false,
      domByBackendId,
      createRefForNode,
    })

    expect(filtered).toMatchInlineSnapshot(`
      {
        "names": Set {
          "Home",
          "Email",
          "Save",
          "Ignored Action",
        },
        "nodes": [
          {
            "backendNodeId": undefined,
            "baseLocator": undefined,
            "children": [
              {
                "backendNodeId": undefined,
                "baseLocator": undefined,
                "children": [
                  {
                    "backendNodeId": 2,
                    "baseLocator": "[data-testid="nav-home"]",
                    "children": [],
                    "name": "Home",
                    "ref": "link-Home-1",
                    "role": "link",
                  },
                ],
                "name": "",
                "ref": undefined,
                "role": "navigation",
              },
              {
                "backendNodeId": undefined,
                "baseLocator": undefined,
                "children": [
                  {
                    "children": [],
                    "name": "Email",
                    "role": "text",
                  },
                ],
                "name": "",
                "ref": undefined,
                "role": "labeltext",
              },
              {
                "backendNodeId": 1,
                "baseLocator": "[id="save-btn"]",
                "children": [],
                "name": "Save",
                "ref": "button-Save-2",
                "role": "button",
              },
              {
                "backendNodeId": 3,
                "baseLocator": "[id="ignored-action"]",
                "children": [],
                "indentOffset": 1,
                "name": "Ignored Action",
                "ref": "button-Ignored Action-3",
                "role": "button",
              },
            ],
            "name": "",
            "ref": undefined,
            "role": "main",
          },
        ],
      }
    `)
  })

  it('generates locator output for full snapshot trees', () => {
    const rawTree: SnapshotNode = {
      role: 'form',
      name: 'Account',
      ignored: false,
      children: [
        { role: 'textbox', name: 'Email', backendNodeId: 2 as Protocol.DOM.BackendNodeId, children: [] },
        {
          role: 'group',
          name: '',
          ignored: false,
          children: [
            { role: 'button', name: 'Save', backendNodeId: 3 as Protocol.DOM.BackendNodeId, children: [] },
            { role: 'button', name: 'Save', backendNodeId: 4 as Protocol.DOM.BackendNodeId, children: [] },
          ],
        },
      ],
    }

    const domByBackendId = new Map<
      Protocol.DOM.BackendNodeId,
      {
        nodeId: Protocol.DOM.NodeId
        parentId?: Protocol.DOM.NodeId
        backendNodeId: Protocol.DOM.BackendNodeId
        nodeName: string
        attributes: Map<string, string>
      }
    >([
      [
        2 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 20 as Protocol.DOM.NodeId,
          backendNodeId: 2 as Protocol.DOM.BackendNodeId,
          nodeName: 'INPUT',
          attributes: new Map([['data-testid', 'email-input']]),
        },
      ],
      [
        3 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 21 as Protocol.DOM.NodeId,
          backendNodeId: 3 as Protocol.DOM.BackendNodeId,
          nodeName: 'BUTTON',
          attributes: new Map([['id', 'save-primary']]),
        },
      ],
      [
        4 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 22 as Protocol.DOM.NodeId,
          backendNodeId: 4 as Protocol.DOM.BackendNodeId,
          nodeName: 'BUTTON',
          attributes: new Map([['id', 'save-secondary']]),
        },
      ],
    ])

    let refCounter = 0
    const createRefForNode = (): string => {
      refCounter += 1
      return `e${refCounter}`
    }

    const filtered = filterFullSnapshotTree({
      node: rawTree,
      ancestorNames: [],
      domByBackendId,
      createRefForNode,
    })

    const lines = buildSnapshotLines(filtered.nodes)
    const result = finalizeSnapshotOutput(lines, filtered.nodes, new Map())
    expect(result.snapshot).toMatchInlineSnapshot(`
      "- form "Account":
        - textbox "Email" [data-testid="email-input"]
        - button "Save" [id="save-primary"]
        - button "Save" [id="save-secondary"]"
    `)
    expect(result).toMatchInlineSnapshot(`
      {
        "snapshot": "- form "Account":
        - textbox "Email" [data-testid="email-input"]
        - button "Save" [id="save-primary"]
        - button "Save" [id="save-secondary"]",
        "snapshotLines": [
          {
            "shortRef": undefined,
            "text": "- form "Account":",
          },
          {
            "shortRef": "e1",
            "text": "  - textbox "Email" [data-testid="email-input"]",
          },
          {
            "shortRef": "e2",
            "text": "  - button "Save" [id="save-primary"]",
          },
          {
            "shortRef": "e3",
            "text": "  - button "Save" [id="save-secondary"]",
          },
        ],
        "tree": [
          {
            "backendNodeId": undefined,
            "children": [
              {
                "backendNodeId": 2,
                "children": [],
                "locator": "[data-testid="email-input"]",
                "name": "Email",
                "ref": "e1",
                "role": "textbox",
                "shortRef": "e1",
              },
              {
                "backendNodeId": 3,
                "children": [],
                "locator": "[id="save-primary"]",
                "name": "Save",
                "ref": "e2",
                "role": "button",
                "shortRef": "e2",
              },
              {
                "backendNodeId": 4,
                "children": [],
                "locator": "[id="save-secondary"]",
                "name": "Save",
                "ref": "e3",
                "role": "button",
                "shortRef": "e3",
              },
            ],
            "locator": undefined,
            "name": "Account",
            "ref": undefined,
            "role": "form",
            "shortRef": undefined,
          },
        ],
      }
    `)
  })

  it('drops redundant text and preserves named wrappers in full snapshots', () => {
    const rawTree: SnapshotNode = {
      role: 'section',
      name: 'Billing',
      ignored: false,
      children: [
        {
          role: 'generic',
          name: 'Card',
          ignored: false,
          children: [
            { role: 'statictext', name: 'Card', ignored: false, children: [] },
            { role: 'statictext', name: 'Card number', ignored: false, children: [] },
          ],
        },
      ],
    }

    const domByBackendId = new Map<
      Protocol.DOM.BackendNodeId,
      {
        nodeId: Protocol.DOM.NodeId
        parentId?: Protocol.DOM.NodeId
        backendNodeId: Protocol.DOM.BackendNodeId
        nodeName: string
        attributes: Map<string, string>
      }
    >()

    const createRefForNode = (): string | null => {
      return null
    }

    const filtered = filterFullSnapshotTree({
      node: rawTree,
      ancestorNames: [],
      domByBackendId,
      createRefForNode,
    })

    expect(filtered).toMatchInlineSnapshot(`
      {
        "names": Set {
          "Card",
          "Billing",
        },
        "nodes": [
          {
            "backendNodeId": undefined,
            "baseLocator": undefined,
            "children": [
              {
                "backendNodeId": undefined,
                "baseLocator": undefined,
                "children": [],
                "name": "Card",
                "ref": undefined,
                "role": "generic",
              },
            ],
            "name": "Billing",
            "ref": undefined,
            "role": "section",
          },
        ],
      }
    `)
  })

  it('respects refFilter in interactive-only snapshots', () => {
    const rawTree: SnapshotNode = {
      role: 'main',
      name: '',
      ignored: false,
      children: [
        { role: 'button', name: 'Delete', backendNodeId: 5 as Protocol.DOM.BackendNodeId, children: [] },
        { role: 'button', name: 'Save', backendNodeId: 6 as Protocol.DOM.BackendNodeId, children: [] },
      ],
    }

    const domByBackendId = new Map<
      Protocol.DOM.BackendNodeId,
      {
        nodeId: Protocol.DOM.NodeId
        parentId?: Protocol.DOM.NodeId
        backendNodeId: Protocol.DOM.BackendNodeId
        nodeName: string
        attributes: Map<string, string>
      }
    >([
      [
        5 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 30 as Protocol.DOM.NodeId,
          backendNodeId: 5 as Protocol.DOM.BackendNodeId,
          nodeName: 'BUTTON',
          attributes: new Map([['id', 'delete']]),
        },
      ],
      [
        6 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 31 as Protocol.DOM.NodeId,
          backendNodeId: 6 as Protocol.DOM.BackendNodeId,
          nodeName: 'BUTTON',
          attributes: new Map([['id', 'save']]),
        },
      ],
    ])

    let refCounter = 0
    const createRefForNode = (): string => {
      refCounter += 1
      return `e${refCounter}`
    }

    const filtered = filterInteractiveSnapshotTree({
      node: rawTree,
      ancestorNames: [],
      labelContext: false,
      domByBackendId,
      createRefForNode,
      refFilter: ({ name }) => name !== 'Delete',
    })

    expect(filtered).toMatchInlineSnapshot(`
      {
        "names": Set {
          "Save",
        },
        "nodes": [
          {
            "backendNodeId": undefined,
            "baseLocator": undefined,
            "children": [
              {
                "backendNodeId": 6,
                "baseLocator": "[id="save"]",
                "children": [],
                "name": "Save",
                "ref": "e1",
                "role": "button",
              },
            ],
            "name": "",
            "ref": undefined,
            "role": "main",
          },
        ],
      }
    `)
  })

  it('reports a clear error for missing and ambiguous scope selectors', () => {
    expect(describeScopeResolution({ matchCount: 1 })).toEqual({ ok: true })
    expect(describeScopeResolution({ matchCount: 0 })).toEqual({
      ok: false,
      error:
        'snapshot scope selector matched no elements; verify the selector or take a full-page snapshot without a locator',
    })
    expect(describeScopeResolution({ matchCount: 3 })).toEqual({
      ok: false,
      error: 'snapshot scope selector matched 3 elements; pass a selector that resolves to exactly one element',
    })
    expect(describeScopeCapture({ nodeId: null })).toEqual({
      ok: false,
      error: 'snapshot scope element disappeared before the accessibility tree was captured',
    })
    expect(describeScopeCapture({ nodeId: 42 as Protocol.DOM.NodeId })).toEqual({ ok: true, nodeId: 42 })
  })

  it('exposes per-line shortRefs so callers can window refs with the text', () => {
    const rawTree: SnapshotNode = {
      role: 'main',
      name: '',
      ignored: false,
      children: [
        { role: 'button', name: 'Alpha', backendNodeId: 10 as Protocol.DOM.BackendNodeId, children: [] },
        { role: 'button', name: 'Beta', backendNodeId: 11 as Protocol.DOM.BackendNodeId, children: [] },
      ],
    }
    const domByBackendId = new Map<Protocol.DOM.BackendNodeId, DomInfoEntry>([
      [
        10 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 40 as Protocol.DOM.NodeId,
          backendNodeId: 10 as Protocol.DOM.BackendNodeId,
          nodeName: 'BUTTON',
          attributes: new Map([['id', 'alpha']]),
        },
      ],
      [
        11 as Protocol.DOM.BackendNodeId,
        {
          nodeId: 41 as Protocol.DOM.NodeId,
          backendNodeId: 11 as Protocol.DOM.BackendNodeId,
          nodeName: 'BUTTON',
          attributes: new Map([['id', 'beta']]),
        },
      ],
    ])
    let counter = 0
    const filtered = filterInteractiveSnapshotTree({
      node: rawTree,
      ancestorNames: [],
      labelContext: false,
      domByBackendId,
      createRefForNode: () => `alpha-beta-${(counter += 1)}`,
    })
    const lines = buildSnapshotLines(filtered.nodes)
    const shortRefMap = new Map([
      ['alpha-beta-1', 'e1'],
      ['alpha-beta-2', 'e2'],
    ])
    const result = finalizeSnapshotOutput(lines, filtered.nodes, shortRefMap)
    expect(result.snapshotLines).toEqual([
      { text: '- main:', shortRef: undefined },
      { text: '  - button "Alpha" [id="alpha"]', shortRef: 'e1' },
      { text: '  - button "Beta" [id="beta"]', shortRef: 'e2' },
    ])
  })

  it('gives native summaries an exact structural selector, never role=disclosuretriangle', () => {
    const rawTree: SnapshotNode = {
      role: 'main',
      name: '',
      ignored: false,
      children: [
        { role: 'disclosuretriangle', name: 'Details', backendNodeId: 50 as Protocol.DOM.BackendNodeId, children: [] },
      ],
    }
    const { domByBackendId } = buildDomIndex([
      domNode({ nodeId: 1, backendNodeId: 101, nodeType: 9, nodeName: '#document' }),
      domNode({ nodeId: 2, parentId: 1, backendNodeId: 102, nodeType: 1, nodeName: 'HTML' }),
      domNode({ nodeId: 3, parentId: 2, backendNodeId: 103, nodeType: 1, nodeName: 'BODY' }),
      domNode({ nodeId: 4, parentId: 3, backendNodeId: 104, nodeType: 1, nodeName: 'DETAILS' }),
      domNode({ nodeId: 5, parentId: 4, backendNodeId: 50, nodeType: 1, nodeName: 'SUMMARY' }),
    ])
    const filtered = filterInteractiveSnapshotTree({
      node: rawTree,
      ancestorNames: [],
      labelContext: false,
      domByBackendId,
      createRefForNode: () => 'summary-ref',
    })
    const summary = filtered.nodes[0].children[0]
    expect(summary.baseLocator).toBe(
      'html:nth-of-type(1) > body:nth-of-type(1) > details:nth-of-type(1) > summary:nth-of-type(1)',
    )
    expect(summary.baseLocator).not.toContain('disclosuretriangle')
  })

  it('counts hidden summaries through the real DOM rather than AX-visible order', () => {
    const rawTree: SnapshotNode = {
      role: 'main',
      name: '',
      ignored: false,
      children: [
        { role: 'disclosuretriangle', name: 'First', backendNodeId: 70 as Protocol.DOM.BackendNodeId, children: [] },
        { role: 'disclosuretriangle', name: 'Second', backendNodeId: 71 as Protocol.DOM.BackendNodeId, children: [] },
      ],
    }
    const { domByBackendId } = buildDomIndex([
      domNode({ nodeId: 1, backendNodeId: 101, nodeType: 9, nodeName: '#document' }),
      domNode({ nodeId: 2, parentId: 1, backendNodeId: 102, nodeType: 1, nodeName: 'HTML' }),
      domNode({ nodeId: 3, parentId: 2, backendNodeId: 103, nodeType: 1, nodeName: 'BODY' }),
      domNode({ nodeId: 4, parentId: 3, backendNodeId: 104, nodeType: 1, nodeName: 'DETAILS' }),
      domNode({ nodeId: 5, parentId: 4, backendNodeId: 70, nodeType: 1, nodeName: 'SUMMARY' }),
      domNode({ nodeId: 6, parentId: 3, backendNodeId: 106, nodeType: 1, nodeName: 'DETAILS' }),
      domNode({
        nodeId: 7,
        parentId: 6,
        backendNodeId: 107,
        nodeType: 1,
        nodeName: 'SUMMARY',
        attributes: ['hidden', ''],
      }),
      domNode({ nodeId: 8, parentId: 6, backendNodeId: 71, nodeType: 1, nodeName: 'SUMMARY' }),
    ])
    const filtered = filterInteractiveSnapshotTree({
      node: rawTree,
      ancestorNames: [],
      labelContext: false,
      domByBackendId,
      createRefForNode: () => 'ref',
    })
    const [first, second] = filtered.nodes[0].children
    expect(first.baseLocator).toContain('details:nth-of-type(1) > summary:nth-of-type(1)')
    expect(second.baseLocator).toContain('details:nth-of-type(2) > summary:nth-of-type(2)')
  })

  it('builds shadow-scoped selectors and refuses iframe-document selectors', () => {
    const shadow = buildDomIndex([
      domNode({ nodeId: 1, backendNodeId: 201, nodeType: 9, nodeName: '#document' }),
      domNode({ nodeId: 2, parentId: 1, backendNodeId: 202, nodeType: 1, nodeName: 'HTML' }),
      domNode({ nodeId: 3, parentId: 2, backendNodeId: 203, nodeType: 1, nodeName: 'BODY' }),
      domNode({ nodeId: 4, parentId: 3, backendNodeId: 204, nodeType: 1, nodeName: 'DETAILS-PANEL' }),
      domNode({
        nodeId: 5,
        parentId: 4,
        backendNodeId: 205,
        nodeType: 11,
        nodeName: '#document-fragment',
        shadowRootType: 'open',
      }),
      domNode({ nodeId: 6, parentId: 5, backendNodeId: 206, nodeType: 1, nodeName: 'DETAILS' }),
      domNode({ nodeId: 7, parentId: 6, backendNodeId: 207, nodeType: 1, nodeName: 'SUMMARY' }),
    ])
    expect(shadow.domByBackendId.get(207 as Protocol.DOM.BackendNodeId)?.structuralSelector).toBe(
      'html:nth-of-type(1) > body:nth-of-type(1) > details-panel:nth-of-type(1) >> details:nth-of-type(1) > summary:nth-of-type(1)',
    )

    const closedShadow = buildDomIndex([
      domNode({ nodeId: 1, backendNodeId: 211, nodeType: 9, nodeName: '#document' }),
      domNode({ nodeId: 2, parentId: 1, backendNodeId: 212, nodeType: 1, nodeName: 'HTML' }),
      domNode({ nodeId: 3, parentId: 2, backendNodeId: 213, nodeType: 1, nodeName: 'BODY' }),
      domNode({ nodeId: 4, parentId: 3, backendNodeId: 214, nodeType: 1, nodeName: 'DETAILS-PANEL' }),
      domNode({
        nodeId: 5,
        parentId: 4,
        backendNodeId: 215,
        nodeType: 11,
        nodeName: '#document-fragment',
        shadowRootType: 'closed',
      }),
      domNode({ nodeId: 6, parentId: 5, backendNodeId: 216, nodeType: 1, nodeName: 'SUMMARY' }),
    ])
    expect(closedShadow.domByBackendId.get(216 as Protocol.DOM.BackendNodeId)?.structuralSelector).toBeUndefined()

    const iframe = buildDomIndex([
      domNode({ nodeId: 1, backendNodeId: 301, nodeType: 9, nodeName: '#document' }),
      domNode({ nodeId: 2, parentId: 1, backendNodeId: 302, nodeType: 1, nodeName: 'HTML' }),
      domNode({ nodeId: 3, parentId: 2, backendNodeId: 303, nodeType: 1, nodeName: 'BODY' }),
      domNode({ nodeId: 4, parentId: 3, backendNodeId: 304, nodeType: 1, nodeName: 'IFRAME' }),
      domNode({ nodeId: 5, parentId: 4, backendNodeId: 305, nodeType: 9, nodeName: '#document' }),
      domNode({ nodeId: 6, parentId: 5, backendNodeId: 306, nodeType: 1, nodeName: 'HTML' }),
      domNode({ nodeId: 7, parentId: 6, backendNodeId: 307, nodeType: 1, nodeName: 'BODY' }),
      domNode({ nodeId: 8, parentId: 7, backendNodeId: 308, nodeType: 1, nodeName: 'DETAILS' }),
      domNode({ nodeId: 9, parentId: 8, backendNodeId: 309, nodeType: 1, nodeName: 'SUMMARY' }),
    ])
    expect(iframe.domByBackendId.get(309 as Protocol.DOM.BackendNodeId)?.structuralSelector).toBeUndefined()
  })
})
