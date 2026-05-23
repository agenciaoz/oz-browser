// OZ Browser — Bulk Runner: friendly explanations per error/login code.
//
// Extracted from bulk-runner-ui.js in alpha.20 to stay under the 500 LOC
// rule (ADR 0005) after the alpha.20 menu/IPC wire-up additions. Shown
// as tooltip on hover so the user doesn't need to read source to
// understand what a failure code means.
//
// Consumed by bulk-runner-ui.js via window.OZ.bulkRunnerCodes.
//
// IIFE-wrapped — see oz-utils.js comment.

;(function () {
  if (!window.OZ) window.OZ = {}
  window.OZ.bulkRunnerCodes = {
    ERROR_CODE_EXPLAIN: {
      needs_login:
        'Identity is not logged in to the platform. Auto-login retry will use vault credentials if wired.',
      captcha: 'Platform showed a captcha/security challenge. Solve manually then retry.',
      'not-found':
        'Target element (button/post/profile) not found. Selectors may be stale or URL invalid.',
      'click-failed':
        'Click registered but state did not flip. Usually rate-limit or action-block.',
      'submit-failed':
        'Form submit clicked but no confirmation. Usually rate-limit or platform-side reject.',
      'rate-limit':
        'Identity hit the daily cap for this action. Will reset at UTC midnight.',
      'image-missing': 'imagePath does not exist on disk.',
      aborted: 'Run was cancelled mid-action.',
    },
    LOGIN_CODE_EXPLAIN: {
      'vault-locked': 'Vault is locked. Open Account Manager and unlock it.',
      'no-credentials':
        'No account stored for this (identity, platform). Add one in Account Manager.',
      'totp-needed-no-secret':
        'Platform asked for 2FA code but the account has no totpSecret stored. Add it in Account Manager.',
      'login-failed':
        'Filled the form + submitted but page still shows login. Wrong password / rate-limited / captcha.',
      'unsupported-platform': 'No login flow registered for this platform yet.',
      aborted: 'Login attempt was cancelled by the run signal.',
    },
  }
})()
