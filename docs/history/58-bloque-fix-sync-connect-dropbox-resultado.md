# Bloque alpha.116 — Fix UX: botón Connect Dropbox en Settings → Sync — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.116

## Contexto

Jose intentó conectar Dropbox para el Sync (Fase 5) y quedó trabado: tanto el panel **Sync** como **Backup** en Settings decían _"Connect Dropbox first in Cloud Backup settings"_, pero no había ningún botón/link para llegar a esos "Cloud Backup settings". El botón real de OAuth (`Connect Dropbox`) vive en el modal de **Cloud Backup**, que solo se abre desde **Time Machine → "☁ Cloud backup…"** (Cmd+K → Time Machine). Dead-end de UX.

## Qué se entregó

Nueva fila **"Dropbox connection"** en Settings → Sync, con botón **"Connect Dropbox…"** que abre el modal de Cloud Backup directo (`window.OZ.CloudBackup.open()`; `cloud-backup.js` ya está cargado en webui.html). Fallback: si el singleton no está, un alert guía a Time Machine. `browser/ui/webui.html` (fila nueva) + `browser/ui/settings.js` (wiring). WebUI manifest 2.0.66.

## Qué quedó funcionando

- check:loc verde. El flujo de OAuth en sí (oauth-helper PKCE + Keychain) no cambió — solo se le dio una puerta de entrada visible desde Sync.

## Pendiente

- Publicar alpha.116 (con 115). Smoke vivo de Jose: Settings → Sync → Connect Dropbox… → login → volver y activar "Enable cross-device sync".
- Idea futura: el mismo botón en el panel Backup, y/o mover el OAuth de Dropbox a su propia sección de Settings (hoy acoplado a Cloud Backup/Time Machine).
