# Notarytool Keychain Profile Setup

**Goal:** stop pasting `OZ_APPLE_ID_PASSWORD` (app-specific password) every time you run `npm run publish`.

## What this is

`xcrun notarytool` (Apple's notarization tool) can store credentials in the macOS Keychain under a named **profile**. Once stored, electron-forge can reference the profile name instead of accepting the password through environment variables.

This is the recommended Apple workflow as of Xcode 13+.

## One-time setup

Run this once in Terminal. You'll be prompted for your Apple ID app-specific password — it gets stored encrypted in your login Keychain.

```bash
xcrun notarytool store-credentials oz-notarize \
  --apple-id joserodrigo@gmail.com \
  --team-id 643BYPL29D
```

When prompted "This password will be added to your keychain so notarytool can use it. Please enter the password:", paste your app-specific password (the one from appleid.apple.com → Sign-In and Security → App-Specific Passwords).

That's it. The profile is now in your Keychain forever (until you rotate).

## Use the profile

For all future publishes, you only need three env vars instead of four:

```bash
cd ~/Documents/Claude/Projects/"Ghost Browser Clone"/oz-browser
export OZ_APPLE_SIGN_IDENTITY="Developer ID Application: Jose Rodrigo Coronel (643BYPL29D)"
export OZ_APPLE_KEYCHAIN_PROFILE=oz-notarize
export GH_TOKEN=$(gh auth token)
npm run publish
```

No more `OZ_APPLE_ID`, `OZ_APPLE_ID_PASSWORD`, or `OZ_APPLE_TEAM_ID`. The profile holds all three.

## Verify the profile exists

```bash
xcrun notarytool history --keychain-profile oz-notarize | head
```

If it lists past notarization runs (or "No notarization history" with no error), the profile is set up correctly. If you see "could not find a notary credentials profile", re-run `store-credentials`.

## Rotate the app-specific password

If you revoke the password at appleid.apple.com:

```bash
xcrun notarytool store-credentials oz-notarize \
  --apple-id joserodrigo@gmail.com \
  --team-id 643BYPL29D
```

(Same command — it overwrites.)

## Fallback

If `OZ_APPLE_KEYCHAIN_PROFILE` is NOT set, `forge.config.js` falls back to the legacy four-env-var workflow (`OZ_APPLE_ID` + `OZ_APPLE_ID_PASSWORD` + `OZ_APPLE_TEAM_ID`). Both paths produce identical signed/notarized output — keychain profile is purely an ergonomics improvement.
