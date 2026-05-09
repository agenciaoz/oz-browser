# Síntesis: el proyecto pivotó a SaaS comercial

## Lo que cambia con la pivotada

El proyecto ya no es "navegador para Jose". Es:

> **Producto SaaS comercial — clon de Ghost Browser con su mismo modelo de negocio, pero más barato.**

Esto suma capas que el plan personal no tenía:

### Nuevas capas obligatorias

1. **Backend de licencias / autenticación**
   - Login con email/password (mínimo) o OAuth (Google/GitHub)
   - Verificación de licencia al abrir el navegador
   - Logout / cierre remoto de sesión
   - Recuperación de password
   - Multi-device por usuario (límite por plan)

2. **Sistema de billing**
   - Stripe (estándar de la industria)
   - Checkout para upgrade/downgrade
   - Cancelación self-service (no hagas la trampa de Webatix)
   - Webhooks para sincronizar estado de licencia
   - Pago con crypto opcional (Ghost lo tiene; diferenciador menor)
   - Trials, promo codes, refunds

3. **Modular feature gating**
   - Plan barato (sin proxies) → desactiva GPC en runtime
   - Plan caro (con proxies) → activa GPC + auto-assign
   - El cliente (la app desktop) consulta al backend qué features tiene activas
   - Importante: gating tiene que ser cumplido server-side validado, no sólo trustear al cliente

4. **Auto-update profesional**
   - Necesitas servidor de updates (electron-updater contra GitHub Releases o S3 propio)
   - Cuando Electron sube de versión, Chromium sube → release nuevo
   - Cadencia ~mensual mínimo para no quedar atrás de Chrome en seguridad
   - Pipeline CI/CD que builde, firme, notarize y publique

5. **Backend para sync entre dispositivos** (opcional pero esperado)
   - Identities, Workspaces, Proxies sincronizados entre las máquinas del usuario
   - Mejor que el "bring your own Dropbox" de Ghost — diferenciador real

6. **Marketing site + onboarding**
   - Landing page con pricing, demo, signup
   - Documentación
   - Customer support (mínimo email)

7. **Multi-plataforma**
   - macOS day 1 (Jose lo necesita)
   - Windows muy pronto (es donde está el grueso del mercado de antidetect)
   - Linux opcional (Ghost lo tiene, mercado pequeño)

## Pricing target sugerido

Si vas a competir con Ghost Browser pero más barato, el sweet spot:

| Plan              | Ghost                  | **Tu producto (target)** | Features                           |
| ----------------- | ---------------------- | ------------------------ | ---------------------------------- |
| Free              | $0, 3 identities       | $0, 3 identities         | Hook de adquisición                |
| Basic             | $21/mo anual / $25 mes | **$12-15/mo**            | Identities ilimitadas, sin proxies |
| Pro               | $46-59/mo              | **$29-35/mo**            | + Proxy management completo        |
| Team / Enterprise | Custom                 | **$15/seat (min 5)**     | + Sync, admin console              |

Si entregas el mismo valor y cobras la mitad, sin la trampa de cancelación, ganas el segmento de Ghost descontento (Trustpilot 2.9).

## Implicaciones para el stack técnico

La recomendación de Electron + electron-browser-shell **se mantiene** y de hecho se refuerza:

- Electron facilita pipeline cross-platform (mac/win/linux desde un solo codebase)
- Auto-update built-in (electron-updater)
- Firma + notarización mac estándar
- Mismo equipo puede mantener el cliente
- Cuando crezca, la migración a fork Chromium es un proyecto de v2.0, no bloqueante

Pero ahora hay **mucho más que sólo el cliente**. La arquitectura completa:

```
┌─────────────────────────────┐
│  Desktop Client (Electron)  │  ← Multi-Identity, GPC, Workspaces
│  mac / win / linux          │
└──────────┬──────────────────┘
           │ HTTPS API
           ▼
┌─────────────────────────────┐
│  Backend SaaS               │
│  - Auth (Cognito/Auth0/Supabase) │
│  - License + entitlements   │
│  - Billing (Stripe)         │
│  - Sync data (encrypted)    │
│  - Update server            │
└─────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Marketing site + Docs      │
│  - Landing, pricing, signup │
│  - Knowledge base           │
└─────────────────────────────┘
```

## Estimado de esfuerzo

**Versión cliente desktop (lo investigado):** 8–14 semanas
**Backend SaaS (auth + billing + entitlements):** 4–6 semanas adicionales (paralelo)
**Marketing site + docs:** 2–3 semanas
**QA, soporte, launch:** 2–3 semanas

**Total realista a launch público v1:** **~5–7 meses** con un equipo de 2-3 personas (1 desktop dev, 1 backend dev, 1 producto/UX).

Solo con Jose + un dev: **8–12 meses** realista, con cortes de scope.

## Decisiones que necesitamos tomar (las preguntas)

Esto es lo que necesito que respondas para armar el plan ejecutable. Lo tienes en el siguiente documento.
