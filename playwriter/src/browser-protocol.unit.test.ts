import { describe, expect, test } from 'vitest'
import { buildTabCandidateId, parseTabCandidateId } from './browser-protocol.js'

/**
 * The discovery id is the shared contract between the extension (which builds
 * it from live Chrome), the relay (which routes and epoch-checks it) and Pi
 * (which passes it back verbatim). No layer may invent its own format.
 */
describe('tab candidate identity', () => {
  test('round-trips profile, browser epoch and chrome tab id', () => {
    const candidateId = buildTabCandidateId({ profileId: 'profile-1', browserEpoch: 'epoch-a', chromeTabId: 42 })
    expect(candidateId).toMatchInlineSnapshot(`"pcdt:profile-1:epoch-a:42"`)
    expect(parseTabCandidateId(candidateId)).toEqual({
      profileId: 'profile-1',
      browserEpoch: 'epoch-a',
      chromeTabId: 42,
    })
  })

  test('rejects ids that are not discoveries, so a stale or guessed id never attaches', () => {
    expect(parseTabCandidateId('ptab-1')).toBeNull()
    expect(parseTabCandidateId('pcdt:profile-1:epoch-a')).toBeNull()
    expect(parseTabCandidateId('pcdt:profile-1:epoch-a:7:extra')).toBeNull()
    expect(parseTabCandidateId('pcdt:profile-1:epoch-a:not-a-number')).toBeNull()
    expect(parseTabCandidateId('pcdt:profile-1:epoch-a:-1')).toBeNull()
  })
})
