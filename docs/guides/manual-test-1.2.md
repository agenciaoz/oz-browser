# Guía — Smoke test manual del Bloque 1.2

**Cuándo correr:** después de cada cambio que toque `identity-manager`, `tabs`, `window-manager`, `sidebar`, `tabstrip` o `identity-editor`. También antes de un release.

**Tiempo:** ~5 minutos.

## ✅ Auto-validado por `tests/identity-manager.smoketest.js`

Estos cubren la lógica core de IdentityManager — corren con `node tests/identity-manager.smoketest.js` (sin Electron, mock-driven). Última corrida: **28/28 passed (2026-05-09)**.

- `_load()` auto-crea Default
- Cap free tier MAX_IDENTITIES_FREE=3 exacto
- `OZ_TIER=paid` bypassa cap
- `update()` patch con whitelist (`name`, `color`, `userAgent`)
- Default rechaza `userAgent` (ADR 0010)
- `getSession()` routing: Default → defaultSession, otras → partition
- `getSession()` aplica `setUserAgent` al crear partition con UA custom
- `update(userAgent)` aplica `setUserAgent` en vivo a session cacheada
- Default `getSession` NO llama `setUserAgent` (proteger extensions)
- `remove()` no permite borrar Default
- Persistencia round-trip de `identities.json`

Las secciones de abajo cubren lo que NO se puede automatizar sin GUI: el modal, el sidebar, lazy materialization, y el bug "tab duplicada al arranque".

**Setup:**
```bash
cd "/Users/joserodrigocoronel/Documents/Claude/Projects/Ghost Browser Clone/oz-browser"
NODE_ENV= SHELL_DEBUG=1 npm start
```

`SHELL_DEBUG=1` abre DevTools y agrega logging extra. `NODE_ENV=` (vacío) es necesario por el shell config de Jose (heredado de Etapa 0).

**Log file (si falla algo, copiarlo):**
`~/Library/Logs/OZ Browser/oz-browser.log`

---

## Checklist

### A. Arranque limpio

- [ ] App arranca sin error popup.
- [ ] Hay UNA tab eager (no dos). Verificar:
  - El sidebar muestra UNA tab debajo de "Default" (`(1)` count en la row).
  - El topbar tabstrip muestra UNA tab.
  - En `oz-browser.log` hay UNA línea `INFO [tabs] tab created` con `source=window-manager._createInitialTab`. **Si hay otra inmediatamente después con otro `source`, ese es el bug a investigar — el source apunta al culpable.**
- [ ] Cold start `< 2 segundos` desde click hasta primer pixel del WebUI (verificar visual; si dudas, agregar `console.time` temporal en `Browser.init`).

### B. Default Identity siempre visible

- [ ] Borra `~/Library/Application Support/OZ Browser/identities.json` y reinicia.
- [ ] El sidebar muestra "Default" como row con dot trailing y chip gris claro.
- [ ] `(1)` aparece al lado del nombre (la initial tab cuenta).

### C. Crear / editar / borrar identity

- [ ] Click en "+ New Identity", escribe "Test 1", Enter. Aparece en sidebar con `(0)`.
- [ ] Right-click en "Test 1" → menú aparece con Rename / Edit identity… / Delete identity.
- [ ] "Edit identity…" abre el modal. Cambia color, escribe en User-Agent custom (e.g. `Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36`), Save.
- [ ] El chip de "Test 1" cambia al color elegido.
- [ ] Right-click en Default → "Edit identity…" → modal abre, campo UA está deshabilitado y hint dice "Default Identity uses the shared session…".
- [ ] Right-click en "Test 1" → Delete → confirm → desaparece del sidebar.

### D. Lazy tab dentro de identity custom MATERIALIZA al click (validation crítica)

1. Crea identity "LazyTest".
2. En el sidebar, hover sobre "LazyTest" row → aparece botón `+` → click. Abre `about:blank` lazy.
3. Verificar: tab aparece bajo "LazyTest" en italic gris (`.lazy` class). `(1)` count ya está.
4. En log: una línea `INFO [tabs] tab created` con `source=ipc.openInIdentity`, `eager=false`.
5. Click en la tab. Debería:
   - Quitar el italic / muted style.
   - Cargar `about:blank` (página en blanco visible en el content area).
   - En log: `INFO [tabs] tab materialized` con duration ms.
6. **Si el tab no carga:** la materialización falla. Revisar que `Tab.materialize` no haya throwed (busca `ERROR` en log).

### E. Custom User-Agent funciona

1. Identity "UATest" con UA = `Mozilla/5.0 OZ-TEST-UA`.
2. Abre tab en UATest, navega a `https://httpbin.org/user-agent`.
3. La página debe responder `{"user-agent": "Mozilla/5.0 OZ-TEST-UA"}`.
4. Edita la identity, vacía el UA (botón "Use default"), Save.
5. Reload el tab → la respuesta debe volver al UA de Chromium (sin "OZ-TEST-UA").

### F. Free-tier cap

1. Por default `OZ_TIER` no está seteado → cap activo.
2. Crea Identity 1, 2 (Default + 2 = 3, cap hit).
3. Intentar crear Identity 3 → alert("Free tier limit reached…").
4. Restart con `OZ_TIER=paid npm start` → la creación procede sin error.

### G. Persistencia

1. Con varias identities y tabs, cerrar la app (Cmd+Q).
2. Volver a abrir → identities persistidas (verifica nombres / colores / UAs).
3. Tabs NO persisten todavía (eso es Bloque 1.3 con workspaces). Verifica que arranca limpio con la initial tab.

---

## Si algo falla

1. **Copia las últimas ~100 líneas del log:**
   ```bash
   tail -100 "~/Library/Logs/OZ Browser/oz-browser.log"
   ```
2. **Anota qué hiciste** (paso del checklist).
3. **Screenshot del estado** (sidebar + content area + DevTools si aplica).
4. **Pasar a Claude** los 3 anteriores. El log con los `source=` de cada `tab created` permite trace exacto.

## Próximos automation steps (no en este bloque)

- Bloque 1.10 polish: convertir esta guía en tests Playwright-electron o Spectron.
- CI: correr smoke test en cada push a `main`.
