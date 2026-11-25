# Contributing to X Creator Kit

Start with the [source build](README.md#build-from-source). For a bug, [open an issue](https://github.com/AaravKashyap12/xcreatorkit-extension/issues) with your Chrome version, extension version, steps to reproduce, and expected and actual results. Use fictional account data in examples. For a security or privacy issue, follow the [private reporting instructions](SECURITY.md).

## Test a change

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
```

Run the browser verifier for the behavior you changed. For example, use `node scripts/verify-screenshot.mjs` for the screenshot editor. See the [browser verification scripts](scripts/) for other tools. Browser tests use [synthetic fixtures](test/fixtures/).

## Send a pull request

1. Fork the repository and make a branch from the latest `main`.
2. Keep the change focused. For a new interaction, add a check to its existing verifier. Preserve manual posting, explicit capture, and the distinction between a missing reading and zero.
3. Explain what changed, how to try it, and which checks passed. For UI changes, include a screenshot with fictional data. The [design rules](docs/v1/EXTENSION-READER.md) describe the extension styles.
