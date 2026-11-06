import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makePausableAtomRegistry } from "./pausableAtomRegistry";

describe("makePausableAtomRegistry", () => {
  it("holds notifications while paused and delivers the latest value on resume", () => {
    const registry = AtomRegistry.make();
    const count = Atom.make(0);
    const pausable = makePausableAtomRegistry(registry);
    const seen: number[] = [];
    const quiet: number[] = [];
    pausable.registry.subscribe(count, (value) => seen.push(value));
    const unsubscribe = pausable.registry.subscribe(count, (value) => quiet.push(value));

    pausable.setPaused(true);
    pausable.registry.set(count, 1);
    registry.set(count, 2);
    unsubscribe();
    expect(seen).toEqual([]);
    expect(pausable.registry.get(count)).toBe(2);

    pausable.setPaused(false);
    expect(seen).toEqual([2]);
    registry.set(count, 3);
    expect(seen).toEqual([2, 3]);
    expect(quiet).toEqual([]);
  });
});
