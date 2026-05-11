# ADR 0027 — Team mode + key-sharing Curve25519 (E)

**Date:** 2026-05-11
**Status:** Proposed (implementación en E-2..E-8)
**Bloque:** E — Team mode local con key-sharing
**Predecesores:** ADR 0008 (vault + AES-256-GCM), ADR 0025 (cloud backup zero-knowledge), ADR 0026 (sync engine — depende de team mode para multi-owner)

## Context

D-1 entregó cloud backup zero-knowledge: snapshots cifrados con master key del vault → Dropbox. Cross-device restore funciona PARA EL MISMO USER (la master key vive en el Keychain de cada device del mismo dueño). Pero el caso real de Jose es team: él + 2-3 personas operando las MISMAS cuentas IG/Twitter desde sus Macs.

Sin team mode, cada miembro vive aislado: cada uno con su propia master key, sus propios snapshots, sin forma de descifrar el material del otro. El team member no puede unirse al universo del owner.

Necesitamos compartir la master key del vault del owner con los team members, **sin que la key viaje en plaintext fuera de los Keychains** y **sin servidor centralizado** (zero-knowledge mantenida). La solución estándar: encripción asimétrica (X25519 ECDH + ECIES) para wrappear la master key una vez por miembro.

## Decision

### 1. Roles + estado

Tres roles posibles por device:

- **`standalone`**: estado default. Sin team. Master key generada al boot vive solo en Keychain local. Snapshots cifrados con esa key. No comparte nada.
- **`owner`**: este device creó el team. Tiene la master key autoritativa. Wrappea esa key para cada team member usando sus public keys. Puede invitar + revocar.
- **`member`**: este device se unió a un team creado por otro. Reemplazó su master key local con la del owner. Puede acceder a snapshots del team (download + decrypt). Puede crear snapshots con la key del team (que cualquier otro miembro puede leer).

Transiciones:

- standalone → owner: via `createTeam()` (no destructive — la master key existente se vuelve la del team).
- standalone → member: via `acceptInvite(token)` (DESTRUCTIVE — ver §5 auto-snapshot).
- owner → standalone: via `disbandTeam()` (no destructive — solo borra los wrapped-keys de Dropbox).
- member → standalone: via `leaveTeam()` (DESTRUCTIVE — la master key del team se pierde de tu Keychain).

### 2. Per-device team identity (Curve25519 X25519)

Cada install de OZ genera un X25519 keypair al primer ingreso a team mode (lazy — standalone devices no necesitan keypair):

- `privateKey`: 32 bytes. Persistido en macOS Keychain via `@napi-rs/keyring`. Service `oz-browser-team`, account `<deviceFolder>`. NUNCA toca disco fuera del Keychain.
- `publicKey`: 32 bytes. Persistido en `userData/team-identity.json` (legible, intercambiable) y subido a `/Apps/OZ Browser/team/members/<memberId>.pub` para que otros members lo encuentren.
- `memberId`: UUID v4 generado one-time. Identifica al device dentro del team (distinto del `deviceFolder` de ADR 0025 — el memberId persiste si el user renombra el Mac, deviceFolder no). Persistido en `team-identity.json`.

```json
// userData/team-identity.json
{
  "memberId": "a1b2c3d4-...-...-...",
  "publicKey": "<base64url 32 bytes>",
  "createdAt": "2026-05-11T...",
  "schemaVersion": 1
}
```

### 3. Library: `@noble/curves@^2.2.0`

Pure JS, audited (multiple paid audits), zero-dep, ~50KB. API estable. Imports via `@noble/curves/ed25519.js` para X25519 (compartido con ed25519 en el mismo módulo).

Por qué no `crypto.diffieHellman('x25519')` nativo: API low-level, tendríamos que escribir el HKDF + AES-GCM wiring a mano + manejar formato DER → puro código de glue propenso a bugs sutiles (off-by-one en HKDF info, wrong AAD para AES-GCM). Noble da API alta y testeada.

