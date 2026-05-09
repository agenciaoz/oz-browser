# Stack técnico: opciones para construir el clon

## Recomendación

**Electron 42.x + WebContentsView + `session.fromPartition('persist:...')`, scaffolded sobre `samuelmaddock/electron-browser-shell`.**

> **Validado en spike Etapa 0 (2026-05-09)** — ver `05-Resultado-Etapa-0.md`. Las 4 hipótesis técnicas críticas (aislamiento, proxy per-pestaña, auth user/pass, persistencia) pasaron contra Oxylabs Mobile HTTPS real.

Razones:

- API `session.fromPartition()` + `session.setProxy()` resuelve nativamente "cookie jar aislado por pestaña + proxy distinto por pestaña" — el corazón de Ghost Browser
- Time-to-MVP: 4–8 semanas (vs 6–12 meses fork de Chromium)
- Mantenimiento: subir versión de Electron = subir Chromium gratis (Electron sigue Chrome con 3-6 semanas de delay)
- Distribución macOS sólida (electron-builder, sign + notarize en un comando)
- Soporte Chrome Web Store ~80% via `electron-chrome-extensions` (MV2 sólido, MV3 incompleto)
- Boilerplate `electron-browser-shell` ya tiene tabs, omnibox, extension support

## Tabla comparativa

| Criterio                  | Fork Chromium | CEF        | **Electron** ⭐        | Tauri                   | Extension         |
| ------------------------- | ------------- | ---------- | ---------------------- | ----------------------- | ----------------- |
| Tiempo a MVP              | 6–12 meses    | 4–8 meses  | **4–8 semanas**        | 6–10 sem (sin features) | 2–4 sem           |
| Mantenimiento por release | Días-semanas  | Semanas    | **Horas**              | Bajo                    | Bajo              |
| Tamaño binario            | 250–400 MB    | 150–250 MB | 150–220 MB             | 8–20 MB                 | 1–5 MB            |
| Aislamiento cookies       | Total         | Total      | **Total (`persist:`)** | Limitado                | Hack              |
| Proxy por pestaña         | Total         | Total      | **Sí, por sesión**     | Difícil                 | Sólo PAC tricks   |
| Chrome Web Store          | Total         | Limitado   | **Parcial**            | **No**                  | N/A               |
| Distribución mac          | Compleja      | Media      | **Simple**             | Simple                  | App Store ext     |
| Riesgo Google rompa       | Alto          | Alto       | Medio                  | Bajo                    | **Crítico (MV3)** |

## Por qué se descartan las otras opciones

**Fork Chromium (Brave/Vivaldi style)**: 35M LOC, build de 1-2h en M2 Pro, 80-120 GB de disco, rebase de patches cada 4 semanas. Trabajo de equipo, no de proyecto solo. Brave dedica equipo full-time a esto.

**CEF**: peor combinación — complejidad de fork sin ventajas. Tienes que escribir TODA la UI tipo Chrome desde cero en C++. Meses de trabajo solo por la UI.

**Tauri**: en macOS usa WKWebView (no Chromium). No soporta extensions. Fingerprint = Safari, no Chrome → más sospechoso para sitios anti-bot, no menos. **No sirve.**

**Extensión pura**: Chrome MV3 `chrome.proxy` es global de profile, no per-tab. Hacks vía PAC frágiles. SessionBox criticado por no aislar fingerprint real. MV3 risk crítico.

## Detalle técnico Electron

### Aislamiento por Identity

```js
// Cada Identity = una partition
const identityPartition = `persist:identity-${identityId}`
const view = new WebContentsView({
  webPreferences: { partition: identityPartition },
})
```

`persist:` → cookies, IndexedDB, localStorage, cache, service workers persisten en `~/Library/Application Support/<app>/Partitions/<id>/`. Aislamiento total entre particiones.

### Proxy por pestaña

```js
const session = view.webContents.session
session.setProxy({ proxyRules: 'http=1.2.3.4:8080;https=1.2.3.4:8080' })
```

