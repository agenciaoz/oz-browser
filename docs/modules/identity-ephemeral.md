# Módulo `identity-ephemeral`

**Path:** `browser/identity-ephemeral.js`
**Líneas:** ~26
**Bloque:** Ghost F3 (identidad descartable)

## Qué hace

Decisión PURA de limpieza de identidades efímeras (throwaway). Una identidad `ephemeral` se autodestruye cuando se cierra su última tab; este módulo decide si corresponde limpiar dado el estado actual de tabs. El wiring (remover la identity + notificar) vive en `tab-handlers.close`.

## Exporta / API

| Export                                            | Descripción                                                     |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `shouldCleanupEphemeral(identity, remainingTabs)` | `true` si la identity es `ephemeral` y no quedan tabs usándola. |

`identity`: `{ id, ephemeral? }` (o `null`). `remainingTabs`: tabs vivas tras el cierre (`[{ identityId? }]`).

## IPC / MCP

No registra IPC directamente (lógica pura). La consume `tab-handlers.close` durante el cierre de tabs.

## Gotchas

- Devuelve `false` si la identity es null, no es `ephemeral`, o no tiene `id` string.
- Considera tabs de TODAS las ventanas (no solo la activa).
- ADR 0005 (modular).
