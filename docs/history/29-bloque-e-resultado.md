# Bloque E — Team mode + key-sharing Curve25519 (resultado)

**Status:** ✅ Cerrado 2026-05-11 madrugada
**Commit:** TBD (main directo, único batch)
**Tiempo:** ~7-8h efectivas vs ~6-7h estimadas (+1h por destructive-flow + Vault.replaceMasterKey/archiveMasterKey)
**Deps nuevas:** `@noble/curves@^2.2.0` (audited, pure-JS, ~50KB)
**Tests:** 2043 → 2177 (+134)
**Files added:** 7 source + 4 tests + 1 ADR + 1 history

## Origen

D-2 cerró el ADR del sync engine pero no el sync core. Antes de tipear D-3, Jose pidió "qué falta para trabajo con el equipo" — yo respondí con E como mayor unlock. Sin team mode (key-sharing), un member que descarga snapshots del owner NO puede descifrarlos (master key vive solo en Keychain del owner). Con key-sharing Curve25519 (ECIES wrap), el owner envuelve su masterKey con la public key de cada member, y cada uno descifra con su private key local.

Decisiones de scope (vía AskUserQuestion al inicio):

1. **Join member UX**: Auto-snapshot + wipe — al aceptar invite, OZ toma un .ozbackup local (cifrado con la OLD key) + archiva la OLD key en Keychain bajo un slot recuperable + reemplaza el vault con la masterKey del team. Reversible via Time Machine + archived key.
2. **Crypto library**: `@noble/curves@2.2.0` — audited, pure JS, modern API. Descartados: tweetnacl (más viejo, 2 packages), Node built-in `crypto.diffieHellman` (ECIES tendríamos que escribirlo a mano).

## Decisiones clave del ADR (detalle en 0027-team-mode.md)

1. **Roles**: standalone / owner / member. Default standalone. Transiciones explícitas via createTeam/acceptInvite/leaveTeam/disbandTeam.
2. **Per-device identity (X25519)**: keypair lazy-generated al primer uso de team. Private key en Keychain (service `oz-browser-team`). Public key + memberId (UUID v4) en `userData/team-identity.json` + subido a Dropbox shared folder.
3. **ECIES protocol**: ephemeral X25519 keypair + ECDH → HKDF-SHA256 → AES-256-GCM con AAD=peerPublicKey. Blob 124 bytes. Forward secrecy + AAD bind ata el blob a un slot específico (atacante no puede mover blobs entre slots de members).
4. **Dropbox shared folder**: owner comparte `/Apps/OZ Browser/` con team via Dropbox web UI (manual). Cada member autentica con su PROPIO Dropbox account.
5. **Layout** `/Apps/OZ Browser/team/`: `teamId.json` + `members/<memberId>.pub` + `wrapped-keys/<memberId>.bin`.
6. **acceptInvite destructive**: pre-team-join snapshot + archive old key (Keychain slot `oz-browser-vault-archive`) + upload member.pub + poll wrapped-key + unwrap + replaceMasterKey + wipe accounts. Restart required.
7. **Owner daemon**: timer cada 60s, lista `members/*.pub`, wrap masterKey para cualquier member sin `wrapped-keys/<memberId>.bin` correspondiente. Skip vault locked.
8. **Invite token**: `oz://team/invite?token=<base64url-JSON>`. Plaintext metadata (teamId, ownerMemberId, ownerPublicKey, expiresAt 24h, nonce). NO firmado v1 — trust anchor es Dropbox shared folder.

## Módulos entregados

```
browser/
  team-identity.js      — X25519 keypair gen + Keychain + memberId UUID
  team-keystore.js      — ECIES wrap/unwrap (pure crypto, no I/O)
  invite-token.js       — Token format + URL parser
  team-manager.js       — Orchestrator: createTeam/acceptInvite/listMembers/...
  team-handlers.js      — IPC map
  team-setup.js         — main.js wire-up + protocol dispatcher + daemon
  ui/team.js            — Team modal (standalone/owner/member views)
account-vault.js (modificado) — +replaceMasterKey, +archiveMasterKey
```

Más:

