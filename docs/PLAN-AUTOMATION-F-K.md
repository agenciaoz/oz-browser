# PLAN AUTOMATION F → K — Roadmap v2 OZ Browser

> **DECISIÓN 2026-05-13 (Jose):** todo este plan queda para **versión 2** del producto. La v1 va sin el bloque F-K expandido — sale antes con el feature set Ghost-clone ya cerrado (CORE 1A + C + D + E) para generar revenue y feedback. v2 sube como upgrade pago dirigido a agencias.
>
> Documento en estado **REVISIÓN ACTIVA**. Estamos iterando contenidos antes de aprobar para implementación post-v1.
>
> Plan completo del bloque F Automation Engine + bloques nuevos G/H/I/J/K que lo soportan operacionalmente. Fecha de primera versión: 2026-05-13.

## Use case ancla

Agencia transnacional de community management que opera 100+ cuentas Twitter (luego IG) en nombre de clientes con consent explícito. Objetivo: coordinar acciones a escala (replies, threads, amplificación de posts del cliente) manteniendo cada cuenta indistinguible de un humano para evitar shadowbans y suspensiones.

## Decisiones bakeadas (2026-05-13)

1. **Scope**: MVP completo agencia (F + G + H + I + J + K) — ~95-101h dev.
2. **LLM**: endpoint cloud propio de la agencia (self-hosted vLLM o similar). OZ tiene adapter HTTP configurable. La agencia controla infra + auditabilidad. Costo agencia: ~$100-300/mes server.
3. **Shadow ban detection**: re-check permanente vía cuenta observer cada N horas. Más caro pero confiable.
4. **Paranoia operacional**: nivel MEDIO. Warmup 7d obligatorio, health score visible NO bloqueante, circuit breakers en 20% threshold.
5. **Modelo operacional**: **Single-operator runs por Mac**. Cada operador en su Mac maneja sus propias cuentas. NO hay approval queues ni locks cross-team durante runs. Owner/SuperAdmin tiene **vista read-only agregada** de toda la actividad del team vía Dropbox shared folder con audit logs encriptados (reusa Team mode E ya construido). Roles solo `Operator` y `SuperAdmin`.

## Defaults operacionales del producto

| Setting                 | Default                                       | Razón                            |
| ----------------------- | --------------------------------------------- | -------------------------------- |
| Concurrency cap         | 8 tabs paralelas                              | Sweet spot M-series sin saturar  |
| Spread temporal         | 30-90s entre identities, con jitter ±20%      | Evita ráfagas detectables        |
| Skip rate aleatorio     | 12%                                           | Realismo + no 100% participation |
| Cap diario per identity | 30 acciones/día (configurable per workspace)  | Conservador para reply-heavy use |
| Warmup obligatorio      | 7 días desde creación de cuenta               | Account-age threshold seguro     |
| Cooldown post-captcha   | 24h por defecto, 48h si fue acción específica | Estándar industria               |
| Cooldown post-block     | 7 días                                        | Conservador                      |
| Circuit breaker global  | 20% captcha rate en 1h → emergency stop       | Protección de flota              |
| Shadow ban re-check     | Cada 6h por threads activos < 24h             | Balance cost/coverage            |

---

# Bloque F — Automation Core (~35h)

## F-0 Validación visual D-3c-3c sync (~30 min)

**Yo**: repaquetar `.app` con D-3c-3c, boot, curl los 3 tools sync, screenshot Settings → Sync, repaquetar `.dmg`.

**Tu lado (~5 min)**: instalar `.dmg`, Cloud Backup → Connect Dropbox → Settings → Sync → toggle Enable. Reportar logs.

**Salida**: Bloque D Dropbox Sync 100% cerrado.

## F-1 ActionRunner Core (~7-8h)

**Módulos**:

- `browser/action-runner.js` (~400 LOC): motor de steps secuenciales.
- `browser/human-jitter.js` (~150 LOC): Box-Muller latency, bezier cursor, typing patterns, idle simulation.
- `browser/action-runner-handlers.js` (~80 LOC): handler map IPC+MCP.
- `browser/mcp-tools-automation.js` (~80 LOC): tools básicas `oz.automation.runSteps`.

