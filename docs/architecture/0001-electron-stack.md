# ADR 0001 — Electron como stack

**Estado:** Aceptado
**Fecha:** 2026-05-09

## Contexto

Necesitamos un navegador Chromium-based con UI custom (sidebar, identities, workspaces), partition isolation por identity, y proxy auth per-tab. Solo dev (Claude + Jose), presupuesto $0 inicial, target macOS Apple Silicon, time-to-MVP el más corto posible.

## Decisión

**Electron 37/42 + WebContentsView + electron-browser-shell + electron-forge + webpack.**

## Alternativas consideradas

- **Fork real de Chromium (estilo Brave / Arc / Vivaldi):** 35M LOC, build inicial 1-2h en M2 Pro, 80-120 GB disco, rebase de patches cada 4 semanas (cadencia Chrome). Trabajo de equipo full-time. Descartado para v1; reservado a Etapa 9 si MRR > $5K.
- **CEF (Chromium Embedded Framework):** complejidad de fork sin ventajas; toda la UI tipo Chrome la escribirías en C++ desde cero. Meses solo para UI básica. Descartado.
- **Tauri:** en macOS usa WKWebView, no Chromium. No soporta Chrome extensions. Fingerprint = Safari, no Chrome. Descartado.
- **Extensión de navegador (Chrome / Firefox):** `chrome.proxy` MV3 es global del profile, no per-tab. Hacks PAC frágiles. No es un browser, es una extensión que simula. Descartado.

## Consecuencias

- ✅ Time-to-MVP: 4-8 semanas vs 6-12 meses del fork.
- ✅ Mantenimiento: bumpear Electron sube Chromium gratis.
- ✅ APIs `session.fromPartition('persist:...')` + `session.setProxy()` + `app.on('login')` resuelven nativamente nuestras 3 features críticas.
- ✅ electron-builder hace sign+notarize+universal binary trivial.
- ⚠️ Soporte de Chrome Web Store extensions ~80% via `electron-chrome-extensions` (MV2 sólido, MV3 incompleto).
- ⚠️ TLS fingerprint, anti-bot top tier (Cloudflare BM agresivo) NO se puede vencer sin fork. OK porque target es multi-cuenta de redes sociales, no scraping a escala enterprise.
- ⚠️ Tamaño binario ~150-220 MB (vs 250-400 MB fork puro).

## Referencias

- Validado en spike Etapa 0 (`../history/05-etapa-0-resultado.md`)
- Boilerplate: https://github.com/samuelmaddock/electron-browser-shell (MIT)
