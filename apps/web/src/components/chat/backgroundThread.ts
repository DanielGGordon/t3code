import { createContext } from "react";

/**
 * True for a thread kept mounted under Settings or Usage, or shown as a side chat in its
 * parent's panel; its global shortcuts and listeners stand down.
 */
export const BackgroundThreadContext = createContext(false);

/**
 * True while a thread view is pre-rendered or kept mounted hidden inside an `<Activity>`. Tiptap
 * destroys an editor whose effects do not mount within a tick, so the editor waits until shown.
 */
export const HiddenThreadViewContext = createContext(false);

/** True for a tile on the tile wall: its small timeline renders little beyond what it shows. */
export const TileThreadContext = createContext(false);
