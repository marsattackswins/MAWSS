import "server-only";

/**
 * Single-process serialization for mutations that change exchange exposure.
 * The queue is deliberately process-local; the terminal has no distributed
 * execution responsibility.
 */
let active = false;
const waiters: Array<() => void> = [];

/**
 * Emergency lane budget: an emergency mutation may wait at most this long for
 * the queue. After that it proceeds without the lock (the running task is
 * never preempted), using fresh reads, reduce-only orders and post-close
 * verification instead.
 */
export const EMERGENCY_MAX_WAIT_MS = 3_000;

function acquire(): Promise<void> {
  if (!active) {
    active = true;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active = false;
}

export async function withRiskMutation<T>(operation: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * Priority lane: joins the FRONT of the waiting line (never preempting the
 * task that is running), and gives up after `maxWaitMs`. `waitedOut` tells the
 * caller its operation is running without the lock, so it must rely on fresh
 * exchange reads rather than queue exclusivity.
 */
export async function withEmergencyMutation<T>(
  operation: () => Promise<T>,
  maxWaitMs = EMERGENCY_MAX_WAIT_MS,
): Promise<{ result: T; waitedOut: boolean }> {
  if (!active) {
    active = true;
    try {
      return { result: await operation(), waitedOut: false };
    } finally {
      release();
    }
  }

  let acquired = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const grant = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      acquired = true;
      resolve();
    };
    waiters.unshift(grant);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = waiters.indexOf(grant);
      if (index >= 0) waiters.splice(index, 1);
      resolve();
    }, maxWaitMs);
  });

  if (!acquired) return { result: await operation(), waitedOut: true };
  try {
    return { result: await operation(), waitedOut: false };
  } finally {
    release();
  }
}

/** Synchronous seam for event handlers that must preserve synchronous errors. */
function releaseAfter<T>(result: T | Promise<T>): T | Promise<T> {
  if (result instanceof Promise) return result.finally(release);
  release();
  return result;
}

export function withRiskMutationSync<T>(operation: () => T): T | Promise<T> {
  if (!active) {
    active = true;
    try {
      return releaseAfter(operation());
    } catch (error) {
      release();
      throw error;
    }
  }
  return acquire().then(() => {
    try {
      return releaseAfter(operation());
    } catch (error) {
      release();
      throw error;
    }
  });
}

/** Waits for all currently queued mutation work, then holds the queue. */
export async function acquireRiskMutationDrain(): Promise<() => void> {
  await acquire();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

export function resetMutationQueueForTests(): void {
  active = false;
  waiters.length = 0;
}
