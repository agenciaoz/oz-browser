// OZ Browser — WebUI bootloader. Boots TabStrip + IdentitySidebar after the
// dependencies (oz-utils.js, tabstrip.js, sidebar.js) have been loaded.

const { safe } = window.OZ.utils
const tabstrip = new window.OZ.TabStrip()
const sidebar = new window.OZ.IdentitySidebar()
window.tabstrip = tabstrip
window.ozsidebar = sidebar

;(async () => {
  await tabstrip.init()
  await sidebar.init()
})().catch((err) => {
  console.error('[oz/webui] boot failed:', err)
  if (window.oz && window.oz.log) {
    window.oz.log.reportError({
      source: 'webui/boot',
      message: err.message || String(err),
      stack: err.stack,
    })
  }
})
