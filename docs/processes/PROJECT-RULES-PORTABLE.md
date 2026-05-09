# Reglas portables — checklist para proyectos serios

> Compilado de las decisiones que hemos tomado en OZ Browser. Llévate este doc a cualquier proyecto futuro y aplícalas desde el día 1. La diferencia entre un proyecto que sobrevive 6 meses y uno que se hunde está acá.

Este es un cheat-sheet ejecutable. Cada regla tiene **por qué** + **cómo aplicarla**.

---

## A. Documentación (sin esto, los proyectos grandes mueren)

### A1. La documentación es código de primera clase
**Por qué:** sin doc, en 3 meses ni tú entiendes qué hace tu propio código. Con un colaborador, en 3 días.
**Cómo:** carpeta `docs/` con sub-carpetas `architecture/`, `modules/`, `features/`, `guides/`, `processes/`, `history/`. Cada una con su `README.md` que indexa el contenido.

### A2. Toda decisión arquitectónica tiene un ADR
**Por qué:** prevenir re-debate al mes siguiente. La decisión queda escrita con sus alternativas y consecuencias.
**Cómo:** `docs/architecture/NNNN-titulo.md` numerado secuencial. Plantilla: Estado / Contexto / Decisión / Alternativas consideradas / Consecuencias / Referencias. Estado va de "Propuesto" → "Aceptado" → "Reemplazado por NNNN".

### A3. Cada módulo de código tiene su `.md` hermano
**Por qué:** cuando vuelves a un módulo a los 2 meses, el `.md` te ahorra reverse-engineering.
**Cómo:** por cada `src/foo.js` → `docs/modules/foo.md` con: qué hace, exports, IPC channels (si aplica), dependencias, gotchas, ejemplos. Plantilla en DOCUMENTATION-RULES.md.

### A4. Cada feature transversal tiene su doc end-to-end
**Por qué:** features cruzan módulos; el doc del módulo no captura el flujo completo.
**Cómo:** `docs/features/<feature>.md` con caso de uso, UI, modelo de datos, persistence, security, performance, módulos involucrados.

### A5. Cada hito cerrado deja un resultado en `history/`
**Por qué:** la bitácora del proyecto. Cuando vuelves a leer cómo se cerró Bloque 1.2, lo encuentras de un vistazo.
**Cómo:** al cerrar un bloque/etapa, `docs/history/<bloque>-resultado.md` con qué se entregó, issues resueltos, costos, próximo paso. Si no escribes esto, el bloque NO está cerrado.

### A6. Headers consistentes en cada archivo de código
**Por qué:** primer thing que ve quien abre el archivo. Le dice qué módulo es, dónde está su doc, qué exporta.
**Cómo (template):**
```js
// PROJECT — <nombre del módulo>
//
// Qué hace: <una frase>
// Doc: docs/modules/<nombre>.md
// ADRs: docs/architecture/...
//
// Exports: <lista>
// IPC: <lista o "none">
```

### A7. Commits explican el porqué, no solo el qué
**Por qué:** el diff dice qué cambió; el body dice por qué fue necesario y qué consideró.
**Cómo:** subject < 72 chars, imperativo. Body con porqué + alternativas si la decisión es no-obvia. Tags útiles: `Bloque X.Y:`, `Etapa N:`, `Docs:`, `Refactor:`, `Fix:`, `Perf:`, `Chore:`.

---

## B. Modularidad

### B1. Ningún archivo de código > 500 LOC
**Por qué:** archivos chicos son leíbles. Para Claude Cowork, leen sin offset. Para humanos, comprensión rápida.
**Cómo:** si un módulo crece más de eso, se divide en submódulos coherentes. Convención de naming: `<feature>-manager.js` (CRUD), `<feature>-handlers.js` (IPC), `<feature>-setup.js` (wiring), `<feature>-utils.js` (helpers). NO usar la excusa "es conceptualmente unitario" — se divide igual.

### B2. Un módulo, una responsabilidad
**Por qué:** módulos con múltiples responsabilidades son difícil de testear, mover, refactorear.
**Cómo:** si un módulo tiene > 1 razón para cambiar, dividirlo. Test rápido: ¿el nombre del archivo describe UNA cosa? Si necesitas "y" en el nombre, son 2 archivos.