**Step types soportados v1**:
`navigate`, `waitFor`, `humanClick`, `humanType`, `scrollRandom`, `captureSuccess` (multi-strategy: selector | urlChange | webRequest hook | DOM mutation), `pause`, `assertNoCaptcha`, `assertNoBlockedAction`, `screenshot` (opcional para audit), `llmGenerate` (placeholder — implementado en I).

**Multi-strategy captureSuccess**:

```js
{ type: 'captureSuccess', strategies: [
  { type: 'urlChange' },
  { type: 'webRequest', endpoint: '/i/api/graphql/.*/CreateTweet', status: 200 },
  { type: 'domMutation', selector: '[data-testid="toast"]', textContains: 'Your post was sent' },
  { type: 'proofOfLife', delaySec: 30, selector: 'thread reply with text {commentText}' },
], minStrategies: 2 }  // necesita al menos 2 confirmaciones
```

**Tests**: ~100 con fakes de `webContents.executeJavaScript`.

## F-2 Recipes engine + X recipe MVP + Spintax básico (~4h)

**Módulos**:

- `browser/recipe-engine.js` (~120 LOC): carga + valida + ejecuta recipes.
- `browser/recipes/` directorio con JSON por (red, acción).
- `browser/spintax.js` (~80 LOC): parser de `{opt1|opt2|opt3}` con nesting + variables `{{commentText}}`.
- `browser/recipes/x/comment-on-post.recipe.json`: primera recipe validada vs Twitter web.

**Schema de recipe**: ver `docs/architecture/0028-recipe-schema.md` (a crear).

## F-3 Scheduled Actions (~3-4h)

Originalmente "Bloque F simple". Reusa F-1.

**Módulos**: `browser/scheduled-actions.js`, `browser/scheduled-actions-handlers.js`, `browser/ui/scheduled-actions.js`.

**UI**: modal "Schedule Action" con dropdown recipe + cron expression + target + enable toggle.

**Use case real**: "9am weekdays, abrir workspace cliente IG, refresh + check needs_relogin, notify si alguno."

## F-4 Bulk Orchestrator + Cooldown Registry + Rate-limit Budgets + Resume (~7-8h)

**Módulos**:

- `browser/bulk-action-orchestrator.js` (~350 LOC): concurrency-limited queue, spread temporal, skip rate, captura resultados, state persistido para resume.
- `browser/cooldown-registry.js` (~150 LOC): registro persistente per-identity. Survives restart. Cooldown types: captcha (24h), action-blocked (48h), rate-limit (variable), shadow-ban (manual clear), suspension (indefinido).
- `browser/rate-limit-registry.js` (~100 LOC): trackea per-identity per-action counts daily/weekly. Auto-reset al cambio de día.
- `browser/run-state-manager.js` (~120 LOC): persiste state per run en `userData/runs/<runId>.json`. Resume al reboot OZ. Auto-resume si run quedó "in-progress" 5+ min sin actividad.
- `browser/bulk-action-handlers.js` (~80 LOC).
- `browser/ui/automate.js` (~500 LOC): modal 7 pasos + preview + live progress + reportes.

**Error matrix completa**:

```js
const ERROR_HANDLERS = {
  CAPTCHA: { cooldownHours: 24, abortRun: false },
  ACCOUNT_SUSPENDED: { cooldownHours: -1, abortRun: true, alert: 'urgent' },
  RATE_LIMIT_SOFT: { cooldownHours: 4, abortRun: false },
  RATE_LIMIT_HARD: { cooldownHours: 24, abortRun: false },
  TWO_FA_CHALLENGE: { cooldownHours: 0, abortRun: false, alert: 'manual-intervention' },
  EMAIL_VERIFICATION: {
    cooldownHours: -1,
    abortRun: false,
    alert: 'manual-intervention',
  },
  PHONE_VERIFICATION: {
    cooldownHours: -1,
    abortRun: false,
    alert: 'manual-intervention',
  },
  POLICY_VIOLATION: { cooldownHours: 0, abortRun: false, alert: 'review-content' },
  TWEET_DELETED: { cooldownHours: 0, abortRun: true, alert: 'low' },
  REGION_RESTRICTED: { cooldownHours: 0, abortRun: false, alert: 'review-proxy' },
  SHADOW_BAN_SUSPECTED: { cooldownHours: 0, abortRun: false, alert: 'high' },
  USER_BLOCKED: { cooldownHours: 0, abortRun: false, alert: 'low' },
}
```

