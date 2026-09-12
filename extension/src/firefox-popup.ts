import { getFirefoxApi } from './firefox-api.js'

const api = getFirefoxApi()
const enableButton = document.getElementById('enable-javascript')
const javascriptStatus = document.getElementById('javascript-status')
const releaseButton = document.getElementById('release-tab')
const releaseStatus = document.getElementById('release-status')

if (
  !(enableButton instanceof HTMLButtonElement) ||
  !(releaseButton instanceof HTMLButtonElement) ||
  !javascriptStatus ||
  !releaseStatus
) {
  throw new Error('Firefox popup controls are missing')
}

const refreshPermission = async (): Promise<void> => {
  const info = await api.runtime.getBrowserInfo()
  const supportedVersion = Number.parseInt(info.version, 10) >= 153
  if (!supportedVersion) {
    enableButton.disabled = true
    javascriptStatus.textContent = '此版本不支持页面 JavaScript 执行。更新至 Firefox 153+ 后可启用。'
    return
  }
  const granted = await api.permissions.contains({ permissions: ['userScripts'] })
  if (granted && typeof api.userScripts?.execute !== 'function') {
    enableButton.disabled = true
    javascriptStatus.textContent = '已获得权限，但此浏览器尚未提供页面 JavaScript 执行接口。其它工具可继续使用。'
    return
  }
  enableButton.disabled = granted
  enableButton.textContent = granted ? '页面 JavaScript 已启用' : '启用页面 JavaScript'
  javascriptStatus.textContent = granted
    ? '已启用；在 Pi 中重新读取浏览器列表即可查看能力。'
    : '可选功能。点击后由 Firefox 请求你的授权。'
}

enableButton.addEventListener('click', async () => {
  try {
    const permission = api.permissions.request({ permissions: ['userScripts'] })
    enableButton.disabled = true
    const granted = await permission
    await refreshPermission()
    if (!granted) {
      javascriptStatus.textContent = '尚未启用；其它页面工具可继续使用。'
    }
  } catch (error) {
    enableButton.disabled = false
    javascriptStatus.textContent = error instanceof Error ? error.message : String(error)
  }
})

releaseButton.addEventListener('click', async () => {
  releaseButton.disabled = true
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true })
    const [activeTab] = tabs
    if (tabs.length !== 1 || !activeTab || activeTab.id === undefined) {
      releaseStatus.textContent = '无法确定当前标签，请回到需要释放的页面再试。'
      return
    }
    const response: unknown = await api.runtime.sendMessage({ type: 'piFirefoxReleaseTab', browserTabId: activeTab.id })
    if (typeof response !== 'object' || response === null || !('ok' in response)) {
      throw new Error('扩展未返回标签释放结果。')
    }
    if (response.ok !== true) {
      const message = 'error' in response && typeof response.error === 'string' ? response.error : '标签释放失败。'
      throw new Error(message)
    }
    releaseStatus.textContent = 'released' in response && response.released === true
      ? '已释放当前标签，页面保持打开。'
      : '当前标签未被 Pi 接管。'
  } catch (error) {
    releaseStatus.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    releaseButton.disabled = false
  }
})

void refreshPermission().catch((error: unknown) => {
  javascriptStatus.textContent = error instanceof Error ? error.message : String(error)
})
