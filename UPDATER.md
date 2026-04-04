# Auto Update

Fika uses Tauri v2 updater artifacts and signed releases.

## 1. Generate updater keys

```bash
npm run tauri signer generate -- -w ~/.tauri/fika.key
```

Keep the private key local or in CI only. You will get:

- private key: `~/.tauri/fika.key`
- public key: printout from the command, used at build time

## 2. Local build env

Set these before `npm run bundle:mac` or `npm run bundle:windows`:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/fika.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
export FIKA_UPDATER_PUBKEY="paste-the-public-key-here"
export FIKA_UPDATER_ENDPOINT="https://github.com/<owner>/<repo>/releases/latest/download/latest.json"
```

Then bundle normally:

```bash
npm run bundle:mac
```

## 3. App behavior

- Title bar `Update` button checks for updates.
- If a release is available, Fika downloads and installs it.
- The app relaunches after installation.

If the updater is not configured, the button shows the configuration error instead of crashing.

## 4. GitHub Actions secrets

Set these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `FIKA_UPDATER_PUBKEY`

The workflow uses:

- `https://github.com/<repo>/releases/latest/download/latest.json`

as the updater endpoint.

## 5. Release flow

1. Create a version tag such as `v0.1.1`
2. Push the tag
3. GitHub Actions builds release artifacts
4. Tauri uploads installer files and updater artifacts to the GitHub Release

After that, shipped apps can detect the new release from the in-app `Update` button.