**Dry run mode**: toggle pre-run. Simula todos los steps sin ejecutar. Loggea como si los hubiera hecho. Útil para validar config antes de tirar 500 cuentas reales.

## F-5 Validación X live con cuentas reales (~1h tuyo + asistencia mía)

- 3 cuentas → 10 → 30 → 100+.
- Watch logs en vivo + screenshots.
- Si captcha → investigar (proxy ASN? account-age? fingerprint mismatch?).
- Salida: X comments en producción validado.

## F-6 IG recipe (~6-8h)

- `instagram/comment-on-post.recipe.json`.
- ContentEditable IG ≠ Draft.js X → ajustes en `humanType`.
- Stable-XPath fallbacks (selectores IG cambian frecuente).
- Cookie-bound login detection (reuso 1.5d).
- Toast capture via DOM mutation del comments list.
- Defaults conservadores: concurrency 5, spread 60-180s, skip 18%.

## F-7 Action Recorder visual (~5h, CRÍTICO)

- UI: botón "🎬 Record Recipe" en Automate modal.
- Captura interacciones via `webContents.on('input-event')` + heurística de selectores estables.
- Genera recipe JSON candidata + editor para ajustar fallbacks.
- Diferenciador masivo vs AdsPower/Multilogin/Ghost.

---

# Bloque G — Operations & Compliance (~22h)

## G-1 Multi-Client Isolation (~5h)

**Módulos**:

- `browser/client-manager.js` (~200 LOC): tag identities con `client:<name>`, tag workspaces, proxy pools aislados per cliente.
- `browser/ui/client-config.js`: setup wizard cliente nuevo (name, voz, content rules, quotas, operadores autorizados).

**Persistencia**: `userData/clients.json` con `[{id, name, contractStart, quotaMonthly, contentPolicy, allowedOperators, proxyPool}]`.

**Reportes**: filtros por cliente en TODAS las superficies (dashboards, exports, logs).

## G-2 Roles + SuperAdmin View (~1.5h)

**Modelo simplificado** (decisión 2026-05-13): single-operator runs por Mac, sin approval queues. Cada operador es self-contained en su Mac.

**Roles**: solo dos.

| Rol            | Qué puede hacer                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**   | Operar TODAS las features en SU Mac: identities, automations, recipes, clients, sus propios audit logs                                                                                                                          |
| **SuperAdmin** | Todo lo de Operator + **toggle "View all team activity"** que descifra audit logs de TODOS los operadores del team vía Dropbox shared folder. **Read-only** sobre operaciones ajenas — no puede ejecutar runs en Macs de otros. |

**SuperAdmin mecánica**:

- Reusa Team mode E ya construido (Curve25519 ECIES key sharing).
- Audit logs de cada operador se suben a `/Apps/OZ Browser/team/audit/<operator>/<YYYY-MM>.jsonl.enc` encriptado con team masterKey.
- SuperAdmin abre "📊 Team Activity" → OZ baja todos los logs del Dropbox shared, descifra con team masterKey, agrega vista.
- Privacy boundary: ver QUÉ se hizo, no ejecutar acciones ajenas. Si SuperAdmin quiere algo, contacta al Operator.

**Sin approval queue** — operadores experimentados manejan sus propios límites. Failsafes globales (G-5) protegen contra accidentes a nivel cuenta, no a nivel rol.

## G-3 Audit Log Encriptado + Export (~5h)

**Módulo**: `browser/audit-log.js` (~250 LOC).

**Cada acción registra**:

- timestamp ISO
- run_id
- identity_id, identity_name
- client (resolved from tags)
- action_type (comment, like, retweet, follow, etc.)
- target_url
- text_posted (full)
- result (success / captcha / blocked / error)
- duration_ms
- proxy_used
- optional screenshot path (encrypted)
- operator_id (who triggered the run)

