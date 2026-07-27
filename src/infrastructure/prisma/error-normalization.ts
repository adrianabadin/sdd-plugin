/**
 * Normalizes persistence errors to ensure real error messages, stacks,
 * and structured causes are preserved instead of masked by String(err).
 */
export function normalizePersistenceError(err: unknown): Error {
  if (err instanceof Error) {
    if (err.cause instanceof Error && !err.message.includes(err.cause.message)) {
      err.message = `${err.message} (Cause: ${err.cause.message})`;
    } else if (err.cause && typeof err.cause === 'object' && 'message' in err.cause) {
      const causeMsg = String((err.cause as any).message);
      if (!err.message.includes(causeMsg)) {
        err.message = `${err.message} (Cause: ${causeMsg})`;
      }
    } else if (typeof err.cause === 'string' && !err.message.includes(err.cause)) {
      err.message = `${err.message} (Cause: ${err.cause})`;
    }
    return err;
  }

  if (typeof err === 'string') {
    return new Error(err);
  }

  if (err && typeof err === 'object') {
    if ('message' in err && typeof (err as any).message === 'string') {
      const e = new Error((err as any).message);
      (e as any).cause = err;
      return e;
    }
    try {
      const e = new Error(JSON.stringify(err));
      (e as any).cause = err;
      return e;
    } catch {
      return new Error('Unknown structured persistence error');
    }
  }

  return new Error(String(err ?? 'Unknown persistence error'));
}
