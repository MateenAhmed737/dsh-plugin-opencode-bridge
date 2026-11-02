# Notices

dsh-plugin-opencode-bridge is MIT licensed (see LICENSE). It reuses ideas and
small pieces of code from the projects below, under their MIT licenses.

## T3 Code

The way this plugin runs OpenCode follows T3 Code's OpenCode provider
(`packages/provider-opencode`): starting the user's own `opencode serve` on
127.0.0.1 with the user's environment and a generated password, the version
check, the process-tree cleanup, the OpenCode 1.x/2.x split, the permission
rules, the event handling, the model catalog, and the provider error messages
(`readableProviderErrorMessage` in `src/errors.ts` is adapted from
`providerErrorMessage.ts`).

https://github.com/pingdotgg/t3code

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @quonaro/dsh-plugin-opencode

The DSH plugin shape (cordis `inject`, `registerAdapter`,
`registerConfigurableProviders`, the Schemastery config and `cordis.patch.yml`)
and the local session-title handling follow @quonaro/dsh-plugin-opencode,
Copyright (c) 2026 quonaro, MIT License.