**Storage**: `userData/audit/<YYYY-MM>.jsonl` encriptado con master key del Vault (AES-256-GCM, mismo formato D-1).

**Retención configurable per cliente**: 90d / 1y / forever.

**Exports**:

- CSV por cliente y rango fecha (para facturación + reporting cliente).
- PDF compliance report con resúmenes + samples (para audit legal).

## G-4 Quotas + Billing Tracking (~3h)

**Per cliente**: contract quota mensual (ej 500 comments/mes). OZ trackea uso, alerta 80%, auto-stop al alcanzar.

**Per operador**: opcional time-tracking de quién dispara qué runs (billable hours).

**Dashboard**: "Cliente X: 347/500 comments este mes, 71%, alert al 400".

## G-5 Failsafes + Kill Switch (~2h)

- Circuit breakers configurables.
- Kill switch global (1 click pause TODOS los runs activos de TODOS los workspaces).
- Auto-pause si X anuncia API change (manual flag desde Settings).
- Account auto-cooldown: 3 captchas + 5 errors en 24h → auto-pause 7 días.

## G-6 OS Notifications triadas (~1h)

Reemplaza el sistema actual de OS notifications con triage:

- **Urgent** (banner sticky): account suspended, kill switch triggered, captcha cascade detected.
- **High** (banner 10s): manual intervention required, shadow ban suspected.
- **Info** (panel only): run completed, daily summary, account graduated to active.

---

# Bloque H — Account Lifecycle Management (~17h)

## H-1 Account Warmup Automation (~6h)

**Recipe nueva**: `<platform>/warmup-account.recipe.json`. Steps:

- Días 1-2: navigate to feed + scroll for 5-10 min, no interactions.
- Días 3-4: like 3-5 posts per day (random selection).
- Días 5-7: follow 5-10 relevant accounts + like 8 posts + read profile pages.
- Día 8+: graduate to "ready for production".

**`browser/account-warmup.js`** (~200 LOC): daemon que corre warmup steps automáticamente para cuentas en estado `warming`.

**Account states**: `new` → `warming` → `ready` → `active` → (optional: `paused` / `suspended` / `retired`).

**UI**: dashboard "47 active, 12 warming (3 ready in <2 days), 5 paused" con drill-down.

## H-2 Account Health Score (~3h)

**Score 0-100 per identity** computado de:

- Account age (older = better).
- Success rate last 30d (>90% green, 70-90% yellow, <70% red).
- Cooldown count last 7d (penalty per cooldown).
- Shadow ban incidents (heavy penalty).
- Captcha rate (penalty).
- Fingerprint diversity (penalty si comparte fingerprint con otra cuenta).

**Visible per identity en sidebar** + dashboard agregado.

**Gating** (configurable): cuentas <60 score → warning at run time, but NOT blocked (paranoia MEDIA).

## H-3 Fingerprint Diversity Audit (~2h)

**Módulo**: `browser/fingerprint-audit.js`.

**Job mensual**: scan TODAS las cuentas, compute clustering de fingerprints (UA + WebGL renderer + canvas noise + locale).

**Alert si**: 2+ cuentas comparten fingerprint hash exacto, o 5+ cuentas clusterean en mismo blueprint+locale.

**Auto-fix sugerido**: "Re-roll fingerprint for these 3 accounts to diversify."

## H-4 Schedule Patterns Realistas (~2h)

**Reemplaza F-3 cron simple con patterns realistas**:

- "Approximately 9am weekdays" → distribución estadística Normal(9, 30min).
- Auto-skip 15% de scheduled runs randomly (humanos no son perfectos).
- Per-account timezone-aware (cuenta @user_jp postea según JST, no UTC).
- Auto-vacation: cada cuenta toma 1 semana off cada 8-12 semanas (random).

## H-5 Multi-Action Workflows (~3h)

**Composables de recipes**:

- `engage-with-post`: like → wait 30s → retweet → wait 2min → comment → wait 5min → follow author.
- `thread-participation`: reply OP → wait 2min → reply to 2-3 existing comments con stagger.
- `friendly-intro`: follow → wait 1min → like 3 recent posts → wait 5min → comment on most recent.

