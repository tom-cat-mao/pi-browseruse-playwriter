import { describe, expect, test } from 'vitest'
import { buildFirefoxTabCandidateId, buildTabCandidateId, parseBrowserTabCandidateId, parseTabCandidateId } from './browser-protocol.js'

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

  test('keeps Firefox physical identities separate from legacy Chrome candidates', () => {
    const candidateId = buildFirefoxTabCandidateId({ profileId: 'firefox-1', browserEpoch: 'epoch-f', browserTabId: 42 })
    expect(candidateId).toBe('pfxdt:firefox-1:epoch-f:42')
    expect(parseTabCandidateId(candidateId)).toBeNull()
    expect(parseBrowserTabCandidateId(candidateId)).toEqual({
      profileId: 'firefox-1', browserEpoch: 'epoch-f', browserTabId: 42, backend: 'webextension',
    })
    expect(parseBrowserTabCandidateId('pcdt:chrome-1:epoch-c:42')).toEqual({
      profileId: 'chrome-1', browserEpoch: 'epoch-c', browserTabId: 42, backend: 'cdp',
    })
  })

  test('rejects malformed Firefox identities and unsafe numeric ids', () => {
    for (const candidateId of [
      'pfxdt::epoch:1', 'pfxdt:profile::1', 'pfxdt:profile:epoch:-1',
      'pfxdt:profile:epoch:1e2', 'pfxdt:profile:epoch:01',
      'pfxdt:profile:epoch:9007199254740992', 'pfxdt:profile:epoch:1:extra',
    ]) {
      expect(parseBrowserTabCandidateId(candidateId)).toBeNull()
    }
  })

})