Por qué no tweetnacl: misma seguridad, API más vieja, dos packages en vez de uno.

### 4. ECIES key-wrapping protocol

Para wrappear la `masterKey` (32 bytes, key del vault) para un team member con public key `peerPub`:

```
1. ephPriv = random 32 bytes (ephemeral X25519 private key)
2. ephPub = x25519.getPublicKey(ephPriv)
3. shared = x25519.getSharedSecret(ephPriv, peerPub)  // 32 bytes
4. salt = random 32 bytes
5. kdfInfo = "oz-browser-team-key-wrap-v1"  // domain separator
6. wrapKey = HKDF-SHA256(shared, salt, kdfInfo, 32 bytes)  // node crypto.hkdfSync
7. iv = random 12 bytes
8. ciphertext, authTag = AES-256-GCM(wrapKey, iv, masterKey, aad=peerPub)
9. blob = [ ephPub | salt | iv | authTag | ciphertext ]
   sizes: 32 + 32 + 12 + 16 + 32 = 124 bytes
```

Para unwrappear (member side):

```
1. blob → [ephPub, salt, iv, authTag, ciphertext]
2. shared = x25519.getSharedSecret(myPrivKey, ephPub)
3. wrapKey = HKDF-SHA256(shared, salt, kdfInfo, 32 bytes)
4. masterKey = AES-256-GCM-decrypt(wrapKey, iv, ciphertext, authTag, aad=myPubKey)
5. If authTag check fails → throw — wrong key or tampering.
```

Notes:

- `aad = peerPub` (or `myPubKey` on unwrap) — vincula el wrapped blob a un member específico. Si alguien copia el blob a otro slot de Dropbox, el AAD no coincide y descifra falla.
- ephemeral X25519 keypair por wrap → forward secrecy. Si en el futuro filtran la masterKey de un member, no se pueden re-derivar otros wraps.
- HKDF info incluye versión → permite v2 con scheme distinto sin colisión.

### 5. Dropbox shared folder workflow (manual setup by owner)

El owner comparte `/Apps/OZ Browser/` con cada team member usando Dropbox's native Share UI (manual setup, not automated — Dropbox API requiere scopes adicionales que complicarían el setup). Cada member autentica a su propia cuenta Dropbox via OAuth (D-1), pero ve el folder compartido.

Layout post-team:

```
/Apps/OZ Browser/                          (Scoped App + shared)
  <owner-deviceFolder>/snapshots/...       (D-1)
  <member-deviceFolder>/snapshots/...      (D-1, member sube ahí también)

  team/
    teamId.json                            (clear: { id, ownerMemberId, createdAt })
    members/
      <ownerMemberId>.pub                  (clear: 32-byte pubkey base64url)
      <memberId-A>.pub
      <memberId-B>.pub
    wrapped-keys/
      <memberId-A>.bin                     (124-byte ECIES blob)
      <memberId-B>.bin
    invites/
      <inviteId>.json                      (pending invites, deleted on accept)
```

`teamId.json` es plaintext — el team-id es semi-public. Membership list (via folder listing) tambien.

Wrapped keys NUNCA contienen plaintext de la masterKey. Member sin private key no las puede usar.

### 6. Auto-snapshot + key-archive on join (UX critical)

Cuando un member acepta un invite, su masterKey LOCAL es reemplazada por la del team. Su data previa (identities/workspaces/cookies cifradas con la key vieja) se vuelve inaccesible con la key nueva.

Para no perder data:

1. **Pre-join snapshot**: el flow de `acceptInvite()` invoca `backupManager.createSnapshot({ reason: 'pre-team-join' })` ANTES de cambiar nada. Este snapshot queda en `userData/data/snapshots/` (NO se sube a Dropbox del team — es solo recuperable local).
2. **Key archive**: la masterKey vieja se mueve a un Keychain entry separado: service `oz-browser-vault-archive`, account `pre-team-join-<timestamp>`. Permite recovery manual si el user cambia de idea.
3. **Vault wipe + import**: el masterKey del team reemplaza la vieja. `identities.json` / `workspaces.json` se reinician a vacío. El user puede luego restaurar el pre-team-join snapshot con la key archivada (via Time Machine UI extended para mostrar archived keys).