### B3. Naming consistente
**Por qué:** disminuye carga cognitiva.
**Cómo:** kebab-case para archivos (`identity-manager.js`), camelCase para variables, PascalCase para clases. Sufijos por rol: `-manager`, `-handlers`, `-setup`, `-utils`, `-client`. IPC channels namespaceados: `proyecto:dominio:accion`.

### B4. Módulo público != módulo privado
**Por qué:** evita acoplamiento innecesario.
**Cómo:** módulos solo exportan lo necesario. Funciones internas no se exportan. `module.exports = { thing }` explícito en CommonJS, named exports en ESM.

---

## C. Logging y Error Handling

### C1. TODO se loggea
**Por qué:** sin logs, debug = adivinanza. Con logs robustos, reconstruyes lo que pasó.
**Cómo:** logger central con niveles DEBUG/INFO/WARN/ERROR. Cada operación crítica al menos un INFO con source + id + outcome + duration. Cada IPC handler entrada (DEBUG) + salida (INFO + duration).

### C2. Niveles tienen significado claro
**Por qué:** filtrar por nivel debe ser útil.
**Cómo:**
- `DEBUG` — datos diagnósticos (parámetros, IDs, latencias) — filtrado en prod por default
- `INFO` — eventos del lifecycle (app start, entity created, sync done)
- `WARN` — anomalías recuperables (proxy lento, retry, fallback)
- `ERROR` — fallas reales (excepciones, IPC errors)

### C3. Storage rotativo en archivo
**Por qué:** consola se pierde al cerrar. El log queda.
**Cómo:** logger escribe a `~/Library/Logs/<App>/<app>.log` (o equivalente) con rotación a 10 MB y retención de 3 archivos viejos. Usa `fs.createWriteStream` con flag `'a'`.

### C4. Privacy filters automáticos
**Por qué:** un log con un password leakeado es un incidente de seguridad.
**Cómo:** regex automáticos antes de write: `password=\S+` → `password=[REDACTED]`, `Bearer \S+` → `Bearer [REDACTED]`, `Cookie: \S+` → `Cookie: [REDACTED]`, `apikey=\S+` → `apikey=[REDACTED]`. Tests del filtro en CI.

### C5. Métricas periódicas
**Por qué:** tendencias > snapshots. Si la RAM crece linealmente, lo ves.
**Cómo:** cada 30s un log DEBUG con `{ramRSS, ramTotal, cpuUsage, customMetrics}`. En proyectos grandes, un Activity Tracker dedicado.

### C6. Errores no manejados → popup con stack + auto-attach logs
**Por qué:** que cualquier error se entere, no que muera silencioso.
**Cómo:** capturar `uncaughtException`, `unhandledRejection`, `render-process-gone`, `child-process-gone`. Mostrar dialog con botones: **Email developer** (mailto: pre-rellenado con stack + system info + últimas N líneas del log), Copy details, Open log file, Dismiss.

### C7. Renderer errors → main via IPC
**Por qué:** los logs viven en main. Renderer errors deben llegar ahí.
**Cómo:** preload.js inyecta `window.addEventListener('error')` y `'unhandledrejection'` que forwardea via `ipcRenderer.invoke('app:report-error', detail)`.

### C8. Log Viewer in-app
**Por qué:** durante pruebas, abrir Terminal y `tail -f` es fricción. UI in-app es 1 atajo.
**Cómo:** vista accesible con Cmd+Opt+L. Stream live via IPC. Filtros por nivel/source/search. Botones Clear, Copy, Export, Email developer.

### C9. Nunca crashear por logging
**Por qué:** el logger es soporte, no producto. Si el disco está lleno, la app no debe morir.
**Cómo:** todos los `write` envueltos en try/catch que ignora silenciosamente. Logger con métodos resilientes — si init() falla, los métodos siguen funcionando contra console only.

---

## D. Performance

### D1. Define tu hardware target explícito
**Por qué:** "que corra rápido" es vago. "100 tabs en M1 Air 8 GB < 4 GB RAM" es testeable.
**Cómo:** documenta benchmarks objetivo en un ADR. Cada release los valida (gates de CI cuando sea viable).

### D2. Lazy es default
**Por qué:** crear cosas a demanda > precrear.
**Cómo:** en browsers, tabs lazy hasta primer click. En servidores, conexiones lazy. En APIs, datos lazy con paginación. En UIs, virtual scroll.

