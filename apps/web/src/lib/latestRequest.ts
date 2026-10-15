/**
 * NOT-490: sequences overlapping detail fetches (the 4-second poll plus a
 * post-mutation refresh) so an older response can never overwrite a newer one.
 *
 * Every `run` takes a ticket at issue time. A response is applied only when its
 * ticket is newer than the last applied one — so a slow poll issued before a
 * save cannot land after the save's refresh and re-present the pre-save state.
 * The promise `run` returns settles only after its own response was applied or
 * discarded as superseded, so a caller that awaits it knows the displayed state
 * was fetched at or after that call. `invalidate` drops every request still in
 * flight (e.g. when the page switches to another issue).
 */
export function createLatestRequestGate() {
  let issued = 0;
  let applied = 0;
  return {
    run<T>(request: () => Promise<T>, apply: (value: T) => void, fail: (error: unknown) => void): Promise<void> {
      const ticket = ++issued;
      return request().then(
        (value) => {
          if (ticket <= applied) return;
          applied = ticket;
          apply(value);
        },
        (error) => {
          if (ticket <= applied) return;
          applied = ticket;
          fail(error);
        }
      );
    },
    invalidate(): void {
      applied = issued;
    },
  };
}
