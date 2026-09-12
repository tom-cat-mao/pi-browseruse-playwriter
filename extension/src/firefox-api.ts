/** The Firefox WebExtension APIs used by the ordinary-extension backend. */
export interface FirefoxEvent<Listener> {
  addListener(listener: Listener): void
  removeListener(listener: Listener): void
}

export interface FirefoxTab {
  id?: number
  windowId: number
  active: boolean
  url?: string
  title?: string
  openerTabId?: number
  groupId?: number
  status?: string
  discarded?: boolean
  incognito: boolean
}

export interface FirefoxWindow {
  id?: number
  focused: boolean
  type?: string
}

export interface FirefoxStorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(values: Record<string, unknown>): Promise<void>
}

export interface FirefoxWebRequestDetails {
  requestId: string
  tabId: number
  url: string
  method: string
  type: string
  timeStamp: number
  statusCode?: number
  statusLine?: string
  error?: string
  requestBody?: { formData?: Record<string, string[]>; raw?: { bytes?: ArrayBuffer; file?: string }[]; error?: string }
  responseHeaders?: { name: string; value?: string; binaryValue?: number[] }[]
}

export interface FirefoxWebRequestEvent {
  addListener(
    listener: (details: FirefoxWebRequestDetails) => void,
    filter: { urls: string[] },
    extraInfoSpec?: string[],
  ): void
}

export interface FirefoxResponseFilter {
  ondata: ((event: { data: ArrayBuffer }) => void) | null
  onstop: (() => void) | null
  onerror: (() => void) | null
  write(data: ArrayBuffer): void
  close(): void
  disconnect(): void
}

export interface FirefoxApi {
  runtime: {
    id: string
    getManifest(): { version: string }
    getURL(path: string): string
    getFrameId(target: Element | Window): number
    sendMessage(message: unknown): Promise<unknown>
    getBrowserInfo(): Promise<{ name: string; version: string; vendor: string; buildID: string }>
    onMessage: FirefoxEvent<
      (
        message: unknown,
        sender: { tab?: FirefoxTab; frameId?: number; url?: string; id?: string },
      ) => void | Promise<unknown>
    >
    onStartup: FirefoxEvent<() => void>
  }
  storage: { local: FirefoxStorageArea; session: FirefoxStorageArea }
  tabs: {
    query(query: { windowId?: number; active?: boolean; currentWindow?: boolean }): Promise<FirefoxTab[]>
    get(tabId: number): Promise<FirefoxTab>
    create(properties: { url: string; active?: boolean; windowId?: number; openerTabId?: number }): Promise<FirefoxTab>
    update(tabId: number, properties: { url?: string; active?: boolean }): Promise<FirefoxTab>
    remove(tabIds: number | number[]): Promise<void>
    goBack(tabId: number): Promise<void>
    captureTab(
      tabId: number,
      options: { format: 'png'; rect?: { x: number; y: number; width: number; height: number }; scale?: number },
    ): Promise<string>
    group?: (options: { groupId?: number; tabIds: number[] }) => Promise<number>
    onCreated: FirefoxEvent<(tab: FirefoxTab) => void>
    onUpdated: FirefoxEvent<
      (
        tabId: number,
        change: { url?: string; title?: string; status?: string; groupId?: number },
        tab: FirefoxTab,
      ) => void
    >
    onRemoved: FirefoxEvent<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void>
  }
  tabGroups?: {
    update(groupId: number, properties: { title: string }): Promise<{ id: number }>
  }
  windows: {
    get(windowId: number): Promise<FirefoxWindow>
    getAll(): Promise<FirefoxWindow[]>
    update(windowId: number, properties: { focused: boolean }): Promise<FirefoxWindow>
  }
  action: {
    onClicked: FirefoxEvent<(tab: FirefoxTab) => void>
    setBadgeText(details: { text: string; tabId?: number }): Promise<void>
    setTitle(details: { title: string; tabId?: number }): Promise<void>
  }
  webNavigation: {
    getFrame(details: {
      tabId: number
      frameId: number
    }): Promise<{ url: string; parentFrameId: number; errorOccurred: boolean; documentId?: string } | null>
  }
  permissions: {
    contains(permissions: { permissions: string[] }): Promise<boolean>
    request(permissions: { permissions: string[] }): Promise<boolean>
    onAdded: FirefoxEvent<(permissions: { permissions?: string[] }) => void>
    onRemoved: FirefoxEvent<(permissions: { permissions?: string[] }) => void>
  }
  scripting: {
    executeScript<Result, Args extends unknown[]>(details: {
      target: { tabId: number; frameIds?: number[]; allFrames?: boolean }
      files?: string[]
      func?: (...args: Args) => Result
      args?: Args
      injectImmediately?: boolean
    }): Promise<{ frameId: number; result?: Awaited<Result>; error?: { message: string } }[]>
  }
  userScripts?: {
    execute(options: {
      target: { tabId: number; frameIds?: number[]; allFrames?: boolean }
      injectImmediately?: boolean
      world: 'USER_SCRIPT'
      worldId: string
      js: ({ file: string } | { code: string })[]
    }): Promise<{ frameId: number; result?: unknown; error?: string }[]>
  }
  webRequest: {
    onBeforeRequest: FirefoxWebRequestEvent
    onHeadersReceived: FirefoxWebRequestEvent
    onCompleted: FirefoxWebRequestEvent
    onErrorOccurred: FirefoxWebRequestEvent
    filterResponseData?: (requestId: string) => FirefoxResponseFilter
  }
}

declare const browser: FirefoxApi

export function getFirefoxApi(): FirefoxApi {
  return browser
}
