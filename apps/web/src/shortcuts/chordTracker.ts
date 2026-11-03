import type { KeybindingWhenNode, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { matchesKeybindingShortcut, type ShortcutEventLike } from "@t3tools/shared/keybindings";

/**
 * A chord is two keydowns (`ctrl+e` then `s`), but every shortcut resolver is stateless and several
 * of them run per event. This tracker sees each keydown exactly once, ahead of them all, and
 * records on the completing event which keydown armed it; resolvers read that instead of state.
 */
const CHORD_TIMEOUT_MS = 2000;
const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "altgraph", "capslock", "os"]);

const completions = new WeakMap<object, ShortcutEventLike>();
let armed: KeyboardEvent | null = null;

/** The keydown that armed the chord this event completes, if any. */
export function chordPrefixFor(event: object): ShortcutEventLike | null {
  return completions.get(event) ?? null;
}

// `true`/`false` when the clause is decided by `known`, `null` when it depends on state only the
// component that handles the key can see.
function evaluateKnownWhen(
  node: KeybindingWhenNode,
  known: Readonly<Record<string, boolean>>,
): boolean | null {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return known[node.name] ?? null;
    case "not": {
      const inner = evaluateKnownWhen(node.node, known);
      return inner === null ? null : !inner;
    }
    case "and": {
      const left = evaluateKnownWhen(node.left, known);
      const right = evaluateKnownWhen(node.right, known);
      if (left === false || right === false) return false;
      return left === null || right === null ? null : true;
    }
    case "or": {
      const left = evaluateKnownWhen(node.left, known);
      const right = evaluateKnownWhen(node.right, known);
      if (left === true || right === true) return true;
      return left === null || right === null ? null : false;
    }
  }
}

/**
 * Advance the chord state for one keydown. Returns whether the event must be swallowed: the key
 * that arms a chord, and a wrong key while armed, must not reach the page or a focused field.
 * `known` holds the when-variables the caller can read; a chord whose clause is undecided arms.
 */
export function advanceChord(
  event: KeyboardEvent,
  keybindings: ResolvedKeybindingsConfig,
  known: Readonly<Record<string, boolean>>,
  platform: string,
): boolean {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) return false;
  const prefix =
    armed !== null && event.timeStamp - armed.timeStamp <= CHORD_TIMEOUT_MS ? armed : null;
  armed = null;

  const chords = keybindings.filter(
    (binding) =>
      binding.second !== undefined &&
      (binding.whenAst === undefined || evaluateKnownWhen(binding.whenAst, known) !== false),
  );
  if (
    prefix !== null &&
    chords.some(
      (binding) =>
        matchesKeybindingShortcut(prefix, binding.shortcut, platform) &&
        binding.second !== undefined &&
        matchesKeybindingShortcut(event, binding.second, platform),
    )
  ) {
    completions.set(event, prefix);
    return false;
  }
  if (chords.some((binding) => matchesKeybindingShortcut(event, binding.shortcut, platform))) {
    armed = event;
    return true;
  }
  return prefix !== null;
}
