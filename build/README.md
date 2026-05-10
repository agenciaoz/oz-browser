# build/

Assets de empaquetado consumidos por `forge.config.js`.

## Archivos esperados

### `icon.icns` (macOS, opcional en Etapa 3a)

Icon de la app para Finder, Dock, About panel.

- **Etapa 3a (actual):** ausente — packager usa el default de Electron.
- **Etapa 3b-polish:** se agrega el `.icns` final (1024×1024 base, generado con `iconutil` desde un `.iconset` con 10 resoluciones).

Comando para generar `.icns` desde un `.png` 1024×1024:

```bash
mkdir -p icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
cp                icon.png       icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o build/icon.icns
```

### `entitlements.mac.plist` (Etapa 3b)

Entitlements para code-signing con hardened runtime habilitado.
Necesario para notarización (Etapa 3c).

Ya creado en este folder. Permite:

- `com.apple.security.cs.allow-jit` — Electron necesita JIT para V8.
- `com.apple.security.cs.allow-unsigned-executable-memory` — V8 + native modules.
- `com.apple.security.cs.disable-library-validation` — para que carguen `*.node` bindings (@napi-rs/keyring, exceljs).
- `com.apple.security.network.client` — outbound network (browsing).
- `com.apple.security.network.server` — para el MCP server local en :9223.
- `com.apple.security.device.audio-input` y `com.apple.security.device.camera` — webRTC en sites como Meet/Zoom.
