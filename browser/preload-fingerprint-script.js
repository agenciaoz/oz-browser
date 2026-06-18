// OZ Browser — Fingerprint override-script builder (1.9b + 1.9.5).
//
// Qué hace: construye el IIFE string que aplica los 11 vectores de
// fingerprint en el page world. Extraído del preload-fingerprint.js a un
// módulo separado para que sea testeable sin Electron (el preload
// real requiere `electron`, este módulo es puro string-builder).
//
// Doc: docs/modules/preload-fingerprint-script.md
// ADR: docs/architecture/0018-fingerprint-engine.md
//
// Exports: buildOverridesScript(fp) → string (IIFE listo para
//   webFrame.executeJavaScript en preload, o vm.runInContext en tests)

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
 *
 * Idempotent: re-running the script is a no-op (window.__OZ_FP_APPLIED__).
 */
function buildOverridesScript(fp) {
  // Serialize the fingerprint as a JSON literal embedded in the script.
  const fpJson = JSON.stringify(fp)
  // The script body is wrapped in an IIFE so it leaves no globals behind
  // beyond the __OZ_FP_APPLIED__ flag.
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
    var origGetTzOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function () {
      try {
        var localStr = this.toLocaleString('en-US', { timeZone: fp.timezone });
        var localDate = new Date(localStr);
        var diff = (this.getTime() - localDate.getTime()) / 60000;
        return Math.round(diff);
      } catch (e) {
        return origGetTzOffset.call(this);
      }
    };

    // --- speech voices -----------------------------------------------------
    if (typeof speechSynthesis !== 'undefined' && Array.isArray(fp.speechVoices)) {
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
    }

    // --- canvas noise (1.9c) ----------------------------------------------
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
      var step = 1000 * 4;
      for (var i = 0; i < d.length; i += step) {
        var delta = (rng() < 0.5 ? -1 : 1);
        if (d[i] + delta >= 0 && d[i] + delta <= 255) d[i] = d[i] + delta;
      }
      return imageData;
    }
    if (typeof CanvasRenderingContext2D !== 'undefined') {
      var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function () {
        var data = origGetImageData.apply(this, arguments);
        return noiseImageData(data);
      };
      if (typeof HTMLCanvasElement !== 'undefined') {
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
          } catch (e) {}
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
          } catch (e) {}
          return origToBlob.apply(this, arguments);
        };
      }
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
    if (typeof WebGLRenderingContext !== 'undefined') spoofGL(WebGLRenderingContext);
    if (typeof WebGL2RenderingContext !== 'undefined') spoofGL(WebGL2RenderingContext);

    // --- stealth defaults (v3-C) ------------------------------------------
    // The top behavioural/headless tells, always-on (identity-independent):
    //  1) navigator.webdriver → false (puppeteer/selenium flag).
    //  2) window.chrome.runtime shape (headless Chrome lacks window.chrome).
    //  3) permissions.query('notifications') must agree with Notification.permission
    //     (classic headless mismatch: 'denied' vs 'default').
    defineGetter(navigator, 'webdriver', function () { return false; });
    try {
      if (!window.chrome) {
        window.chrome = { runtime: {}, app: { isInstalled: false } };
      } else if (!window.chrome.runtime) {
        window.chrome.runtime = {};
      }
    } catch (e) {}
    try {
      if (navigator.permissions && navigator.permissions.query) {
        var origQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = function (p) {
          if (p && p.name === 'notifications') {
            return Promise.resolve({
              state: (typeof Notification !== 'undefined' && Notification.permission) || 'default',
              onchange: null,
            });
          }
          return origQuery(p);
        };
      }
    } catch (e) {}

    window.__OZ_FP_APPLIED__ = true;
  })();`
}

module.exports = { buildOverridesScript }
