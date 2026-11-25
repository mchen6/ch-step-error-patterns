# @countinghouse/ch-step-error-patterns

countinghouse step module: the few lines that matter from a failed CI job: the exit line, errors, assertions, the first stack frames, or the failing step's tail.

**Status: preview.** Runs on [countinghouse](https://github.com/mchen6/countinghouse)
8.0 or later (unreleased; the release that carries the remote client and
local mode). A step module of the countinghouse client packs: a `part`, loaded by a scenario and never listed to the model on its own.

Part of the countinghouse client packs. Each package has its own repository. The family's design and plan are in
[ch-packs](https://github.com/mchen6/ch-packs) (public); the end-to-end acceptance test, which installs every package and calls the
tool, runs in [ch-local](https://github.com/mchen6/ch-local)'s CI.

## A failed assertion's values

`details` holds the expected and actual values it finds for a failed assertion,
beside `lines`: they don't count against `maxLines` and never reach the failure
signature. A format it does not recognise gives none. The bounds are 12 value
lines and 1,500 characters per failure, and 40 lines and 4,000 characters per
call. Every bound except the 12 value lines also counts the assertion's own line.
`cut` and `omittedBlocks` say when anything was left out.

The values are log text and can hold what a test compared. A value the screen
judges not to be words, a number or a name is withheld as `<withheld>`, or, for
a whole line, `<value line withheld>`. The screen covers `details` only: a line
in `lines` is not screened.

This part does not redact; pass its output through ch-step-redact, as the pack
does. The screen is a second layer, not a guarantee: a short secret, or one that
reads like ordinary words or a plain number, can still pass.

## Development

```
npm ci
npm test
npm run validate   # packs the module and runs countinghouse-validate on the tarball
```

Pure JavaScript, no native module. Node 22.16 or later, as countinghouse. CI
runs Node 24 on Linux, macOS and Windows.

## Publishing

Releases are published by `.github/workflows/publish.yml` under npm
trusted publishing: a `v<version>` tag on a `main` commit whose
package.json carries that version. No npm token exists anywhere and no 2FA
code is typed for a release. One-time setup on npmjs.com, by the
maintainer: the package's first version is published by hand (`npm publish
--access public`, with 2FA); then **Settings → Trusted publishing → GitHub
Actions** with owner `mchen6`, repository `ch-step-error-patterns`, workflow
`publish.yml`, allowing `npm publish` as well as `npm stage publish`;
then **Settings → Publishing access → Require two-factor authentication
and disallow tokens**. A new trusted-publisher configuration must publish
once within two days or it expires.

## License

Apache-2.0.
