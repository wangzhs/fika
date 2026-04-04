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

For local builds, the repo script can use `./.tauri/fika.key` automatically.

If you want to use the generated key in this repo:

```bash
mkdir -p .tauri
cp ~/.tauri/fika.key ./.tauri/fika.key
```

Set these before `npm run bundle:mac` or `npm run bundle:windows` only if you are not using `TAURI_SIGNING_PRIVATE_KEY_PATH`:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/fika.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

Then bundle normally:

```bash
npm run bundle:mac
```

## 3. App behavior

- Title bar `Update` button checks for updates.
- If a release is available, Fika downloads and installs it.
- The app relaunches after installation.

The app uses these defaults:

- updater endpoint: `https://github.com/wangzhs/fika/releases/latest/download/latest.json`
- public key: `src-tauri/updater.pub`

## 4. GitHub Actions secrets

Set these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The workflow uses:

- `https://github.com/wangzhs/fika/releases/latest/download/latest.json`

as the updater endpoint.

## 5. Release flow

1. Create a version tag such as `v0.1.1`
2. Push the tag
3. GitHub Actions builds release artifacts
4. Tauri uploads installer files and updater artifacts to the GitHub Release

After that, shipped apps can detect the new release from the in-app `Update` button.
