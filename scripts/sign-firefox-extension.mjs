import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { JwtApiAuth, signAddon } from 'web-ext/util/submit-addon'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(repoRoot, 'dist-release')
const tempDir = path.join(repoRoot, 'tmp')
const firefoxBundleDir = path.join(repoRoot, 'playwriter', 'dist', 'extension-firefox')
const amoApiBaseUrl = 'https://addons.mozilla.org/api/v5/'
const amoChannel = 'unlisted'
// AMO signs unlisted submissions within seconds; these bounds only stop a stalled
// request from eating the whole release job, and rerunning the same tag reuses the
// signature AMO already stored instead of submitting the version again.
const validationCheckTimeoutMs = 5 * 60 * 1000
const approvalCheckTimeoutMs = 10 * 60 * 1000

function readFirefoxIdentity() {
  const manifestPath = path.join(firefoxBundleDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      'Missing playwriter/dist/extension-firefox/manifest.json; run the runtime build before signing the Firefox extension',
    )
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const addonId = manifest.browser_specific_settings?.gecko?.id
  if (typeof manifest.version !== 'string' || manifest.version.length === 0 || typeof addonId !== 'string') {
    throw new Error('Firefox bundle manifest has no version or no browser_specific_settings.gecko.id')
  }
  return { addonId, version: manifest.version }
}

function readAmoCredentials() {
  const issuer = (process.env.AMO_JWT_ISSUER ?? '').trim()
  const secret = (process.env.AMO_JWT_SECRET ?? '').trim()
  if (issuer.length === 0 || secret.length === 0) {
    return null
  }
  return { issuer, secret }
}

function requireAmoCredentials() {
  const credentials = readAmoCredentials()
  if (credentials) {
    return credentials
  }
  throw new Error(
    [
      'AMO_JWT_ISSUER and AMO_JWT_SECRET must both be set to sign the Firefox extension on AMO.',
      'Export the addons.mozilla.org API key (JWT issuer) and secret, for example:',
      '  AMO_JWT_ISSUER=user:12345:67 AMO_JWT_SECRET=... pnpm sign:firefox',
      'In CI the extension release workflow injects them from the AMO_JWT_ISSUER and AMO_JWT_SECRET repository secrets.',
    ].join('\n'),
  )
}

async function responseMessage(response) {
  const body = (await response.text()).trim()
  return body.length > 0 ? body.slice(0, 300) : `HTTP ${response.status}`
}

async function findSignedVersion({ versionUrl, authHeader }) {
  const response = await fetch(versionUrl, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  })
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`AMO version lookup failed: ${await responseMessage(response)}`)
  }
  return response.json()
}

async function downloadSignedXpi({ fileUrl, destination, authHeader }) {
  const response = await fetch(fileUrl, {
    headers: { Authorization: authHeader },
  })
  if (!response.ok) {
    throw new Error(`Downloading the AMO signature failed: ${await responseMessage(response)}`)
  }
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
}

