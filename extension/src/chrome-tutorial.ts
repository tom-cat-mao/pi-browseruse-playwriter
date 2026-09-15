const COPY_LABEL = '复制'
const COPIED_LABEL = '已复制'
const FAILED_LABEL = '复制失败，请手动选中后按 Ctrl/Cmd+C'
const COPIED_RESET_MS = 1600
const FAILED_RESET_MS = 6000

function selectElementText(element: HTMLElement): boolean {
  const selection = window.getSelection()
  if (!selection) return false
  const range = document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
  return selection.toString().length > 0
}

async function writeClipboard({
  text,
  fallbackElement,
}: {
  text: string
  fallbackElement: HTMLElement
}): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 页面失焦或异步剪贴板被拒绝时走下面的选中方案。
  }
  if (!selectElementText(fallbackElement)) return false
  try {
    return document.execCommand('copy')
  } catch {
    return false
  }
}

function setUpCopyButton({ button, code }: { button: HTMLButtonElement; code: HTMLElement }): void {
  let resetTimer: number | undefined

  button.hidden = false
  button.textContent = COPY_LABEL

  button.addEventListener('click', () => {
    void writeClipboard({ text: code.textContent ?? '', fallbackElement: code }).then((copied) => {
      button.textContent = copied ? COPIED_LABEL : FAILED_LABEL
      button.dataset.state = copied ? 'copied' : 'failed'
      if (resetTimer !== undefined) window.clearTimeout(resetTimer)
      resetTimer = window.setTimeout(
        () => {
          button.textContent = COPY_LABEL
          delete button.dataset.state
        },
        copied ? COPIED_RESET_MS : FAILED_RESET_MS,
      )
    })
  })
}

function initCopyButtons(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.copy-button[data-copy-target]')
  buttons.forEach((button) => {
    const targetId = button.dataset.copyTarget
    if (!targetId) return
    const code = document.getElementById(targetId)
    if (!code) return
    setUpCopyButton({ button, code })
  })
}

initCopyButtons()
