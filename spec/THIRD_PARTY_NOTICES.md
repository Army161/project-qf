# THIRD-PARTY NOTICES

Generated from the lockfile in CI once code exists; this is the planned V1 set. Full license texts are reproduced in the generated file.

| Component | Version | License | Copyright / notice |
|---|---|---|---|
| @meteora-ag/dynamic-bonding-curve-sdk | 1.5.13 | MIT | Copyright (c) 2026 Meteora |
| @meteora-ag/cp-amm-sdk | 1.4.10 | MIT | Meteora (see package LICENSE) |
| @solana/web3.js | 1.99.0 | MIT | Solana Foundation / contributors (server-side adapter only) |
| @sqds/multisig | 2.1.4 | MIT | Squads Labs / contributors (server-side adapter only; devnet platform treasury) |
| @solana/addresses (verifier) | 8.3.0 | MIT | Anza / contributors |
| @noble/hashes | 1.8.0 | MIT | Copyright (c) 2022 Paul Miller |
| pako (transitive via anchor) | 2.2.0 | (MIT AND Zlib) | Copyright (C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn (MIT); zlib-derived code (C) 1995-2013 Jean-loup Gailly and Mark Adler (Zlib). Allowed as exact exception QF-LIC-EX-002 (LICENSES.md §7); both notices reproduced in full below |
| @solana/kit | 8.3.0 | MIT | Anza / contributors |
| @solana-program/token-2022 | 0.19.0 | Apache-2.0 | Solana program contributors (include NOTICE if present) |
| @solana-program/token | 0.17.0 | Apache-2.0 | Solana program contributors |
| @solana/spl-token (transitive) | ^0.4.13 | Apache-2.0 | Solana program contributors |
| @coral-xyz/anchor (transitive) | ^0.31.0 | MIT OR Apache-2.0 | Anchor contributors |
| @pythnetwork/hermes-client | 3.1.0 | Apache-2.0 | Pyth Data Association / contributors |
| Solana Foundation Rewards program (devnet/localnet deployment only) | `df7517d` | MIT | Copyright (c) 2026 Solana Foundation |

| rpc-websockets (transitive, server-side adapter only) | 9.3.9 | LGPL-3.0-only | Copyright (c) Elpheria j.d.o.o.; source https://github.com/elpheria/rpc-websockets — unmodified; exception QF-LIC-EX-001, not distributed in any browser, SDK, container or on-prem artifact (LICENSES.md §5) |
| text-encoding-utf-8 (transitive) | 1.0.2 | Unlicense | public domain dedication |

Meteora on-chain programs are **not** included or distributed; QF interacts with the deployed programs only.

Rewards Merkle format note (2026-09-27): `packages/rewards` computes leaves and sorted-pair keccak parents in the format of the Solana Foundation Rewards program at `df7517d` (MIT). This is an independent implementation of that format, with no copied source.

## pako 2.2.0 — full notices (QF-LIC-EX-002, reproduced verbatim from the installed package)

### LICENSE (MIT)

```text
(The MIT License)

Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### lib/zlib/README (Zlib)

```text
Content of this folder follows zlib C sources as close as possible.
That's intended to simplify maintainability and guarantee equal API
and result.

Key differences:

- Everything is in JavaScript.
- No platform-dependent blocks.
- Some things like crc32 rewritten to keep size small and make JIT
  work better.
- Some code is different due missed features in JS (macros, pointers,
  structures, header files)
- Specific API methods are not implemented (see notes in root readme)

This port is based on zlib 1.3.2.

This port is under zlib license (see below) with contribution and addition of javascript
port under expat license (see LICENSE at root of project)

Copyright:
(C) 1995-2013 Jean-loup Gailly and Mark Adler
(C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin


From zlib's README
=============================================================================

Acknowledgments:

  The deflate format used by zlib was defined by Phil Katz.  The deflate and
  zlib specifications were written by L.  Peter Deutsch.  Thanks to all the
  people who reported problems and suggested various improvements in zlib; they
  are too numerous to cite here.

Copyright notice:

 (C) 1995-2013 Jean-loup Gailly and Mark Adler

Copyright (c) <''year''> <''copyright holders''>

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.


  Jean-loup Gailly        Mark Adler
  jloup@gzip.org          madler@alumni.caltech.edu
```

## Added with @sqds/multisig 2.1.4 (2026-10-05, transitive, server-side adapter only)

From the lockfile; licenses read from each installed package.json. Apache-2.0 packages: include NOTICE if present.

| Component | Version | License |
|---|---|---|
| @metaplex-foundation/beet-solana | 0.4.0 | Apache-2.0 |
| @metaplex-foundation/beet | 0.7.1 | Apache-2.0 |
| @metaplex-foundation/cusper | 0.0.2 | Apache-2.0 |
| @solana/buffer-layout-utils | 0.2.0 | Apache-2.0 |
| @solana/spl-token | 0.3.11 | Apache-2.0 |
| ansicolors | 0.3.2 | MIT |
| assert | 2.1.0 | MIT |
| available-typed-arrays | 1.0.7 | MIT |
| base-x | 4.0.1 | MIT |
| bs58 | 5.0.0 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bind | 1.0.9 | MIT |
| call-bound | 1.0.4 | MIT |
| debug | 4.4.3 | MIT |
| define-data-property | 1.1.4 | MIT |
| define-properties | 1.2.1 | MIT |
| dunder-proto | 1.0.1 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| for-each | 0.3.5 | MIT |
| function-bind | 1.1.2 | MIT |
| generator-function | 2.0.1 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| gopd | 1.2.0 | MIT |
| has-property-descriptors | 1.0.2 | MIT |
| has-symbols | 1.1.0 | MIT |
| has-tostringtag | 1.0.2 | MIT |
| hasown | 2.0.4 | MIT |
| inherits | 2.0.4 | ISC |
| is-arguments | 1.2.0 | MIT |
| is-callable | 1.2.7 | MIT |
| is-generator-function | 1.1.2 | MIT |
| is-nan | 1.3.2 | MIT |
| is-regex | 1.2.1 | MIT |
| is-typed-array | 1.1.15 | MIT |
| math-intrinsics | 1.1.0 | MIT |
| object-is | 1.1.6 | MIT |
| object-keys | 1.1.1 | MIT |
| object.assign | 4.1.7 | MIT |
| possible-typed-array-names | 1.1.0 | MIT |
| safe-regex-test | 1.1.0 | MIT |
| set-function-length | 1.2.2 | MIT |
| util | 0.12.5 | MIT |
| which-typed-array | 1.1.24 | MIT |