**UI**: modal "Run Workflow" donde combiná múltiples recipes con delays inter-recipe.

## H-6 Shadow Ban Detection Daemon (~1h)

**Módulo**: `browser/shadow-ban-detector.js`.

**Daemon cada 6h**:

- Para cada cuenta que comentó en últimas 24h, abrir el thread desde una "observer identity" (cuenta separada sin login o con cuenta sandbox).
- Verificar que el comment aparece para el observer.
- Si comment falta → flag account `shadow_ban_suspected` (1 strike).
- 3 strikes en 14d → flag `shadow_banned` + pause account.

**Dashboard**: lista de cuentas at-risk con strike count.

---

# Bloque I — Content Generation & Personas (~12h)

## I-1 Spintax + Templates Avanzados (~3h)

**Spintax básico** ya entregado en F-2. Acá agregamos:

- Nested spintax: `{Hola|Saludos {amigo|colega}}` resolves to "Saludos amigo" / "Hola" / "Saludos colega" etc.
- Variable bindings: `{{persona.name}}`, `{{thread.author}}`, `{{post.hashtag[0]}}`.
- Per-template constraints: maxLen, minLen, requiredKeywords, forbiddenKeywords.

## I-2 Persona Profiles per Account (~3h)

**Schema por identity**:

```json
{
  "persona": {
    "ageBracket": "25-34",
    "interests": ["tech", "soccer", "music"],
    "tone": "informal",
    "vocabulary": "spanglish",
    "emojiUsage": "moderate",
    "typicalLength": "medium",
    "engagement": "supportive"
  }
}
```

**Generador de comments** usa persona como input al LLM prompt (Bloque I-4).

## I-3 Per-Client Content Rules (~2h)

**Schema per cliente**:

```json
{
  "contentPolicy": {
    "forbiddenWords": ["competidor1", "competidor2"],
    "requiredDisclaimers": ["#ad"],
    "maxLen": 240,
    "allowedTones": ["formal", "informal"],
    "blockedTopics": ["política", "medical claims"]
  }
}
```

**Pre-post guard** valida CADA comment antes de submit. Si viola → reject + log + alert.

## I-4 LLM Endpoint Integration (~4h)

**Decisión bakeada**: endpoint cloud propio de la agencia (self-hosted vLLM o equivalente).

**Configuración** en Settings → Automation → LLM:

- Endpoint URL (default: env var `OZ_LLM_ENDPOINT`).
- API key (Keychain stored).
- Model name (default: `llama-3.1-70b`).
- Per-client override possible.

**Step nuevo** en recipes:

```json
{
  "type": "llmGenerate",
  "prompt": "Reply to this tweet in the voice of {{persona}}. Tweet: {{thread.text}}",
  "maxTokens": 280,
  "temperature": 0.85,
  "constraints": "no profanity, no @mentions, max 1 emoji",
  "fallback": "use template bank if LLM fails"
}
```

**Cache responses** local (mismo prompt → reuso 24h, ahorra cost agencia).

**Cost tracking**: trackea tokens usados per cliente para facturación interna.

---

# Bloque J — Analytics & Reporting (~12h)

## J-1 Metrics Persistence Layer (~3h)

**Módulo**: `browser/metrics-store.js` (~250 LOC).

**Trackea**:

- Per-account: success rate windows (1d/7d/30d), comments posted, cooldowns triggered, shadow_ban incidents, captcha rate, account_age, health_score history.
- Per-recipe: failure rate, avg duration, success rate.
- Per-proxy: success rate, avg latency, accounts using it.
- Per-client: total reach (likes/replies/retweets of comments), engagement rate, active accounts, at-risk.

**Storage**: `userData/metrics/` con rolling windows + monthly aggregates.

## J-2 Dashboards in-App (~4h)

**3 dashboards principales** (botón sidebar 📊 Analytics):

1. **Operations dashboard**: runs hoy, success rate global, top errors, kill switch status, active alerts.
2. **Account health dashboard**: 100+ cuentas en grid con health_score color-coded, sortable por client/age/score, drill-down.
3. **Client reporting dashboard**: filter by client, totals, trends, top performers.

## J-3 Exports per Cliente (~2h)

