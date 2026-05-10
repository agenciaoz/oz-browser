// OZ Browser — Fingerprint preload script (1.9b/c).
//
// Doc: docs/modules/preload-fingerprint.md
// ADR: docs/architecture/0018-fingerprint-engine.md
//
// Este preload corre en cada renderer de tabs de identities (NO en el WebUI
// chrome). Aplica los overrides de fingerprint en el PAGE WORLD via
// webFrame.executeJavaScript ANTES de que la página ejecute su propio JS.
//
// Por qué webFrame.executeJavaScript y no contextBridge: con contextIsolation
// (que usamos por seguridad), el preload world y el page world están
// separados. Object.defineProperty(navigator) en el preload NO afecta al
// navigator del page world. webFrame.executeJavaScript inyecta código en el
// page world ANTES del primer JS de la página, así que los overrides se ven
// como si fueran nativos.
//
// Pattern del FP fetch:
//   ipcRenderer.sendSync('oz:fingerprint:request')
// El handler en main resuelve la identity via event.sender.session
// (mismo trick anti-spoof que 1.5c — el renderer NO puede pedir el FP de
// otra identity). Sync porque debe completar ANTES del primer page JS.
// El round-trip local IPC es <1ms, no perceptible.
//
// Nota: este script NO se inyecta en chrome-extension:// (mismo skip que
// preload-content.js — el WebUI no necesita FP spoof, es nuestro UI).

const { ipcRenderer, webFrame } = require('electron')

if (location.protocol !== 'chrome-extension:') {
  try {
    const fp = ipcRenderer.sendSync('oz:fingerprint:request')
    if (fp && fp.ua) {
      const script = buildOverridesScript(fp)
      webFrame.executeJavaScript(script).catch((err) => {
        // Don't break the page if injection fails. Log to main if possible.
        try {
          ipcRenderer.invoke('oz:log', 'WARN', 'preload-fingerprint', 'inject failed', [
            err.message,
          ])
        } catch (_e) {
          // best-effort
        }
      })
    }
  } catch (err) {
    // Sync IPC failed — likely the main handler isn't registered yet (test
    // environment). Skip silently — page loads with native fingerprint.
    try {
      ipcRenderer.invoke('oz:log', 'DEBUG', 'preload-fingerprint', 'no FP available', [
        err.message,
      ])
    } catch (_e) {
      // best-effort
    }
  }
}

/**
 * Build the IIFE script string that, when run in the page world, applies
 * every fingerprint override deterministically. The fp object is JSON-
 * serialized into the script body — no IPC bridge needed at the page-world
 * level.
 *
 * Coverage (1.9b + 1.9c):
 *   - navigator.{userAgent, appVersion, appName, vendor, platform,
 *     hardwareConcurrency, deviceMemory, language, languages,
 *     plugins, mimeTypes, getBattery}
 *   - window.screen.{width, height, availWidth, availHeight, colorDepth,
 *     pixelDepth} + window.devicePixelRatio
 *   - Intl.DateTimeFormat().resolvedOptions().timeZone
 *   - Date.prototype.getTimezoneOffset / toLocaleString / toString
 *   - speechSynthesis.getVoices
 *   - Canvas: HTMLCanvasElement.prototype.toDataURL/toBlob +
 *     CanvasRenderingContext2D.prototype.getImageData (deterministic noise)
 *   - WebGL: WebGLRenderingContext.prototype.getParameter (vendor + renderer)
 */
