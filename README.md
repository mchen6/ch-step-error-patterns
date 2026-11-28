# @countinghouse/ch-step-error-patterns

countinghouse step module: the few lines that matter from a failed CI job: the exit line, errors, assertions, the first stack frames, or the failing step's tail.

**Status: preview.** Runs on [countinghouse](https://github.com/mchen6/countinghouse)
8.0 or later. A step module of the countinghouse client packs: a `part`, loaded by a scenario and never listed to the model on its own.

Part of the countinghouse client packs. Each package has its own repository. The family's design and plan are in
[ch-packs](https://github.com/mchen6/ch-packs) (public); the end-to-end acceptance test, which installs every package and calls the
tool, runs in [ch-local](https://github.com/mchen6/ch-local)'s CI.

## A failed assertion's values

`details` holds the expected and actual values it finds for a failed assertion
of the failing step, beside `lines`: they don't count against `maxLines` and
never reach the failure signature. A format it does not recognise gives none.
The bounds are 12 value lines and 1,500 characters per failure, and 40 lines and
4,000 characters per call. Every bound except the 12 value lines also counts the
assertion's own line.
`cut` and `omittedBlocks` say when a bound left anything out. A failure's values
end at its first stack frame (node's `actual` and `expected` after the frames
are read when nothing comes before them), at two blank lines, at the first other
line outside an open bracket that is neither a diff's nor a value's and is
indented less than the assertion's own (or not at all, when that one isn't; a
Rust panic's message is the exception), or where something else starts; what
follows is not counted as left out. Node's comparison, the last line before an assertion's
first stack frame (`1 !== 0`), is one of its values even when a long message
ended them before it.

The values are log text and can hold what a test compared. A value the screen
judges not to be words, a number or a name is withheld as `<withheld>`, or, for
a whole line, `<value line withheld>`. The same screen covers `lines`: each
step's kept lines are judged together, in log order, and a value withheld there
reaches the failure signature as `<withheld>` (`rules` 6, so a cache keyed on the
rules is rebuilt).

Words in any script read as words, and symbols (a test runner's `●`, `✕`, an
arrow) as symbols. A token mixing letters outside Latin with digits, a run of
letters from two scripts, a run of an alphabet longer than 24 letters or of
Han, kana or Hangul longer than 32 characters, Braille, emoji and private-use
characters are withheld; accented and fullwidth Latin letters are judged as
the ASCII ones. A short value written in the letters of a script other than
Latin may not be screened.

This part does not redact; pass its output through ch-step-redact, as the pack
does. The screen is a second layer, not a guarantee: a short secret, one written
in groups, or one that reads like ordinary words or a plain number can still
pass, and occasionally a longer one, whole or in part.

## Development

```
npm ci
npm test
npm run validate   # packs the module and runs countinghouse-validate on the tarball
```

Pure JavaScript, no native module. Node 22.16 or later, as countinghouse. CI
runs Node 24 on Linux, macOS and Windows, and Node 22.16, the floor, on Linux.

## Publishing

Releases are published by `.github/workflows/publish.yml` under npm
trusted publishing: a `v<version>` tag on a `main` commit whose
package.json carries that version. No npm token exists anywhere and no 2FA
code is typed for a release. One-time setup on npmjs.com, by the
maintainer: the package is first published by hand, as a placeholder: in an empty
directory, a package.json holding only name, version "0.0.1-placeholder.0"
and description "Placeholder for the first release; not for use. Install a
released version.", then `npm publish --access public --tag placeholder`
(2FA). The one-time placeholder publish uses a throwaway pre-release
version (e.g. 0.0.1-placeholder.0) under a dist-tag other than latest
(e.g. `--tag placeholder`), never the release's version; deprecate it once
the real version is out. Then check `npm dist-tag ls <package>`: if
`latest` names the placeholder, `npm install <package>` installs it until
the real version is published (publishing the real version without
`--tag` moves `latest` to it), so publish the real version before the
package's name is given to anyone. Then **Settings → Trusted publishing → GitHub
Actions** with owner `mchen6`, repository `ch-step-error-patterns`, workflow
`publish.yml`, allowing `npm publish` as well as `npm stage publish`;
then **Settings → Publishing access → Require two-factor authentication
and disallow tokens**. A new trusted-publisher configuration must publish
once within two days or it expires.

## License

Apache-2.0.