- CSV detail (every comment posted with metadata).
- PDF executive summary (gráficos + top stats + samples).
- Slack/email scheduled weekly digest per cliente.

## J-4 A/B Testing de Recipes (~2h)

**Variant A vs B** en mismo run con split 50/50.

**Comparison report** post-run: which variant had higher success rate, less captchas, better engagement.

**Auto-graduation**: si variant B beats A by >10% en 100+ samples → suggest making B the new default.

## J-5 Recipe Health Monitor (~1h)

Daemon que watch recipe failure rates. Si una recipe cae de 95% → 60% success en 24h → alert "Recipe `x/comment-on-post` v3 may be broken. Run F-7 recorder to refresh."

---

# Bloque K — Integrations & Onboarding (~10h)

## K-1 Webhooks Bidireccionales (~3h)

**Outbound webhooks**:

- Cuando un run termina → POST a tu sistema.
- Cuando account flagged → POST con detalles.
- Cuando quota cliente al 80% → alert webhook.

**Inbound webhooks**:

- Tu sistema POST a OZ webhook → OZ dispara run.
- HMAC signature validation.
- Rate limited.

## K-2 Connectors Externos (~3h)

- **Airtable bidirectional**: lista de targets en Airtable → OZ lee y procesa. Cada acción actualiza row en Airtable con result.
- **Google Sheets**: similar.
- **Notion**: targets via Notion DB.
- **Slack notifications**: configurable per cliente, per event type.

## K-3 Public REST API + MCP Público (~2h)

**REST API endpoints** (auth via API key):

- `POST /api/automation/run` → trigger run.
- `GET /api/automation/runs/:id` → status.
- `GET /api/identities` → list (filtered by client).
- `GET /api/metrics/client/:id` → reporting data.

**MCP Server público** (overlap con Bloque M de Etapa 3): habilita LLM agents para drive OZ remoto.

Estos quedan **adelantados** a Etapa 2 porque el use case agencia los necesita desde día 1.

## K-4 Client Onboarding Wizard (~1h)

UI multi-step "Add New Client":

1. Client info (name, industry, contract).
2. Import accounts via Excel 1.5e.
3. Setup proxy pool.
4. Define content policy.
5. Assign operators.
6. Set quota.
7. Configure webhook URLs.

## K-5 Training Material In-App (~1h)

- Tooltips contextuales en cada feature nueva.
- "Try a sample run" en sandbox identity.
- Per-recipe "what does this do" docs.

---

# Cómo encaja en el PLAN-MAESTRO actual

## Etapa 2 — INTERNAL READY revisada

| Bloque                               | Status                              | Estimado              |
| ------------------------------------ | ----------------------------------- | --------------------- |
| A Foundation infra                   | ✅ Cerrado                          | —                     |
| C Quick wins (C-1 a C-8)             | ✅ Cerrado                          | —                     |
| D Backup + Sync                      | ✅ Cerrado (D-3c-3c hoy)            | F-0 cierra validación |
| E Team mode                          | ✅ Cerrado                          | —                     |
| **F Automation Core**                | Próximo                             | **~35h**              |
| **G Operations & Compliance**        | Después de F                        | **~22h**              |
| **H Account Lifecycle**              | Después de F (en paralelo con G ok) | **~17h**              |
| **I Content Generation**             | Requiere F + G                      | **~12h**              |
| **J Analytics & Reporting**          | Requiere F + G                      | **~12h**              |
| **K Integrations**                   | Requiere F + G                      | **~10h**              |
| L Migration wizards (era G antigua)  | Después de K                        | ~10-12h               |
| M Internal hardening (era H antigua) | Pre-launch                          | ~6h                   |
| N Apple Dev signing (era I antigua)  | Bloqueado                           | ~6-7h                 |

**Total Etapa 2 revisada: ~140-150h efectivas remaining.**

**Calendario realista**: 4-6h productivas/día → ~6-7 semanas de dev.

## Etapa 3 — SAAS READY sin cambios estructurales

Los bloques J Supabase / K PayPal / L Marketing / M API pública / N Support / O i18n / P Migration / Q Windows quedan como están. Algunos features que originalmente iban en Etapa 3 (Public API + MCP público) los adelantamos a Etapa 2 K-3 porque el agencia los necesita desde día 1.

