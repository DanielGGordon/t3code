import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { assert, describe, it } from "vite-plus/test";

import { advanceChord, chordPrefixFor } from "./chordTracker";

const keybindings = compileResolvedKeybindingsConfig([
  { key: "ctrl+e s", command: "sidebar.toggle" },
  { key: "ctrl+e d", command: "diff.toggle", when: "!terminalFocus" },
]);

function keydown(key: string, init: { ctrlKey?: boolean; timeStamp?: number } = {}): KeyboardEvent {
  const { ctrlKey = false, timeStamp = 0 } = init;
  return {
    key,
    ctrlKey,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    timeStamp,
  } as KeyboardEvent;
}

const advance = (event: KeyboardEvent, known: Record<string, boolean> = {}) =>
  advanceChord(event, keybindings, known, "Linux");

describe("advanceChord", () => {
  it("swallows the first key and marks the second as completing it", () => {
    const first = keydown("e", { ctrlKey: true });
    const second = keydown("s");
    assert.isTrue(advance(first));
    assert.isFalse(advance(second));
    assert.strictEqual(chordPrefixFor(second), first);
    assert.isNull(chordPrefixFor(first));
  });

  it("keeps the chord armed across a modifier keydown", () => {
    const first = keydown("e", { ctrlKey: true });
    assert.isTrue(advance(first));
    assert.isFalse(advance(keydown("Control")));
    const second = keydown("d");
    advance(second);
    assert.strictEqual(chordPrefixFor(second), first);
  });

  it("swallows a wrong second key and then disarms", () => {
    assert.isTrue(advance(keydown("e", { ctrlKey: true })));
    assert.isTrue(advance(keydown("x")));
    const third = keydown("s");
    assert.isFalse(advance(third));
    assert.isNull(chordPrefixFor(third));
  });

  it("lets the first key through when no chord can apply to it", () => {
    assert.isFalse(advance(keydown("e")));
  });

  it("expires an armed chord", () => {
    assert.isTrue(advance(keydown("e", { ctrlKey: true, timeStamp: 0 })));
    const late = keydown("s", { timeStamp: 5000 });
    assert.isFalse(advance(late));
    assert.isNull(chordPrefixFor(late));
  });

  it("ignores a chord whose when clause is known to fail", () => {
    const onlyDiff = compileResolvedKeybindingsConfig([
      { key: "ctrl+e d", command: "diff.toggle", when: "!terminalFocus" },
    ]);
    assert.isFalse(
      advanceChord(keydown("e", { ctrlKey: true }), onlyDiff, { terminalFocus: true }, "Linux"),
    );
    assert.isTrue(advanceChord(keydown("e", { ctrlKey: true }), onlyDiff, {}, "Linux"));
  });
});
