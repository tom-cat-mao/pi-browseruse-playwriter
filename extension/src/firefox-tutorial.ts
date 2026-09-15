const copyResetDelayMs = 2400

type CopyControl = {
  button: HTMLButtonElement
  status: HTMLSpanElement
  resetTimerId: number | undefined
}

const writeToClipboard = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text)
}

const copyWithSelection = (text: string): boolean => {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  textarea.setAttribute('tabindex', '-1')
  textarea.className = 'copy-fallback'
  document.body.append(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

const setCopyStatus = ({ control, message, failed }: { control: CopyControl; message: string; failed: boolean }): void => {
  control.status.textContent = message
  control.status.classList.toggle('is-error', failed)
}

const scheduleCopyReset = ({ control }: { control: CopyControl }): void => {
  if (control.resetTimerId !== undefined) {
    window.clearTimeout(control.resetTimerId)
  }
  control.resetTimerId = window.setTimeout(() => {
    control.resetTimerId = undefined
    control.button.textContent = '复制'
    setCopyStatus({ control, message: '', failed: false })
  }, copyResetDelayMs)
}

const copyCode = async ({ control, text }: { control: CopyControl; text: string }): Promise<void> => {
  control.button.disabled = true
  try {
    try {
      await writeToClipboard(text)
    } catch {
      if (!copyWithSelection(text)) {
        throw new Error('浏览器拒绝了剪贴板写入')
      }
    }
    control.button.textContent = '已复制'
    setCopyStatus({ control, message: '已复制到剪贴板。', failed: false })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    control.button.textContent = '复制失败'
    setCopyStatus({ control, message: `复制失败：${detail}。请手动选中上方代码。`, failed: true })
  } finally {
    control.button.disabled = false
    scheduleCopyReset({ control })
  }
}

const enhanceCodeBlocks = (): void => {
  for (const pre of Array.from(document.querySelectorAll<HTMLPreElement>('pre'))) {
    const text = (pre.textContent ?? '').trimEnd()
    if (text === '') {
      continue
    }
    const wrapper = document.createElement('div')
    wrapper.className = 'code-block'
    const toolbar = document.createElement('div')
    toolbar.className = 'code-toolbar'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'copy-button'
    button.textContent = '复制'
    button.setAttribute('aria-label', '复制这段代码')
    const status = document.createElement('span')
    status.className = 'copy-status'
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    toolbar.append(button, status)
    pre.replaceWith(wrapper)
    wrapper.append(toolbar, pre)
    const control: CopyControl = { button, status, resetTimerId: undefined }
    button.addEventListener('click', () => {
      void copyCode({ control, text })
    })
  }
}

enhanceCodeBlocks()
