// Factory for the daemon → extension request-id generator.
//
// Every id is prefixed with a per-run nonce so a stale response buffered by
// the extension across a daemon restart cannot alias a fresh request. Without
// this, the counter resets to 0 each daemon run, and `bufferResponse` on the
// extension side (ws-client.ts:400,416,425) can flush an old "d5" back after
// reconnect that the new daemon would then treat as the answer to its
// unrelated new "d5". The `p.ws === ws` check does not save us: both sockets
// are the same post-reconnect socket. Disjoint per-run prefixes do.
//
// Kept in its own module so tests can import it without triggering the
// daemon's main() side effects.

export function createRequestIdGenerator(nonce: string): () => string {
	let counter = 0;
	return () => `d${nonce}-${++counter}`;
}
