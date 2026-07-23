// H11 request queue: serialise every incoming RPC through a single tail
// promise so `switchDoc → requireDocumentType → handler` executes as an
// uninterruptible section against the one shared editor.
//
// A queue slot is force-released after `slotTimeoutMs` even if its task
// never settles (some EDA calls hang forever, e.g. getPdfFile in the web
// app), so one wedged call cannot block the tab permanently. The task is
// still running when we force-release; it can complete arbitrarily later,
// concurrently with the next queued task. Without a guard, the late
// completion would still call sendResponse (spoofing a late answer) and
// could run eda.* mutations against whichever document is now active.
//
// The `isForceReleased()` callback is the guard the task pipeline uses to
// abandon side effects (response send, further eda calls) after its slot
// has been force-released. See ws-client.ts handleMessage for the call
// sites. The check is per-task, not global: each task gets its own flag.

export interface RequestQueue {
	enqueue(task: (isForceReleased: () => boolean) => Promise<void>): void;
}

export interface RequestQueueOptions {
	slotTimeoutMs: number;
	getTail: () => Promise<void>;
	setTail: (tail: Promise<void>) => void;
	onForceRelease?: () => void;
}

export function createRequestQueue(opts: RequestQueueOptions): RequestQueue {
	return {
		enqueue(task) {
			const tail = opts.getTail();
			const next = tail.then(() => runSlot(task, opts));
			opts.setTail(next);
		},
	};
}

function runSlot(
	task: (isForceReleased: () => boolean) => Promise<void>,
	opts: RequestQueueOptions,
): Promise<void> {
	let released = false;
	let forceReleased = false;
	let release!: () => void;
	const slot = new Promise<void>((resolve) => {
		release = () => {
			if (!released) {
				released = true;
				resolve();
			}
		};
	});
	const timer = setTimeout(() => {
		forceReleased = true;
		try {
			opts.onForceRelease?.();
		} catch { /* logging must never throw */ }
		release();
	}, opts.slotTimeoutMs);
	task(() => forceReleased).then(
		() => {
			clearTimeout(timer);
			release();
		},
		() => {
			clearTimeout(timer);
			release();
		},
	);
	return slot;
}
