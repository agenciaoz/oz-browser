// OZ Browser — Error handler with email-to-Jose popup.

const { app, dialog, shell, clipboard, BrowserWindow } = require('electron')
const log = require('./logger')

const REPORT_TO = 'joserodrigo@gmail.com'

let dialogShowing = false

function summarizeError(err) {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err
  if (err.stack) return err.stack
  if (err.message) return err.message
  try {
    return JSON.stringify(err)
  } catch (_e) {
    return String(err)
  }
}

function shortMessage(err) {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err.split('\n')[0].slice(0, 200)
  if (err.message) return err.message.slice(0, 200)
  return String(err).slice(0, 200)
}

function showErrorDialog(title, errOrDetail) {
  if (dialogShowing) {
    // Avoid dialog spam if many errors fire at once.
    log.warn('error-handler', 'Suppressing additional error dialog (one already showing)')
    return
  }
  dialogShowing = true

  const detailStr = summarizeError(errOrDetail)
  const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]

  // Use async showMessageBox so we don't block if the renderer is the one that erred.
  const opts = {
    type: 'error',
    title: 'OZ Browser — Error',
    message: title,
    detail: detailStr.length > 1500 ? detailStr.slice(0, 1500) + '\n…[truncated, see log file]' : detailStr,
    buttons: ['Email Jose', 'Copy details', 'Open log file', 'Dismiss'],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  }

  const handle = (result) => {
    dialogShowing = false
    if (!result || typeof result.response !== 'number') return
    const choice = result.response
    if (choice === 0) {
      // Email — open mailto: with subject + body pre-filled.
      const subject = `OZ Browser error: ${shortMessage(errOrDetail)}`
      const body =
        `Hi Jose,\n\nOZ Browser hit an error.\n\n` +
        `Title: ${title}\n` +
        `Time: ${new Date().toISOString()}\n` +
        `Version: ${app.getVersion()}\n` +
        `Platform: ${process.platform} ${process.arch}\n` +
        `Electron: ${process.versions.electron}\n` +
        `Log file: ${log.getLogFilePath()}\n\n` +
        `--- Error ---\n${detailStr}\n`
      const url = `mailto:${REPORT_TO}?subject=${encodeURIComponent(
        subject,
      )}&body=${encodeURIComponent(body)}`
      shell.openExternal(url).catch((e) => log.error('error-handler', 'openExternal failed', e))
    } else if (choice === 1) {
      clipboard.writeText(`${title}\n\n${detailStr}`)
    } else if (choice === 2) {
      const file = log.getLogFilePath()
      if (file) shell.showItemInFolder(file)
    }
  }

  if (focused) {
    dialog.showMessageBox(focused, opts).then(handle).catch((e) => {
      dialogShowing = false
      log.error('error-handler', 'showMessageBox failed', e)
    })
  } else {
    dialog.showMessageBox(opts).then(handle).catch((e) => {
      dialogShowing = false
      log.error('error-handler', 'showMessageBox failed', e)
    })
  }
}

function setupErrorHandlers() {
  process.on('uncaughtException', (err) => {
    log.error('main', 'Uncaught exception', { stack: err.stack, message: err.message })
    showErrorDialog('Uncaught exception (main process)', err)
  })

  process.on('unhandledRejection', (reason) => {
    log.error('main', 'Unhandled promise rejection', {
      stack: reason && reason.stack ? reason.stack : null,
      reason: reason && reason.message ? reason.message : String(reason),
    })
    showErrorDialog('Unhandled promise rejection (main process)', reason)
  })

  app.on('render-process-gone', (_event, webContents, details) => {
    log.error('renderer', 'render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents.getURL(),
    })
    showErrorDialog(
      `Renderer process gone (${details.reason})`,
      `Reason: ${details.reason}\nExit code: ${details.exitCode}\nURL: ${webContents.getURL()}`,
    )
  })

  app.on('child-process-gone', (_event, details) => {
    log.error('child', 'child-process-gone', details)
  })
}

/** Wrap an IPC handler so all thrown errors are logged + reported. */
function wrapHandler(channel, fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args)
    } catch (err) {
      log.error('ipc', `Handler ${channel} threw`, { stack: err.stack, message: err.message })
      showErrorDialog(`IPC handler error: ${channel}`, err)
      throw err
    }
  }
}

module.exports = {
  setupErrorHandlers,
  showErrorDialog,
  wrapHandler,
}
