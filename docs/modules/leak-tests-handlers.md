# Módulo `leak-tests-handlers`

**Path:** `browser/leak-tests-handlers.js`
**Líneas:** ~290
**Bloque/Etapa:** H-2j (v1.1.4)

## Qué hace

Runtime bridge entre la lógica pura de `leak-tests.js` y Electron. Spawnea un hidden BrowserWindow con la partition de la identity para WebRTC ICE gather + hits ipleak.net via net.request, combina resultados y cachea in-memory.

## API factory

```js
const handlers = buildLeakTestHandlers(browser)
// → { run, get, list, clear }

await handlers.run({ identityId })
// → { identityId, identityName, identityColor, overall, webrtc, dns,
//     proxyId, proxyName, proxyCountry, proxyPublicIp, evaluatedAt }
// → { __error: { code, message } } si BAD args

handlers.get(identityId)    // → cached record o null
handlers.list()             // → todos los cached
handlers.clear(identityId?) // → drops específico o todo
```

Cache: `browser._leakTestCache: Map<identityId, record>`. Per-process, no persisted.

## WebRTC runtime

1. `new BrowserWindow({show:false, width:1, height:1, webPreferences:{partition: 'persist:identity-<id>', contextIsolation:true, sandbox:true, backgroundThrottling:false}})` — hereda proxy + cookies de la session de la identity automáticamente.
2. `loadURL(data:text/html;base64,<HTML>)` con HTML mínimo + script inline:
   ```js
   const pc = new RTCPeerConnection({
     iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
   })
   pc.createDataChannel('oz-gather')
   pc.onicecandidate = (e) => {
     window.OZ_CANDIDATES.push({ type, address, port, protocol, candidate })
   }
   pc.createOffer().then((o) => pc.setLocalDescription(o))
   ```
3. Poll cada 300ms via `webContents.executeJavaScript('window.OZ_CANDIDATES || []')`, early-exit cuando hay srflx >1.5s elapsed, hard timeout `WEBRTC_GATHER_TIMEOUT_MS=4500`.
4. `win.close()` en `finally` (defensive try/catch).
5. Map candidates via `parseRtcCandidate`, pass a `analyzeWebRtcCandidates`.

## DNS runtime

```js
const ses = session.fromPartition(`persist:identity-${id}`, { cache: true })
const json = await fetchJsonViaSession(ses, 'https://ipleak.net/json/', 6000)
return analyzeDnsLeak({ ipleakJson: json, proxyCountry, proxyPublicIp })
```

`fetchJsonViaSession`: Electron `net.request` con session, timeout 6s, JSON.parse en response.end. Errores → null (resolved sin throw para no romper el flow).

## IPC channels

| Channel             | Args            | Returns          |
| ------------------- | --------------- | ---------------- |
| `oz:leakTest:run`   | `(opts)`        | leak record      |
| `oz:leakTest:get`   | `(identityId)`  | cached o null    |
| `oz:leakTest:list`  | `()`            | array de records |
| `oz:leakTest:clear` | `(identityId?)` | `{ok, cleared}`  |

Broadcast: `oz:leakTest:changed` con `{identityId}` post run/clear.

## Tunables

- `WEBRTC_GATHER_TIMEOUT_MS = 4500`
- `IPLEAK_TIMEOUT_MS = 6000`
- `IPLEAK_URL = 'https://ipleak.net/json/'`
- `STUN_URL = 'stun:stun.l.google.com:19302'`

## Gotchas

- BrowserWindow.partition hereda la proxy config de la session creada por identity-manager — siempre que la identity tenga proxy assigned, el GET va por ese proxy.
- `useSessionCookies:false` en net.request — NO mandamos cookies al ipleak.net (es un health check, no necesita auth).
- Si WebRTC no responde (proxy bloquea STUN), `_fetchAndDiscard` retorna `'timeout'` → analyzeWebRtcCandidates devuelve yellow con NO_STUN_RESPONSE (correcto, no es error).

## Consumers

- `preload.js` → `window.oz.leakTest.{run,get,list,clear,onChanged}`
- `browser/ui/proxy-dashboard-leaks.js` — UI bridge.
- `browser/ipc-handlers-extra.js` — singleton wire-up (`browser._leakTestHandlers`).