function writeSignedArtifacts({ signedXpiPath }) {
  const archive = fs.readFileSync(signedXpiPath)
  if (archive.length < 4 || archive.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`${path.relative(repoRoot, signedXpiPath)} is not a ZIP archive`)
  }
  if (!archive.includes(Buffer.from('META-INF/mozilla.rsa'))) {
    throw new Error(`${path.relative(repoRoot, signedXpiPath)} carries no META-INF/mozilla.rsa signature`)
  }
  const digest = crypto.createHash('sha256').update(archive).digest('hex')
  const checksumPath = `${signedXpiPath}.sha256`
  fs.writeFileSync(checksumPath, `${digest}  ${path.basename(signedXpiPath)}\n`)
  console.log(`Created ${signedXpiPath}`)
  console.log(`Created ${checksumPath}`)
  console.log(`SHA256 ${digest}`)
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const { addonId, version } = readFirefoxIdentity()
  const escapedAddonId = encodeURIComponent(addonId)
  const escapedVersion = encodeURIComponent(version)
  const unsignedXpiPath = path.join(outputDir, `pi-browser-use-firefox-extension-${version}-unsigned.xpi`)
  const signedXpiPath = path.join(outputDir, `pi-browser-use-firefox-extension-${version}.xpi`)
  if (!fs.existsSync(unsignedXpiPath)) {
    throw new Error(`Missing ${path.relative(repoRoot, unsignedXpiPath)}; run \`pnpm package:firefox\` before signing`)
  }
  const versionUrl = new URL(`addons/addon/${escapedAddonId}/versions/${escapedVersion}/`, amoApiBaseUrl)
  const credentials = readAmoCredentials()

  const unsignedDigest = crypto.createHash('sha256').update(fs.readFileSync(unsignedXpiPath)).digest('hex')
  console.log(`Signing ${addonId} ${version} on the AMO ${amoChannel} channel`)
  console.log(
    `Uploads the packaged ${path.relative(repoRoot, unsignedXpiPath)} unchanged (sha256 ${unsignedDigest}), so AMO signs the same files that ship in the release`,
  )
  console.log(`  POST ${new URL('addons/upload/', amoApiBaseUrl).href} channel=${amoChannel}`)
  console.log(`  PUT ${new URL(`addons/addon/${escapedAddonId}/`, amoApiBaseUrl).href} version=${version}`)
  console.log(`  GET ${versionUrl.href} while waiting for approval, then download the signed XPI`)
  console.log(`Writes ${path.relative(repoRoot, signedXpiPath)} and ${path.basename(signedXpiPath)}.sha256`)

  if (dryRun) {
    console.log(
      credentials
        ? 'Dry run: credentials are present and no AMO request was sent'
        : 'Dry run: AMO_JWT_ISSUER and AMO_JWT_SECRET are unset and no AMO request was sent',
    )
    return
  }

  const { issuer, secret } = requireAmoCredentials()
  const authHeader = await new JwtApiAuth({ apiKey: issuer, apiSecret: secret }).getAuthHeader()

  // AMO accepts a given version number only once, so a rerun of the same tag has to
  // reuse the signature instead of submitting the version again.
  const existingVersion = await findSignedVersion({ versionUrl, authHeader })
  if (existingVersion) {
    const fileUrl = existingVersion.file?.url
    if (existingVersion.file?.status !== 'public' || typeof fileUrl !== 'string') {
      throw new Error(
        `AMO already stores ${addonId} ${version} but its file is not signed yet; rerun this workflow once AMO finished signing`,
      )
    }
    await downloadSignedXpi({ fileUrl, destination: signedXpiPath, authHeader })
    console.log(
      `AMO already signed ${addonId} ${version}; downloaded that signature instead of submitting the version again`,
    )
    writeSignedArtifacts({ signedXpiPath })
    return
  }

  fs.mkdirSync(tempDir, { recursive: true })
  const result = await signAddon({
    apiKey: issuer,
    apiSecret: secret,
    amoBaseUrl: amoApiBaseUrl,
    channel: amoChannel,
    id: addonId,
    xpiPath: unsignedXpiPath,
    downloadDir: tempDir,
    savedIdPath: path.join(tempDir, 'amo-extension-id'),
    savedUploadUuidPath: path.join(tempDir, 'amo-upload-uuid.json'),
    validationCheckTimeout: validationCheckTimeoutMs,
    approvalCheckTimeout: approvalCheckTimeoutMs,
  })
  const downloadedFiles = result.downloadedFiles ?? []
  if (downloadedFiles.length !== 1) {
    throw new Error(`Expected one signed XPI from AMO, got ${downloadedFiles.length}`)
  }
  fs.renameSync(path.join(tempDir, downloadedFiles[0]), signedXpiPath)
  writeSignedArtifacts({ signedXpiPath })
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
