// Public API barrel for @pointyink/rogue. Hand-authored (it's the deliberate
// export contract); the type *bodies* it re-exports are generated from the
// source JSDoc via `make build-types` into ./types/.

export { createRogueNode } from './types/sync.js'
export type { RogueNode, RogueNodeOptions } from './types/sync.js'

export { DomRope, buildRope } from './types/dom_rope.js'
export type { SerializeNode, OmitNode, UnwrapNode } from './types/dom_rope.js'

export { createComments, resolveAnchor, anchorForRange } from './types/comments.js'
export type { Comments, CommentsOptions, ResolvedThread, DomRange, Comment, Reply, CommentsFetcher } from './types/comments.js'

export { createSuggestions } from './types/suggestions.js'
export type { Suggestions, SuggestionsOptions, ResolvedSuggestion, Suggestion } from './types/suggestions.js'

export { createEditorSession } from './types/editor-session.js'
export type { EditorSurface, EditorSessionOptions } from './types/editor-session.js'

export { RogueText } from './types/rogue_text.js'

export { CrdtErrorKind, CrdtErrorNames, parseCrdtError } from './types/crdt_error.js'
export type { CrdtError } from './types/crdt_error.js'

export { resolveReplicaId, syncBaseUrlFromWsUrl, persistedReplicaId } from './types/replica.js'