# Pricing tier nuevo sugerido para OZ

Cuando salgamos a SaaS público (post Etapa 2):

| Tier                  | Precio           | Features                                                                                                     |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| **Free**              | $0               | 3 identities, sin automation, sin proxies                                                                    |
| **Basic**             | $15/mes          | identities ilimitadas, sin automation, sin proxies                                                           |
| **Pro**               | $49/mes/seat     | + automation 1 cliente, F+G+H, proxies                                                                       |
| **Team**              | $25/seat (min 3) | + sync + team mode + multi-cliente (hasta 3)                                                                 |
| **Enterprise Agency** | $299-499/seat    | + bulk automation 100+ cuentas + I (LLM) + J (analytics) + K (integrations) + audit logs + dedicated support |

El Enterprise tier es PRECISAMENTE para tu agencia y similares. Diferenciador masivo vs AdsPower ($30/mes sin automation real) y Multilogin ($100/mes sin LLM/analytics).

# Riesgos consolidados

| Riesgo                              | Mitigación                                             |
| ----------------------------------- | ------------------------------------------------------ |
| X cambia selectores                 | F-7 recorder + J-5 recipe health monitor               |
| Plataforma detecta ActionRunner     | F-1 human jitter + H-5 multi-action + circuit breakers |
| Cuentas se queman masivo            | H-1 warmup + H-2 health score + G-5 failsafes          |
| Compliance / legal                  | G-3 audit logs encriptados + I-3 content rules         |
| LLM costs descontrolados            | I-4 cache + cost tracking per cliente                  |
| Bug en producción rompe 100 cuentas | F-4 resume + L hardening DR drill                      |
| Team conflict editing same account  | E team mode locks                                      |

# Dependencias entre bloques

```
F-0 (validación sync) → independent
F-1 (ActionRunner)    → base de todos
F-2 (Recipes engine)  → requires F-1
F-3 (Scheduled)       → requires F-1
F-4 (Bulk orch)       → requires F-1, F-2, F-3
F-5 (X validación)    → requires F-4
F-6 (IG recipe)       → requires F-5 verde
F-7 (Recorder)        → independent post F-2 (puede paralelizarse)

G-1 (Multi-client)    → requires F-4
G-2 (Roles)           → requires G-1
G-3 (Audit log)       → requires F-4
G-4 (Quotas)          → requires G-1, G-3
G-5 (Failsafes)       → requires F-4
G-6 (OS notif triaje) → independent

H-1 (Warmup)          → requires F-1, F-2
H-2 (Health score)    → requires F-4, G-3
H-3 (FP audit)        → independent (reusa 1.9 FP engine)
H-4 (Schedule realista) → requires F-3
H-5 (Multi-action)    → requires F-2
H-6 (Shadow ban)      → requires F-4

I-1 (Spintax)         → requires F-2
I-2 (Personas)        → requires F-2
I-3 (Content rules)   → requires G-1
I-4 (LLM endpoint)    → requires F-2, I-1, I-2

J-1 (Metrics store)   → requires F-4
J-2 (Dashboards)      → requires J-1
J-3 (Exports)         → requires J-1, G-3
J-4 (A/B testing)     → requires F-4, J-1
J-5 (Recipe monitor)  → requires J-1, F-7

K-1 (Webhooks)        → requires F-4
K-2 (Connectors)      → requires K-1
K-3 (Public API)      → requires F-4, G-2
K-4 (Onboarding)      → requires G-1
K-5 (Training)        → requires all above
```

# Próximos pasos inmediatos

1. **Confirmar este plan** — sin más adiciones, sin más recortes.
2. Cuando me digas "go F-0" → ejecuto la validación visual del sync.
3. Cuando F-0 cierre verde → arranco F-1 ActionRunner Core.
4. Pasada del PLAN-MAESTRO con este plan integrado.
5. Apple Dev approval llega → I (signing) sin bloquear el resto.

---

**Versión**: 1
**Fecha**: 2026-05-13
**Status**: Plan aprobado para ejecución pendiente de confirmación final
