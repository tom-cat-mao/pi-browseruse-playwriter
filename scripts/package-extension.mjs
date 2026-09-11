import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import zlib from 'node:zlib'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(repoRoot, 'playwriter', 'dist', 'extension')
const outputDir = path.join(repoRoot, 'dist-release')
const tempDir = path.join(repoRoot, 'tmp')
const forkExtensionId = 'eeklahpecooapnailfaebkjjembkjhhg'

const crcTable = Uint32Array.from(
  Array.from({ length: 256 }, (_value, index) => {
    let crc = index
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    return crc >>> 0
  }),
)

function crc32(data) {
  const crc = data.reduce((value, byte) => {
    return crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  }, 0xffffffff)
  return (crc ^ 0xffffffff) >>> 0
}

function extensionIdFromKey(key) {
  const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest()
  return Array.from(hash.subarray(0, 16))
    .map((byte) => {
      return byte.toString(16).padStart(2, '0')
    })
    .join('')
    .split('')
    .map((character) => {
      return 'abcdefghijklmnop'[Number.parseInt(character, 16)]
    })
    .join('')
}

function collectFiles(directory, prefix = '') {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => {
      return left.name.localeCompare(right.name)
    })
    .flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        return collectFiles(absolutePath, relativePath)
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported entry in extension build: ${relativePath}`)
      }
      return [relativePath]
    })
}

function readManifest(bundleDir) {
  const manifestPath = path.join(bundleDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Built extension is missing manifest.json at its root')
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error('Built extension has an invalid manifest.json', { cause: error })
  }
}

function localReferencePath({ fileName, reference }) {
  const cleanReference = reference.split(/[?#]/, 1)[0]
  if (!cleanReference || cleanReference.startsWith('#') || /^(?:[a-z]+:|\/\/)/i.test(cleanReference)) {
    return null
  }
  if (cleanReference.startsWith('/')) {
    return path.posix.normalize(cleanReference.replace(/^\/+/, ''))
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(fileName), cleanReference))
}

function htmlScriptReferences({ bundleDir, fileName }) {
  const html = fs.readFileSync(path.join(bundleDir, ...fileName.split('/')), 'utf8')
  return Array.from(html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)).map((match) => {
    return match[1]
  })
}

function assertReferencesExist({ files, references, sourceName }) {
  return references.every((reference) => {
    const relativePath = localReferencePath({ fileName: sourceName, reference })
    if (relativePath && !files.includes(relativePath)) {
      throw new Error(`${sourceName} references missing packaged file ${relativePath}`)
    }
    return true
  })
}

function validateBundle({ bundleDir, expectedExtensionId = forkExtensionId }) {
  const files = collectFiles(bundleDir)
  const forbiddenPath =
    /(?:^|\/)(?:node_modules|test|tests|test-fixtures|private)(?:\/|$)|(?:^|\/)\.env(?:$|\.)|\.(?:map|pem)$/i
  const forbiddenSource = /\.(?:ts|tsx|mts|cts)$/i
  const forbiddenFiles = files.filter((fileName) => {
    return forbiddenPath.test(fileName) || forbiddenSource.test(fileName)
  })
  if (forbiddenFiles.length > 0) {
    throw new Error(`Forbidden files in extension package: ${forbiddenFiles.join(', ')}`)
  }

  const manifest = readManifest(bundleDir)
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('Built extension manifest has no version')
  }
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
    throw new Error('Fork release package must contain its stable development manifest key')
  }
  const extensionId = extensionIdFromKey(manifest.key)
  if (extensionId !== expectedExtensionId) {
    throw new Error(`Expected extension ID ${expectedExtensionId}, got ${extensionId}`)
  }

  const backgroundPath = 'background.js'
  if (!files.includes(backgroundPath)) {
    throw new Error('Built extension is missing background.js')
  }
  const background = fs.readFileSync(path.join(bundleDir, backgroundPath), 'utf8')
  if (!background.includes('19989')) {
    throw new Error('Built extension does not target the managed runtime port 19989')
  }
  const builtText = files
    .filter((fileName) => {
      return /\.(?:html|js|json)$/i.test(fileName)
    })
    .map((fileName) => {
      return fs.readFileSync(path.join(bundleDir, ...fileName.split('/')), 'utf8')
    })
    .join('\n')
  if (/\b(?:19987|19991)\b|PLAYWRITER_PORT=|TESTING=1/i.test(builtText)) {
    throw new Error('Development environment marker found in extension package')
  }

  const manifestReferences = [
    manifest.background?.service_worker,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter((reference) => {
    return typeof reference === 'string'
  })
  if (!assertReferencesExist({ files, references: manifestReferences, sourceName: 'manifest.json' })) {
    throw new Error('Unable to validate manifest references')
  }

  const htmlFiles = files.filter((fileName) => {
    return fileName.endsWith('.html')
  })
  const htmlReferences = htmlFiles.flatMap((fileName) => {
    return htmlScriptReferences({ bundleDir, fileName }).map((reference) => {
      return { fileName, reference }
    })
  })
  if (
    !htmlReferences.every(({ fileName, reference }) => {
      return assertReferencesExist({
        files,
        references: [reference],
        sourceName: fileName,
      })
    })
  ) {
    throw new Error('Unable to validate HTML references')
  }

  if (!files.includes('src/prism.min.js') || !files.includes('src/prism-bash.min.js')) {
    throw new Error('Built extension is missing offline Prism assets')
  }

  return { files, manifest }
}

function makeZip({ bundleDir, files }) {
  const archive = files.reduce(
    (state, fileName) => {
      const data = fs.readFileSync(path.join(bundleDir, ...fileName.split('/')))
      const compressedData = zlib.deflateRawSync(data, { level: 9 })
      const useDeflate = compressedData.length < data.length
      const payload = useDeflate ? compressedData : data
      const method = useDeflate ? 8 : 0
      const name = Buffer.from(fileName, 'utf8')
      const checksum = crc32(data)

      const localHeader = Buffer.alloc(30)
      localHeader.writeUInt32LE(0x04034b50, 0)
      localHeader.writeUInt16LE(20, 4)
      localHeader.writeUInt16LE(0x800, 6)
      localHeader.writeUInt16LE(method, 8)
      localHeader.writeUInt32LE(0, 10)
      localHeader.writeUInt32LE(checksum, 14)
      localHeader.writeUInt32LE(payload.length, 18)
      localHeader.writeUInt32LE(data.length, 22)
      localHeader.writeUInt16LE(name.length, 26)
      localHeader.writeUInt16LE(0, 28)
      const localRecord = Buffer.concat([localHeader, name, payload])

      const centralHeader = Buffer.alloc(46)
      centralHeader.writeUInt32LE(0x02014b50, 0)
      centralHeader.writeUInt16LE(20, 4)
      centralHeader.writeUInt16LE(20, 6)
      centralHeader.writeUInt16LE(0x800, 8)
      centralHeader.writeUInt16LE(method, 10)
      centralHeader.writeUInt32LE(0, 12)
      centralHeader.writeUInt32LE(checksum, 16)
      centralHeader.writeUInt32LE(payload.length, 20)
      centralHeader.writeUInt32LE(data.length, 24)
      centralHeader.writeUInt16LE(name.length, 28)
      centralHeader.writeUInt16LE(0, 30)
      centralHeader.writeUInt16LE(0, 32)
      centralHeader.writeUInt16LE(0, 34)
      centralHeader.writeUInt16LE(0, 36)
      centralHeader.writeUInt32LE(0, 38)
      centralHeader.writeUInt32LE(state.offset, 42)
      const centralRecord = Buffer.concat([centralHeader, name])

      return {
        localRecords: [...state.localRecords, localRecord],
        centralRecords: [...state.centralRecords, centralRecord],
        offset: state.offset + localRecord.length,
      }
    },
    { localRecords: [], centralRecords: [], offset: 0 },
  )

  const localData = Buffer.concat(archive.localRecords)
  const centralData = Buffer.concat(archive.centralRecords)
  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(archive.localRecords.length, 8)
  endRecord.writeUInt16LE(archive.localRecords.length, 10)
  endRecord.writeUInt32LE(centralData.length, 12)
  endRecord.writeUInt32LE(localData.length, 16)
  return Buffer.concat([localData, centralData, endRecord])
}

function safeExtractPath({ destination, fileName }) {
  if (fileName.includes('\\') || fileName.startsWith('/')) {
    throw new Error(`Unsafe ZIP entry ${fileName}`)
  }
  const destinationRoot = path.resolve(destination)
  const target = path.resolve(destination, ...fileName.split('/'))
  if (target !== destinationRoot && !target.startsWith(`${destinationRoot}${path.sep}`)) {
    throw new Error(`Unsafe ZIP entry ${fileName}`)
  }
  return target
}

function extractZip({ zipPath, destination }) {
  const archive = fs.readFileSync(zipPath)
  const entries = []
  let offset = 0
  while (offset + 4 <= archive.length) {
    const signature = archive.readUInt32LE(offset)
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break
    }
    if (signature !== 0x04034b50) {
      throw new Error(`Unsupported ZIP record at offset ${offset}`)
    }

    const flags = archive.readUInt16LE(offset + 6)
    if ((flags & 0x08) !== 0) {
      throw new Error('ZIP data descriptors are not supported by the package smoke check')
    }
    const method = archive.readUInt16LE(offset + 8)
    const compressedSize = archive.readUInt32LE(offset + 18)
    const uncompressedSize = archive.readUInt32LE(offset + 22)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8')
    const compressedData = archive.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? compressedData : method === 8 ? zlib.inflateRawSync(compressedData) : null
    if (!data) {
      throw new Error(`Unsupported ZIP compression method ${method}`)
    }
    if (data.length !== uncompressedSize || crc32(data) !== archive.readUInt32LE(offset + 14)) {
      throw new Error(`ZIP integrity check failed for ${name}`)
    }

    const target = safeExtractPath({ destination, fileName: name })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    entries.push(name)
    offset = dataStart + compressedSize
  }
  return entries
}

function verifyArchive({ zipPath, checksumPath, expectedExtensionId, expectedVersion }) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
  const checksumParts = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)
  if (checksumParts[0] !== digest || checksumParts[1] !== path.basename(zipPath)) {
    throw new Error('SHA256 checksum file does not match the generated ZIP')
  }

  const extractionDir = fs.mkdtempSync(path.join(tempDir, 'extension-package-check-'))
  try {
    const entries = extractZip({ zipPath, destination: extractionDir })
    const validation = validateBundle({ bundleDir: extractionDir, expectedExtensionId })
    if (validation.manifest.version !== expectedVersion) {
      throw new Error(`Extracted extension version ${validation.manifest.version} does not match ${expectedVersion}`)
    }
    const sortedEntries = [...entries].sort((left, right) => {
      return left.localeCompare(right)
    })
    if (
      sortedEntries.length !== validation.files.length ||
      sortedEntries.some((entry, index) => entry !== validation.files[index])
    ) {
      throw new Error('Extracted ZIP entries do not match the packaged extension files')
    }
  } finally {
    fs.rmSync(extractionDir, { recursive: true, force: true })
  }

  return digest
}

function main() {
  if (!fs.existsSync(sourceDir)) {
    throw new Error('Missing playwriter/dist/extension; build the runtime package before packaging the extension')
  }

  fs.mkdirSync(tempDir, { recursive: true })
  const stagingDir = fs.mkdtempSync(path.join(tempDir, 'extension-package-staging-'))
  try {
    fs.cpSync(sourceDir, stagingDir, { recursive: true })
    const validation = validateBundle({ bundleDir: stagingDir })
    const version = validation.manifest.version
    const zipName = `pi-browser-use-extension-${version}.zip`
    const zipPath = path.join(outputDir, zipName)
    const checksumPath = `${zipPath}.sha256`

    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(zipPath, makeZip({ bundleDir: stagingDir, files: validation.files }))
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
    fs.writeFileSync(checksumPath, `${checksum}  ${zipName}\n`)
    const digest = verifyArchive({
      zipPath,
      checksumPath,
      expectedExtensionId: forkExtensionId,
      expectedVersion: version,
    })

    console.log(`Created ${zipPath}`)
    console.log(`Created ${checksumPath}`)
    console.log(`SHA256 ${digest}`)
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