**Caveat (resuelto en spike)**: `setProxy` no acepta user:pass en `proxyRules`. Hay que usar `app.on('login')` para responder con credenciales. **Validado contra Oxylabs Mobile HTTPS en Etapa 0 — funciona limpio, evento dispara para cada session, credenciales aceptadas, IP del proxy correcta.**

```js
// Patrón canonical confirmado en spike
app.on('login', (event, webContents, request, authInfo, callback) => {
  if (authInfo.isProxy) {
    event.preventDefault()
    const cred = sessionCreds.get(webContents.session) // map session→creds
    callback(cred.username, cred.password)
  }
})
```

**Decisión adicional del spike:** usar **HTTPS** como protocolo default para proxies en lugar de SOCKS5. Razones: `app.on('login')` es rock-solid para HTTPS; SOCKS5 ha tenido bugs históricos en Electron; debugging más fácil. SOCKS5 queda como opción avanzada en la app final pero no es la ruta principal.

### Extensions

- `samuelmaddock/electron-browser-shell` + paquete `electron-chrome-extensions` → ~80% APIs Chrome (tabs, popups, browser_action, content scripts)
- MV3 incompleto: service workers no se inyectan bien. uBlock Origin Lite ok. 1Password/Bitwarden ok (ya migraron). MV3-only nuevas pueden romper
- Para target multi-cuenta de redes sociales, las útiles (containers, anti-fingerprint, cookie managers) son MV2 o están migrando

### Distribución macOS

- **electron-builder** o **electron-forge** → sign + notarize + dmg en un comando
- Apple Developer ID: $99/año
- Universal binary (Intel + Apple Silicon) factible
- Auto-update via **electron-updater** + GitHub Releases (gratis) o servidor propio

## Plan de fases (versión personal — antes del pivot SaaS)

**Fase 0 (1 semana) — Setup**: Apple Developer Program, signing + notarize end-to-end con hello-world Electron.

**Fase 1 — MVP (4–6 semanas)**:

- Fork de `electron-browser-shell`
- Modelo Identity `{id, name, color, proxyConfig, partition}`
- UI "nueva pestaña con Identity X"
- `WebContentsView` por pestaña con partition correspondiente
- Importador CSV de proxies
- Asignación manual + auto round-robin
- `webContents.on('login')` para proxy auth
- Build + sign + notarize + DMG

**Fase 2 — Workspaces y polish (3–4 semanas)**:

- Modelo Workspace = grupo tabs + identity + URL + estado
- Save/load workspace
- UI gestión Identities
- Indicador de proxy activo + IP check
- Auto-update (electron-updater)

**Fase 3 — Extensions (opcional, 2–4 semanas)**:

- `electron-chrome-extensions`
- UI instalación (drag .crx o Web Store)
- Test extensiones top, documentar limitaciones MV3

**Total realista a producto pulido**: 8–14 semanas con coder bueno (humano o IA con supervisión).

## Riesgos y unknowns

1. **Proxy con auth user:pass**: spike de 1 día en semana 1 contra proxy comercial real (Oxylabs mobile, SOCKS5 con auth) antes de comprometer stack
2. **MV3 extensions**: incompleto. Hacer lista corta de "must-have extensions" antes de fase 3 y validar cada una
3. **RAM**: 10 partitions × WebContentsView = mucha RAM. 16 GB viable; 8 GB asfixia. Documentar "20+ identities = 32GB recomendado"
4. **Auto-update y rotación Chromium**: Electron sigue Chromium con 3-6 sem delay. Release ~mensual para mantener seguridad. Disciplina, no setup-and-forget
5. **Anti-bot avanzado (Cloudflare Bot Management, TikTok/IG agresivo)**: Electron vanilla no es suficiente para detección state-of-the-art. Si el target son redes sociales casuales, sirve. Si es scraping a escala, recomendación cambia a fork Chromium
