import type { AtomRegistry } from "effect/reactivity/AtomRegistry";

/**
 * A view of `registry` whose subscribers hear nothing while paused and catch up on resume.
 * Atoms stay mounted, so a hidden subtree keeps its data current without re-rendering.
 */
export function makePausableAtomRegistry(registry: AtomRegistry) {
  let paused = false;
  const missed = new Set<() => void>();
  const subscribe: AtomRegistry["subscribe"] = (atom, listener, options) => {
    const catchUp = () => listener(registry.get(atom));
    const unsubscribe = registry.subscribe(
      atom,
      (value) => {
        if (paused) missed.add(catchUp);
        else listener(value);
      },
      options,
    );
    return () => {
      missed.delete(catchUp);
      unsubscribe();
    };
  };
  const bound = new Map<PropertyKey, unknown>();
  const view = new Proxy(registry, {
    get(target, key) {
      if (key === "subscribe") return subscribe;
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      let method = bound.get(key);
      if (method === undefined) {
        method = value.bind(target);
        bound.set(key, method);
      }
      return method;
    },
  });
  const setPaused = (next: boolean) => {
    paused = next;
    if (paused) return;
    const pending = [...missed];
    missed.clear();
    for (const catchUp of pending) catchUp();
  };
  return { registry: view, setPaused };
}