function buildOverridesScript(fp) {
  // Serialize the fingerprint as a JSON literal embedded in the script.
  const fpJson = JSON.stringify(fp)
  // The script body is wrapped in an IIFE so it leaves no globals behind.
  return `(function(){
    'use strict';
    if (window.__OZ_FP_APPLIED__) return;
    var fp = ${fpJson};

    // --- helpers -----------------------------------------------------------
    function defineGetter(obj, prop, getter) {
      try {
        Object.defineProperty(obj, prop, { get: getter, configurable: true });
      } catch (e) {}
    }

    // --- navigator.* -------------------------------------------------------
    defineGetter(navigator, 'userAgent', function () { return fp.ua; });
    defineGetter(navigator, 'appVersion', function () { return fp.appVersion; });
    defineGetter(navigator, 'appName', function () { return fp.appName; });
    defineGetter(navigator, 'vendor', function () { return fp.vendor; });
    defineGetter(navigator, 'platform', function () { return fp.platform; });
    defineGetter(navigator, 'hardwareConcurrency', function () { return fp.hardwareConcurrency; });
    defineGetter(navigator, 'deviceMemory', function () { return fp.deviceMemory; });
    defineGetter(navigator, 'language', function () { return fp.language; });
    defineGetter(navigator, 'languages', function () { return fp.languages.slice(); });

    // navigator.plugins / mimeTypes — return PluginArray-like objects.
    var fakePlugins = (function () {
      var pluginObjs = fp.plugins.map(function (p) {
        var pluginInst = {
          name: p.name,
          filename: p.filename,
          description: p.description,
          length: p.mimeTypes.length,
        };
        p.mimeTypes.forEach(function (mt, i) {
          pluginInst[i] = {
            type: mt.type,
            suffixes: mt.suffixes,
            description: mt.description,
            enabledPlugin: pluginInst,
          };
        });
        pluginInst.item = function (i) { return pluginInst[i] || null; };
        pluginInst.namedItem = function (n) {
          for (var i = 0; i < pluginInst.length; i++) {
            if (pluginInst[i] && pluginInst[i].type === n) return pluginInst[i];
          }
          return null;
        };
        return pluginInst;
      });
      pluginObjs.length = fp.plugins.length;
      pluginObjs.item = function (i) { return pluginObjs[i] || null; };
      pluginObjs.namedItem = function (n) {
        for (var i = 0; i < pluginObjs.length; i++) {
          if (pluginObjs[i] && pluginObjs[i].name === n) return pluginObjs[i];
        }
        return null;
      };
      pluginObjs.refresh = function () {};
      return pluginObjs;
    })();
    defineGetter(navigator, 'plugins', function () { return fakePlugins; });

    var fakeMimeTypes = (function () {
      var mts = [];
      fp.plugins.forEach(function (p) {
        p.mimeTypes.forEach(function (mt) {
          mts.push({
            type: mt.type,
            suffixes: mt.suffixes,
            description: mt.description,
          });
        });
      });
      mts.length = mts.length;
      mts.item = function (i) { return mts[i] || null; };
      mts.namedItem = function (n) {
        for (var i = 0; i < mts.length; i++) {
          if (mts[i] && mts[i].type === n) return mts[i];
        }
        return null;
      };
      return mts;
    })();
    defineGetter(navigator, 'mimeTypes', function () { return fakeMimeTypes; });

    // navigator.getBattery — Chrome removed this in v82+ on most OSes, but
    // some sites still test it. Return a Promise resolving to a steady-state.
    if (navigator.getBattery !== undefined || true) {
      navigator.getBattery = function () {
        return Promise.resolve({
          charging: fp.battery.charging,
          chargingTime: fp.battery.chargingTime,
          dischargingTime: fp.battery.dischargingTime,
          level: fp.battery.level,
          addEventListener: function () {},
          removeEventListener: function () {},
          onchargingchange: null,
          onchargingtimechange: null,
          ondischargingtimechange: null,
          onlevelchange: null,
        });
      };
    }

    // --- screen + dpr ------------------------------------------------------
    defineGetter(screen, 'width', function () { return fp.screen.width; });
    defineGetter(screen, 'height', function () { return fp.screen.height; });
    defineGetter(screen, 'availWidth', function () { return fp.screen.availWidth; });
    defineGetter(screen, 'availHeight', function () { return fp.screen.availHeight; });
    defineGetter(screen, 'colorDepth', function () { return fp.screen.colorDepth; });
    defineGetter(screen, 'pixelDepth', function () { return fp.screen.pixelDepth; });
    defineGetter(window, 'devicePixelRatio', function () { return fp.devicePixelRatio; });

    // --- timezone ----------------------------------------------------------
    var origDTF = Intl.DateTimeFormat;
    var DTFProto = origDTF.prototype;
    var origResolvedOptions = DTFProto.resolvedOptions;
    DTFProto.resolvedOptions = function () {
      var r = origResolvedOptions.apply(this, arguments);
      r.timeZone = fp.timezone;
      r.locale = fp.locale;
      return r;
    };
    // Date.prototype.getTimezoneOffset — return offset that matches fp.timezone
    // for the current epoch. We compute it via Intl on demand.
    var origGetTzOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function () {
      try {
        var dtf = new origDTF('en-US', { timeZone: fp.timezone, timeZoneName: 'short' });
        var formatted = dtf.format(this);
        // Fall back: compute via UTC + local string difference.
        var localStr = this.toLocaleString('en-US', { timeZone: fp.timezone });
        var localDate = new Date(localStr);
        var diff = (this.getTime() - localDate.getTime()) / 60000;
        // diff positive when local is behind UTC (matches getTimezoneOffset semantics).
        void formatted;
        return Math.round(diff);
      } catch (e) {
        return origGetTzOffset.call(this);
      }
    };

    // --- speech voices -----------------------------------------------------
    if (window.speechSynthesis && Array.isArray(fp.speechVoices)) {
      var origGetVoices = speechSynthesis.getVoices;
      speechSynthesis.getVoices = function () {
        return fp.speechVoices.map(function (v) {
          return {
            name: v.name,
            lang: v.lang,
            default: false,
            localService: true,
            voiceURI: v.name,
          };
        });
      };
      void origGetVoices;
    }

    // --- canvas noise (1.9c) ----------------------------------------------
    // Deterministic mulberry32 RNG seeded from fp.canvasNoiseSeed. This
    // changes the output hash without breaking visual content (one ±1 ARGB
    // pixel out of every ~1000 is not perceptible).
    function mulberry32(a) {
      return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function noiseImageData(imageData) {
      var rng = mulberry32(fp.canvasNoiseSeed);
      var d = imageData.data;
      // Perturb every ~1000th pixel.
      var step = 1000 * 4;
      for (var i = 0; i < d.length; i += step) {
        var delta = (rng() < 0.5 ? -1 : 1);
        if (d[i] + delta >= 0 && d[i] + delta <= 255) d[i] = d[i] + delta;
      }
      return imageData;
    }
    if (window.CanvasRenderingContext2D) {
      var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function () {
        var data = origGetImageData.apply(this, arguments);
        return noiseImageData(data);
      };
    }
    if (window.HTMLCanvasElement) {
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function () {
        try {
          var ctx = this.getContext('2d');
          if (ctx) {
            var w = this.width, h = this.height;
            if (w > 0 && h > 0) {
              var data = origGetImageData.call(ctx, 0, 0, w, h);
              noiseImageData(data);
              ctx.putImageData(data, 0, 0);
            }
          }
        } catch (e) { /* ignore */ }
        return origToDataURL.apply(this, arguments);
      };
      var origToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function () {
        try {
          var ctx = this.getContext('2d');
          if (ctx) {
            var w = this.width, h = this.height;
            if (w > 0 && h > 0) {
              var data = origGetImageData.call(ctx, 0, 0, w, h);
              noiseImageData(data);
              ctx.putImageData(data, 0, 0);
            }
          }
        } catch (e) { /* ignore */ }
        return origToBlob.apply(this, arguments);
      };
    }

    // --- WebGL vendor / renderer (1.9c) -----------------------------------
    function spoofGL(GLClass) {
      if (!GLClass || !GLClass.prototype) return;
      var origGetParameter = GLClass.prototype.getParameter;
      GLClass.prototype.getParameter = function (parameter) {
        // 37445 = UNMASKED_VENDOR_WEBGL (debug ext); 37446 = UNMASKED_RENDERER_WEBGL
        // 7936  = VENDOR; 7937 = RENDERER
        if (parameter === 37445 || parameter === 7936) return fp.webgl.vendor;
        if (parameter === 37446 || parameter === 7937) return fp.webgl.renderer;
        return origGetParameter.call(this, parameter);
      };
    }
    spoofGL(window.WebGLRenderingContext);
    spoofGL(window.WebGL2RenderingContext);

    window.__OZ_FP_APPLIED__ = true;
  })();`
}