### D3. Memory pressure handler
**Por qué:** la app no debe ser un heap negro que crece.
**Cómo:** monitorear uso cada 30s. Si > 80% del cap, empezar a liberar (descartar tabs idle, evict cache). Si > 90%, notification al user.

### D4. Cache caps por dominio
**Por qué:** sin cap, cache crece infinito.
**Cómo:** cap por partition/módulo. En Electron: `session.setCacheCapacity(50 MB)`. En backends: LRU configurable.

### D5. Background throttling
**Por qué:** tabs/jobs ocultos no deben gastar CPU igual que activos.
**Cómo:** Chromium ya lo hace; NO deshabilitar. En Node: throttle health checks, batch APIs cuando posible.

### D6. Universal binary nativo (no Rosetta)
**Por qué:** Rosetta = ~30% peor performance + más batería en Apple Silicon.
**Cómo:** `electron-builder` con `mac.target = 'universal'`. Verificar todos los C++ addons soportan arm64. Lista checked: keytar ✅, sqlite3 ✅, sharp ✅.

---

## E. Seguridad y Persistencia

### E1. Secretos en Keychain, no en disco
**Por qué:** disco se lee con permisos básicos; Keychain requiere user prompt o app firmada.
**Cómo:** `keytar` para macOS Keychain. Master keys derivadas con scrypt/argon2. Nunca commitar `.env` con secretos.

### E2. AES-256-GCM para data at rest
**Por qué:** GCM tiene auth tag (resistente a tampering). 256 = futuro-prueba.
**Cómo:** Node's `crypto.createCipheriv('aes-256-gcm', key, iv)`. Salt único per archivo (32 bytes random). IV per write (12 bytes random). Almacenar `{version, salt, iv, ciphertext, tag}`.

### E3. Master password derivation
**Por qué:** un user-typed password no es 32 bytes uniformes.
**Cómo:** `scrypt(password, salt, N=2^17, r=8, p=1)` → 32 bytes. ~1 segundo derivation = brute-force resistente offline.

### E4. Backup automático antes de operaciones destructivas
**Por qué:** el "deshacer" del usuario debe estar incluido.
**Cómo:** snapshot del estado actual (cifrado) antes de OVERWRITE/bulk-delete/restore. Time Machine retention configurable.

### E5. Snapshots periódicos automáticos
**Por qué:** Time Machine real. Permite volver a "ayer" cuando algo se rompe.
**Cómo:** cron interno daily 3am. Compresión zstd. Encriptados con master key. Retention 30 días default, custom configurable.

### E6. .gitignore exhaustivo
**Por qué:** un commit con un secret es un incidente.
**Cómo:** ignorar `node_modules/`, `.env*` (excepto `.env.example`), `data/`, `*.proxies.json`, `vault.enc`, `*.p12`, `*.cer`, `.webpack/`, `dist/`, archivos de OS (`.DS_Store`).

### E7. Tokens API never logged
**Por qué:** filtros automáticos del logger los enmascaran, pero principio extra: NO los pongas en mensajes.
**Cómo:** logger filtra `Bearer xxx`, `apikey=xxx`. Pero también: en código, log `'auth ok'` no `'auth ok with token <token>'`.

---

## F. Sync y Storage

### F1. Backend de sync pluggable
**Por qué:** SaaS público + office self-hosted + enterprise S3 = 3 casos. Hardcodear uno fuerza a otros a sufrir.
**Cómo:** interfaz `SyncBackend` con `init/push/pull/list/delete`. Implementaciones por backend (Supabase, Dropbox, S3, Off). User elige.

### F2. E2E encryption client-side, NUNCA en backend
**Por qué:** el backend es agnóstico. Tu vault no debe ser legible por nadie aunque sean dueños del backend.
**Cómo:** cliente cifra antes de subir. Backend solo ve blobs. Master key en Keychain del cliente, NO en backend.

### F3. Conflict resolution explícito
**Por qué:** sin política, multi-device sync = datos corruptos.
**Cómo:** v1 = last-write-wins por record (timestamp del cliente). v2 = vector clocks. Anotar política en ADR.

### F4. Schema versioned
**Por qué:** quieres poder migrar el formato de datos sin romper backups viejos.
**Cómo:** todo blob/archivo persistido tiene `version: N` field. Migrations idempotentes para v[N-1] → v[N]. Tests de migración en CI.

