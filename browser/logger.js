// OZ Browser — Unified logger
//
// Writes timestamped lines to ~/Library/Logs/oz-browser/oz-browser.log on macOS
// (and equivalent paths on Win/Linux). Mirrors to console in dev. Rotates
// when the file exceeds MAX_BYTES.

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const ROTATE_KEEP = 3

let logFile = null
let logStream = null
let initialized = false

function getLogDir() {
  return path.join(app.getPath('logs'))
}

function getLogFilePath() {
  return logFile
}

function rotate() {
  // Move .log -> .log.1 -> .log.2 -> .log.3 (drop .log.3)
  for (let i = ROTATE_KEEP; i >= 1; i--) {
    const from = i === 1 ? logFile : `${logFile}.${i - 1}`
    const to = `${logFile}.${i}`
    try {
      if (fs.existsSync(from)) {
        fs.renameSync(from, to)
      }
    } catch (_e) {
      // ignore rotation errors
    }
  }
}

function init() {
  if (initialized) return
  try {
    const dir = getLogDir()
    fs.mkdirSync(dir, { recursive: true })
    logFile = path.join(dir, 'oz-browser.log')

    try {
      const stat = fs.statSync(logFile)
      if (stat.size > MAX_BYTES) rotate()
    } catch (_e) {
      // file doesn't exist yet — fine
    }

    logStream = fs.createWriteStream(logFile, { flags: 'a' })
    initialized = true

    log('INFO', 'logger', `Logger started`, {
      pid: process.pid,
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      logFile,
    })
  } catch (err) {
    // Logger should NEVER crash the app.
    console.error('[logger] init failed:', err)
  }
}

function fmt(level, source, message, args) {
  const ts = new Date().toISOString()
  let line = `[${ts}] ${level.padEnd(5)} [${source}] ${message}`
  if (args && args.length) {
    try {
      line +=
        ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    } catch (_e) {
      line += ' [unserializable args]'
    }
  }
  return line + '\n'
}

function log(level, source, message, ...args) {
  const line = fmt(level, source, message, args)
  // Always console — useful in dev. In packaged app, console output goes to
  // the parent process and to the log file.
  if (level === 'ERROR') console.error(line.trim())
  else if (level === 'WARN') console.warn(line.trim())
  // eslint-disable-next-line no-console -- logger IS the console output for INFO/DEBUG
  else console.log(line.trim())

  if (logStream) {
    try {
      logStream.write(line)
    } catch (_e) {
      // ignore — the OS may have closed the stream during shutdown
    }
  }
}

module.exports = {
  init,
  getLogFilePath,
  debug: (src, msg, ...args) => log('DEBUG', src, msg, ...args),
  info: (src, msg, ...args) => log('INFO', src, msg, ...args),
  warn: (src, msg, ...args) => log('WARN', src, msg, ...args),
  error: (src, msg, ...args) => log('ERROR', src, msg, ...args),
}
