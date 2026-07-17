# Bloque alpha.115 — Fix "Unknown" en tabs + captura compuesta — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.115

## Contexto

Salido del smoke visual (alpha.112): Jose pidió arreglar dos cosas que Claude observó.

## Qué se entregó

1. **Fix etiqueta "Unknown" en tabs.** `oz-utils.identityName` mostraba "Unknown" para tabs cuyo `identityId` no resuelve (identity borrada o tab sin binding creado por window.open). Esos tabs corren en la sesión Default → ahora la etiqueta cae al nombre de la identity Default (solo "Unknown" si ni siquiera hay Default en la lista). El tabstrip ya refrescaba identities en `onChanged`, así que NO era staleness de cache — eran identityIds huérfanos. WebUI manifest 2.0.64 → 2.0.65.

2. **Captura compuesta `oz.diag.screenshot` target 'full'.** El capturePage del chrome deja el área de contenido en negro (el WebContentsView es una capa nativa aparte del web page del chrome). `full` captura chrome + contenido en una sola llamada y devuelve `{ parts:[{part,path,bytes,...}] }`; el agente lee ambos PNG para "ver todo".

## Qué quedó funcionando

- Tests +7 (`oz-utils-identity-name.smoketest.js`, fallback a Default vía VM sandbox). check:loc verde (484 files).

## Pendiente

- Publicar alpha.115 (supersede a 114 como Latest, trae 113+114+115 a Jose).
- Smoke vivo: ver que las tabs "Unknown" ahora dicen "Default"; probar oz.diag.screenshot target 'full'.
