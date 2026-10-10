# rogue

State-of-the-art HTML sync CRDT — a Fugue CRDT on a rope treap, compiled to
WebAssembly — with a DOM sync layer that makes rich-text editors collaborative
without corrupting your HTML.

## What it is

rogue is the engine behind [Pointy](https://pointy.ink)'s real-time
collaboration. Unlike engines that map a linear CRDT onto an HTML tree through an
adapter (and corrupt it in the process), rogue stores HTML *natively* — tags are
literal characters in the CRDT — so tables, lists, nested formatting, emoji, and
entities round-trip faithfully.

## Packages

| Package | Description |
|---------|-------------|
| [`@pointyink/rogue`](rogue/) | The engine — CRDT + DOM sync layer. |
| [`@pointyink/serde`](serde/) | Binary wire-format codecs (Zig / JS / Go). |
| [`@pointyink/tinymce`](plugins/tinymce/) | Drop-in TinyMCE adapter. |
| [`@pointyink/hugerte`](plugins/hugerte/) | Drop-in HugeRTE adapter. |

## Quick start

```sh
npm i @pointyink/rogue
```

```js
import { createRogueNode } from '@pointyink/rogue'

const node = await createRogueNode({
  element: document.getElementById('editor'),
  onCommit: (payload) => { /* send payload to your transport */ },
})
```

For a full collaborative editor, use a plugin:

```sh
npm i @pointyink/tinymce tinymce   # or @pointyink/hugerte hugerte
```

Full integration docs: [docs.pointy.ink](https://docs.pointy.ink).

## License

[Apache-2.0](LICENSE).
