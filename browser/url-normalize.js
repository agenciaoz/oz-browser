// OZ Browser — URL normalization for the omnibox.
//
// Doc: docs/modules/url-normalize.md (TODO)
// Bloque: hotfix post-Etapa-3d
//
// `webContents.loadURL('x.com')` falla con ERR_INVALID_ARGUMENT porque
// Electron requiere scheme explícito. Cualquier browser moderno acepta
// "x.com" en el omnibox y lo trata como `https://x.com`. Este módulo
// implementa esa normalización.
//
// Reglas (en orden):
//   1. Si la string es vacía o whitespace → null (caller no debe navegar).
//   2. Si tiene scheme válido (http://, https://, file://, chrome://,
//      about:, view-source:, ftp://, etc.) → pasa as-is.
//   3. Si parece un dominio (algo.algo, localhost, IP) → prepend https://.
//   4. Sino → trata como search query → google.com/search?q=...
//
// Pure function, sin Electron, testeable directo en Node.

// Whitelist explícita en vez de patrón genérico [a-z]+: porque
// "localhost:9223" matchearía como pseudo-scheme y no es lo que el user
// quiere — debe normalizarse a https://localhost:9223. Tampoco queremos que
// typos tipo "htps://x.com" pasen sin redirigir a search.
const SCHEME_RE =
  /^(https?|ftp|file|chrome|chrome-extension|about|view-source|data|mailto|tel|javascript):/i

// Detecta:
// - dominio.tld[/path][?query] (más común)
// - ip:port
// - localhost[:port][/path]
// - hostnames con guiones, puertos
const DOMAIN_LIKE_RE =
  /^([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(:\d+)?(\/[^\s]*)?(\?[^\s]*)?$|^localhost(:\d+)?(\/[^\s]*)?(\?[^\s]*)?$|^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/[^\s]*)?(\?[^\s]*)?$/i

/**
 * Normaliza un input del omnibox a una URL válida.
 * @param {string} input - lo que el user tipeó.
 * @returns {string|null} URL navegable o null si vacío.
 */
function normalizeOmniboxInput(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  // Caso 2: ya tiene scheme.
  if (SCHEME_RE.test(trimmed)) return trimmed
  // Caso 3: parece dominio o IP.
  if (DOMAIN_LIKE_RE.test(trimmed)) return 'https://' + trimmed
  // Caso 4: search query. Google es default v1; settable post-launch.
  return 'https://www.google.com/search?q=' + encodeURIComponent(trimmed)
}

module.exports = { normalizeOmniboxInput, _testHelpers: { SCHEME_RE, DOMAIN_LIKE_RE } }
