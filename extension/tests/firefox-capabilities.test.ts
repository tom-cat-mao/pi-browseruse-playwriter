import { describe, expect, test } from 'vitest'
import { FIELDS } from '../src/firefox-request-validation'
import { FIREFOX_CAPABILITIES, FIREFOX_SUPPORTED_PAGE_OPERATIONS } from '../src/firefox-resources'

/**
 * The runtime gates every Firefox page operation on the advertised list and
 * routes page.extract only to a peer that advertises it, so the advertisement
 * must stay exactly the set of page operations this extension accepts.
 */
describe('Firefox capability advertisement', () => {
  test('advertises exactly the page operations its request validator accepts', () => {
    expect(FIREFOX_CAPABILITIES.supportedOperations).toEqual(FIREFOX_SUPPORTED_PAGE_OPERATIONS)
    const accepted = Object.keys(FIELDS).filter((kind) => {
      return kind.startsWith('page.')
    }).sort()
    expect([...FIREFOX_SUPPORTED_PAGE_OPERATIONS].sort()).toEqual(accepted)
    // Content extraction is the operation the runtime refuses without an advertisement.
    expect(accepted).toContain('page.extract')
  })

  /**
   * The runtime gates page.extract images modes on this advertisement, so an
   * extension that predates the background byte channel must not claim them.
   */
  test('advertises both image modes the background byte channel serves', () => {
    expect(FIREFOX_CAPABILITIES.features?.assets).toEqual(['urls', 'save'])
  })
})