Confirmation modal explícito antes de proceder. Botón "Cancel" disponible.

### 7. Invite token protocol

`oz://team/invite?token=<base64url-encoded-token>`

Token (JSON luego base64url):

```json
{
  "v": 1,
  "teamId": "uuid",
  "ownerMemberId": "uuid",
  "ownerPublicKey": "base64url-32bytes",
  "expiresAt": "ISO timestamp (24h)",
  "nonce": "base64url-16bytes"
}
```

Token NO incluye nada secreto — son metadatos para que el member pueda:

- Identificar el team (teamId).
- Verificar que el owner publicó su public key en `/team/members/<ownerMemberId>.pub` (cross-check vs token).
- Saber a quién contestar (ownerMemberId).

El flujo no es zero-trust contra el owner — el owner ES la trust anchor. Si el owner está comprometido, el team está comprometido. Threat model es: external attacker que intercepta el invite link NO debe poder unirse sin la cooperación del member (member tiene que aceptar explícitamente + ya tiene su Dropbox autenticado a su propia cuenta).

Expiry 24h previene reutilización indefinida. Nonce previene replay attacks.

### 8. Flow de acceptInvite

Member side, on `oz://team/invite?token=...`:

1. Parse + verify token (signature optional v2 — v1 trust on Dropbox folder shared status).
2. Confirm modal: "Join team owned by <ownerMemberId>? Your current OZ data will be backed up and replaced with the team's."
3. On confirm:
   - `backupManager.createSnapshot({reason: 'pre-team-join'})` local only.
   - Archive current `masterKey` → Keychain `oz-browser-vault-archive/pre-team-join-<ts>`.
   - Ensure own team-identity (generate keypair if first time).
   - Upload own `<memberId>.pub` to `/team/members/` in shared Dropbox folder.
   - Wait for owner to wrap-key (poll `/team/wrapped-keys/<memberId>.bin` every 5s; owner's OZ sees the new member.pub + creates the wrapped key).
   - Download wrapped-key + unwrap with own privateKey → new masterKey.
   - Replace local `Vault` master key.
   - Wipe local `identities.json` / `workspaces.json` (or import from team if sync engine D-3 active).
   - Update `userData/team.json`: role='member', teamId, ownerMemberId.
   - Lock + force re-unlock vault (so user sees fresh state).

Owner side, autonomously:

- Daemon (or check on app focus) lists `/team/members/*.pub`. For any member pubkey NOT yet present in `/team/wrapped-keys/<memberId>.bin`, wrap masterKey with that pubkey + upload.
- The wrap is cheap (~10ms) — runs sin user interaction. Owner just needs OZ open + vault unlocked.

### 9. Revoke flow (owner side)

`removeMember(memberId)`:

1. Owner generates NEW masterKey (replaces vault).
2. Re-encrypts all existing snapshots with the new key (heavy operation — done in background; old snapshots can stay readable via key-archive).
3. Re-wraps the new masterKey for all REMAINING members (delete the revoked member's wrapped-key file).
4. Removed member: next time their device tries to download a snapshot, decryption fails (the snapshots in cloud are encrypted with new key).

The removed member RETAINS access to anything they downloaded locally before revoke. There is no way to expire local copies — same trade-off as any zero-knowledge system. Industry standard.

For v1, we ship steps 1-3 + clear documentation. Step 2 (re-encrypt existing snapshots) is heavy — implementación inicial dejo los snapshots viejos con la key vieja (revoked member ya los vio, no leak nuevo) y solo los NUEVOS snapshots usan la key nueva.

### 10. State persistence

`userData/team.json`:

```json
{
  "role": "standalone" | "owner" | "member",
  "teamId": "uuid" | null,
  "ownerMemberId": "uuid" | null,
  "myMemberId": "uuid",
  "joinedAt": "ISO" | null,
  "schemaVersion": 1
}
```

Default standalone. Persisted atomically (tmp file + rename).

### 11. Trade-offs aceptados

| Trade-off                                                                | Decisión                    | Razón                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dropbox folder share via UI manual                                       | Aceptado                    | Dropbox API "sharing" scope adds friction + extra OAuth permission. Manual Share UI es estándar para owners.                                                                                                 |
| acceptInvite es DESTRUCTIVE (replace vault)                              | Aceptado v1 + auto-snapshot | Dual-vault (coexistencia) agrega ~3h + complica UI. Auto-snapshot + key-archive recovery cubre el caso de "me equivoqué".                                                                                    |
| Revoke no re-cifra snapshots viejos                                      | Aceptado v1                 | Member ya los vio; no hay leak nuevo. Re-cifrar 1GB de snapshots es costoso, beneficio nulo.                                                                                                                 |
| Owner offline → invitations stall en `/team/members/.pub` esperando wrap | Aceptado                    | Member ve estado "waiting for owner to approve". Owner abre OZ → wrap automático en segundos.                                                                                                                |
| Token expiry 24h                                                         | Aceptado                    | Shorter = más friction. Longer = ventana de attack más grande si link leakea. 24h es razonable para "owner manda link por Signal, member tiene 24h para abrir".                                              |
| Sin signature en el token                                                | Aceptado v1                 | Pubkey del owner está EN el token; member valida vs `/team/members/<ownerMemberId>.pub` en Dropbox shared folder. Si attacker substituye el token, el cross-check falla. v2 puede agregar Ed25519 signature. |
| Multi-team (ser miembro de 2+ teams a la vez)                            | OUT v1                      | Requiere multi-vault. Out of scope. Member is in 0 or 1 team.                                                                                                                                                |

### 12. Threat model

**Protege contra:**

- External attacker con acceso al Dropbox folder pero sin Keychain: ve archivos cifrados, sin master key, no puede descifrar nada.
- Member legítimo después de revoke: no recibe nuevas keys, snapshots futuros opacos.
- Token leakado a tercero: tercero no puede wrappear su pubkey en el slot del member intended sin acceso al Dropbox folder shared.

**NO protege contra:**

- Owner comprometido (= team comprometido — single trust anchor).
- Member malicioso (puede subir/borrar archivos en el shared folder; v2 podría sign records).
- Dropbox subpoena: ven filenames + tamaños + timestamps. No ven contenido.
- Adversary con acceso al Keychain del owner/member: have key, game over (= cualquier disk encryption + macOS lock screen).

### 13. Schema versioning

Cada blob/file lleva su `schemaVersion`. Forward-compat: clients viejos ignoran archivos con version > supported + log WARN. Owner orquesta upgrade coordinated.

## Consequences

**Lograr:**

- Jose puede invitar a Maria + Pedro al team. Cada uno abre el link, acepta. Sus OZ Browsers descifran los snapshots de Jose. Cuando alguien crea una identity nueva, otros la ven en el siguiente sync (D-3) o restore (D-1).
- Zero-knowledge mantenido: ningún servidor ve plaintext.
- Sin Supabase. Solo Dropbox como dumb storage.

**Cambios:**

- Nueva dep `@noble/curves@^2.2.0` (production, build-time).
- Nuevo `userData/team-identity.json` + `userData/team.json`.
- Nuevo Keychain entry para team private key + archived vault keys.
- Nueva IPC namespace `oz:team:*` + preload `window.oz.team.*`.
- Nuevo settings tab "Team".
- Vault gains a `replaceMasterKey()` operation (carefully gated).
- Protocol dispatcher para `oz://team/invite`.

**Pendientes diferidos:**

- Bloque H DR drill: simular team join + revoke en CI.
- Sync engine (D-3) — corre encima del team mode una vez ambos shipped.
- v2: signed records (Ed25519) + token signature.
- v2: re-encrypt-on-revoke pass.
- v2: multi-team membership.