### F5. Datos del user separados del código
**Por qué:** si reset de la app, no perdés cuentas; si update, no romper data.
**Cómo:** `app.getPath('userData')` para datos. `app.getPath('logs')` para logs. NUNCA escribir en directorio de la app instalada.

---

## G. UX y Patrones

### G1. IPC channels namespaceados
**Por qué:** evita colisiones, agrupa por dominio, fácil grep.
**Cómo:** `<proyecto>:<dominio>:<accion>`. Ej: `oz:identities:create`, `oz:tabs:select`, `oz:nav:back`.

### G2. Bridge único `window.<proyecto>` en preload
**Por qué:** el renderer NUNCA llama Node directo. Toda la API pasa por contextBridge.
**Cómo:** `contextBridge.exposeInMainWorld('oz', { identities: {...}, tabs: {...}, log: {...} })`. Filtrar exposure por URL (solo browser chrome, no páginas web).

### G3. Renderer errors → reportError IPC
**Por qué:** unificar el manejo en main.
**Cómo:** preload expone `window.<proyecto>.log.reportError(detail)` que `ipcRenderer.invoke('app:report-error', detail)`.

### G4. Inline editors en lugar de prompt()
**Por qué:** Electron bloquea `window.prompt()` por seguridad. Y los nativos rompen el flow.
**Cómo:** input HTML inline en el botón/row donde se inicia. Enter commit, Escape cancela, blur commit.

### G5. Idioma del producto
**Por qué:** consistencia.
**Cómo:** decide al inicio del proyecto: idioma interno (comments, logs, UI dev) vs idioma producto (UI users). Documenta. En OZ Browser: español interno + inglés para SaaS público.

---

## H. Workflow / Process

### H1. ADR antes del código (cuando aplica)
**Por qué:** prevenir trabajo tirado. Si la decisión cambia, mejor descubrirlo en el ADR que después de 2 días de código.
**Cómo:** decisión arquitectónica → ADR primero (estado "Propuesto") → revisar → "Aceptado" → ejecutar.

### H2. Doc del módulo antes del módulo
**Por qué:** te obliga a pensar la API antes de escribir.
**Cómo:** crea `docs/modules/<nuevo>.md` con stub: qué hace, exports, IPC. Después implementas.

### H3. Resultado del bloque al cerrarlo
**Por qué:** sin esto, "cerré el bloque" = "creo que cerré el bloque".
**Cómo:** último commit del bloque incluye `docs/history/<bloque>-resultado.md` con: qué se entregó, issues, costos, próximo. Sin eso, bloque NO está cerrado.

### H4. Validar antes de commitear
**Por qué:** commits que rompen main desperdician tiempo de todos.
**Cómo:** mínimo: la app arranca. Mejor: tests pasan. Para un solo dev, mínimo. Para team, gate de CI.

### H5. Branch strategy progresiva
**Por qué:** al inicio basta `main`. Cuando hay múltiples streams, branches.
**Cómo:** Phase 1 (solo dev): commit a main. Phase 2 (multiple features paralelos): feature branches → PR → merge a main. Phase 3 (releases): main + release branches.

### H6. Commits atómicos
**Por qué:** facilita revert.
**Cómo:** 1 commit = 1 cambio coherente. Si necesitas "y" en el subject, son 2 commits.

### H7. Git hooks o CI gates
**Por qué:** humanos olvidan; máquinas no.
**Cómo:** pre-commit: lint + test rápido. CI: build + tests + lint + type check. Etapa avanzada: análisis estático (eslint security, semgrep).

---

## I. Stack tech (decisiones que se replican bien)

### I1. Electron para apps desktop con UI compleja
**Por qué:** time-to-MVP imbatible. Cross-platform. Comunidad grande.
**Cuándo NO:** apps gaming, apps con requisitos de RAM <100 MB, apps que necesitan native widgets puros (Tauri es alternativa).

### I2. electron-forge + webpack
**Por qué:** sign+notarize+universal binary out-of-the-box. Plugin webpack maneja main + renderer + preload coherentemente.

### I3. Node v18+ runtime
**Por qué:** ES modules, fetch nativo, web crypto, performance bumps.

### I4. SQLite para storage local con persistence
**Por qué:** built-in, sin servidor, transacciones, queries SQL.
**Cuándo:** > 1000 records persistentes. Para < 1000, JSON file es más simple.

