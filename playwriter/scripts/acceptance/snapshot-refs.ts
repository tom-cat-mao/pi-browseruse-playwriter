/**
 * Pure helpers that read the `refs` array a page.snapshot response carries in
 * its `value` ([{ ref, role, name }]) and resolve the unique ref for a
 * role+name pair. The runtime's ref map is keyed by these short refs
 * (managed-executor-worker.ts: refs.set(entry.shortRef, selector)), and the
 * rendered snapshot text only shows selector strings, so the ref must come
 * from this array — never from parsing the text, CSS attribute values or a
 * position number. Missing or ambiguous refs fail with a clear error instead
 * of falling back.
 */

export type SnapshotRefEntry = { ref: string; role: string; name: string }

export function parseSnapshotRefs({ value }: { value: unknown }): SnapshotRefEntry[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('page.snapshot response value is not an object; cannot read the runtime refs array')
  }
  const refs = (value as { refs?: unknown }).refs
  if (!Array.isArray(refs)) {
    throw new Error('page.snapshot response value has no refs array; the harness needs the runtime ref keys and never derives them from the snapshot text')
  }
  return refs.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`page.snapshot refs[${index}] is not an object`)
    }
    const { ref, role, name } = entry as { ref?: unknown; role?: unknown; name?: unknown }
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new Error(`page.snapshot refs[${index}] has no ref string`)
    }
    if (typeof role !== 'string' || role.length === 0) {
      throw new Error(`page.snapshot refs[${index}] (${ref}) has no role string`)
    }
    if (typeof name !== 'string') {
      throw new Error(`page.snapshot refs[${index}] (${ref}) has no name string`)
    }
    return { ref, role, name }
  })
}

export function selectSnapshotRef({
  refs,
  role,
  name,
}: {
  refs: SnapshotRefEntry[]
  role: string
  name: string
}): SnapshotRefEntry {
  const matches = refs.filter((entry) => entry.role === role && entry.name === name)
  if (matches.length === 0) {
    throw new Error(`snapshot refs have no ${role} named ${JSON.stringify(name)}; refusing a CSS or position fallback`)
  }
  const distinctRefs = [...new Set(matches.map((entry) => entry.ref))]
  if (distinctRefs.length > 1) {
    throw new Error(
      `snapshot refs have ${distinctRefs.length} ${role} entries named ${JSON.stringify(name)} (${distinctRefs.join(', ')}); refusing to guess which ref to use`,
    )
  }
  return matches[0]
}

export type SnapshotRefSelfCheck = { name: string; ok: boolean; detail: string }

export function runSnapshotRefSelfChecks(): SnapshotRefSelfCheck[] {
  const checks: SnapshotRefSelfCheck[] = []
  const run = ({ name, fn }: { name: string; fn: () => string | null }) => {
    try {
      const failure = fn()
      checks.push({ name, ok: failure === null, detail: failure || 'ok' })
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const snapshotValue = {
    snapshotId: 'managed:target:1:2:uuid',
    refs: [
      { ref: 'e1', role: 'button', name: 'Submit' },
      { ref: 'e2', role: 'textbox', name: 'Name' },
      { ref: 'e3', role: 'button', name: 'Fetch echo' },
    ],
  }

  run({
    name: 'snapshot refs resolve the unique button and textbox refs',
    fn: () => {
      const refs = parseSnapshotRefs({ value: snapshotValue })
      const button = selectSnapshotRef({ refs, role: 'button', name: 'Submit' })
      const textbox = selectSnapshotRef({ refs, role: 'textbox', name: 'Name' })
      if (button.ref !== 'e1') {
        return `button ref is ${JSON.stringify(button.ref)}, expected "e1"`
      }
      if (textbox.ref !== 'e2') {
        return `textbox ref is ${JSON.stringify(textbox.ref)}, expected "e2"`
      }
      return null
    },
  })

  run({
    name: 'snapshot refs reject repeated role+name entries',
    fn: () => {
      const refs = parseSnapshotRefs({
        value: {
          refs: [
            { ref: 'e1', role: 'button', name: 'Save' },
            { ref: 'e2', role: 'button', name: 'Save' },
          ],
        },
      })
      try {
        selectSnapshotRef({ refs, role: 'button', name: 'Save' })
        return 'expected an ambiguity error for two buttons named Save'
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes('refusing to guess') ? null : `unexpected error: ${message}`
      }
    },
  })

  run({
    name: 'snapshot refs report a missing role+name clearly',
    fn: () => {
      const refs = parseSnapshotRefs({ value: snapshotValue })
      try {
        selectSnapshotRef({ refs, role: 'button', name: 'Missing' })
        return 'expected a missing-ref error'
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes('no button named') ? null : `unexpected error: ${message}`
      }
    },
  })

  run({
    name: 'snapshot refs require the runtime refs array',
    fn: () => {
      try {
        parseSnapshotRefs({ value: { text: '- button "Submit"' } })
        return 'expected an error for a response without a refs array'
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes('has no refs array') ? null : `unexpected error: ${message}`
      }
    },
  })

  run({
    name: 'snapshot refs reject malformed entries',
    fn: () => {
      try {
        parseSnapshotRefs({ value: { refs: [{ role: 'button', name: 'Submit' }] } })
        return 'expected an error for a ref entry without a ref string'
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes('has no ref string') ? null : `unexpected error: ${message}`
      }
    },
  })

  return checks
}