- `ipc-handlers.js` + `ipc-handlers-extra.js`: nuevos handlers en map + IPC channels `oz:team:*`
- `preload.js`: `window.oz.team.*` namespace + event subscribers
- `webui.html`: modal markup + CSS + sidebar toolbar button "👥"
- `main.js`: setupTeamMode(this) después de setupCloudBackup
- `package.json`: `@noble/curves@^2.2.0`

## Tests breakdown

- `team-identity.smoketest.js` — 38 (slugify, UUID, keypair gen, ECDH symmetric, idempotent ensure, clear)
- `team-keystore.smoketest.js` — 21 (wrap→unwrap roundtrip, tampering detection 5 cases, AAD mismatch, HKDF determinism, input validation)
- `invite-token.smoketest.js` — 34 (gen→parse→URL roundtrip, expiry, shape rejection, base64url, tampering)
- `team-manager.smoketest.js` — 41 (initial standalone, createTeam, generateInvite, acceptInvite happy/expired/timeout, wrapKeyForPendingMembers skip cases, listMembers, removeMember, leaveTeam, disbandTeam, role gates)

Total E: **134 tests nuevos**. Regression: account-vault 30/30 verde post replaceMasterKey/archiveMasterKey.

## Vault changes (E-2 prerequisite)

- `vault.replaceMasterKey(newKey, { preserveAccounts? })`: requires unlocked. Default wipes accounts (team join). preserveAccounts true para in-place rotation (futuro owner-side revoke).
- `vault.archiveMasterKey(label)`: archiva la current key en Keychain service `oz-browser-vault-archive`. Recovery path documentado en ADR §6.

## Flujo end-to-end del team

1. Jose (owner) crea team → `/team/teamId.json` + `/team/members/jose.pub` en Dropbox.
2. Jose comparte `/Apps/OZ Browser/` con Maria via Dropbox web UI (manual, una vez).
3. Jose genera invite link → manda a Maria por Signal.
4. Maria abre el link `oz://team/invite?token=...` en su OZ → modal Team se abre con confirm.
5. Maria acepta → su OZ toma snapshot pre-join, archiva su key vieja, sube `/team/members/maria.pub`, poll por wrapped-key.
6. Jose's OZ (corriendo con team mode init) detecta nueva pub en el daemon de 60s → wrap masterKey con maria.pub → upload `/team/wrapped-keys/maria.bin`.
7. Maria's OZ detecta el blob → unwrap con su priv → replaceMasterKey → vault wipe → state.role=member.
8. Restart OZ Maria.
9. Maria ahora puede descifrar todos los .ozbackup del team (mismo masterKey) + crea snapshots con esa key → Jose los puede leer también.

D-3 (sync engine) montará encima de esto para que identities + workspaces se propaguen en vivo.

## Trade-offs aceptados

- Token NO firmado v1: trust anchor es Dropbox shared folder. v2 puede agregar Ed25519 signature.
- Revoke no re-cifra snapshots viejos: member ya los vio, no leak nuevo. Re-cipher batch out-of-scope v1.
- Owner offline: members en pending hasta que owner abra OZ. UI muestra "waiting for owner". Aceptable para team chico.
- Multi-team membership: out of scope v1 — un device solo puede ser miembro de 1 team.
- Auto-snapshot + wipe destructive: alternativa dual-vault rechazada por complejidad UI.

## Validación

- ✅ 134/134 E tests verde + 30/30 account-vault regression + 2043 D anteriores → 2177 total
- ✅ check:loc passes (max 500/500 main.js — tight pero dentro)
- ✅ lint + prettier limpio
- ✅ Smoke visual boot: team-identity creó memberId `18bb1df6-c83e-4e28-8840-db987dab5bd7`, team-setup loaded role=standalone, cero ERRORs
- ⏳ Pendiente: visual del Team modal con Jose interactivo (Touch ID para unlock vault + verificar las 3 vistas standalone/owner/member). OAuth Dropbox round-trip con shared folder real.

## Próximo chunk

Decisión abierta de Jose:

- **D-3 sync engine core (~10-13h)**: con team mode listo, sync engine ya nace multi-owner. Implementa lo decidido en ADR 0026.
- **Etapa 3 packaging + Apple signing (~3-4h)**: dispatch DMG firmado a team members. Apple Dev sigue esperando approval, no-bloqueante.
- **H hardening (~6h)**: full regression + DR drill (formateo Mac + restore + team rejoin).