### I5. macOS Keychain para secretos
**Por qué:** integrado al SO, encriptado al disco con touch ID, requiere user prompt.
**Cómo:** `keytar` npm package.

### I6. Supabase para backend SaaS
**Por qué:** auth + Postgres + Edge Functions + Storage en un solo provider, free tier generoso.
**Alternativas:** Pocketbase (self-hosted), Firebase (Google lock-in), AWS Amplify (más complejo).

### I7. Stripe para billing
**Por qué:** developer-friendly, customer portal built-in, hooks para gateo de features.

### I8. Vercel para marketing site
**Por qué:** Next.js native, free tier, edge deployment, integración con GitHub.

### I9. GitHub para repo + CI/CD
**Por qué:** Actions free para repos públicos / 2000 min/mes privados, code review, releases con auto-update integration.

### I10. SheetJS / exceljs para Excel I/O
**Por qué:** maduros, compat Excel + LibreOffice + Google Sheets.

---

## J. Anti-patrones a evitar

### J1. ❌ "Por ahora hardcodeo, después refactoreo"
Usualmente no se refactorea. Configurable o constantes nombradas DESDE el principio.

### J2. ❌ Logging selectivo "solo lo importante"
Lo importante se sabe DESPUÉS del bug. Loggea todo, filtra al leer.

### J3. ❌ Console.log en producción
Sin niveles, sin filtros, sin file rotation, sin search. Usa logger estructurado.

### J4. ❌ Catch que se traga errores
```js
try { ... } catch (_) { /* nothing */ }
```
Si decides ignorar un error, log al menos `WARN` con el motivo.

### J5. ❌ Nombres genéricos: `manager.js`, `helper.js`, `utils.js`
OK como sufijo (`identity-manager.js`), no como nombre completo. Si tu archivo se llama `utils.js` y tiene 8 funciones no relacionadas, divídelo.

### J6. ❌ "No aplico la regla 500 LOC porque mi módulo es especial"
Las "excepciones" siempre crecen. Divide.

### J7. ❌ Documentar al final del proyecto
La doc final es siempre incompleta y ya nadie tiene contexto fresco. Documenta conforme construyes.

### J8. ❌ Una sola persona conoce el sistema completo
Si tú te enfermas y nadie más entiende el código, el proyecto está en riesgo. Mitigación: la doc + ADRs son ese conocimiento externalizado.

### J9. ❌ "Después le pongo logs"
Loguea desde el primer commit. Reformatear logs después es agregar 50 líneas en cada función.

### J10. ❌ Sin .gitignore desde el día 1
Un commit con un secret es un incidente. `.gitignore` es lo segundo que se hace después de `git init`.

---

## K. Checklist al iniciar proyecto nuevo

```
[ ] git init + .gitignore exhaustivo
[ ] README.md con propósito + quick start
[ ] docs/ con README index
[ ] docs/architecture/ + ADR 0001 con stack tech elegido
[ ] docs/DOCUMENTATION-RULES.md (este checklist sirve de plantilla)
[ ] logger module + error-handler module
[ ] Header consistente en cada .js
[ ] Tests setup (aunque sea con un test trivial)
[ ] CI básica (build + lint + tests si existen)
[ ] Definir hardware target en ADR
[ ] Definir naming conventions (kebab/camel/Pascal, sufijos)
[ ] Decidir idioma del proyecto (interno + producto)
[ ] Storage paths definidos (donde van datos del user, logs, cache)
[ ] Política de secretos (Keychain / env vars / vault encriptado)
[ ] Política de privacy (qué se loggea, qué nunca)
[ ] Schema versioning desde el primer modelo de datos
[ ] Backup/restore path planeado (aunque la implementación venga después)
```

---

## Origen y mantenimiento

Este doc nace del proyecto OZ Browser (clon de Ghost Browser). Se actualizó sobre la marcha conforme tomamos decisiones. Para mantenerlo vivo:
- Cuando una regla se demuestre incorrecta o suboptima → actualízala con justificación.
- Cuando descubras una regla nueva → agrégala con su por qué.
- No es prescriptivo absoluto: cada proyecto tiene contexto. Pero si vas a saltar una regla, escribe POR QUÉ — el costo de skipear sin justificación es la deuda técnica.

**La diferencia entre un proyecto que sobrevive y uno que se hunde es disciplina con estas reglas.**
