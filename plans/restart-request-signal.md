# Restart-Requested Signal Across Project Chats — Decision Doc

## 1. The core problem & the one hard sub-problem

When an AI agent in one chat asks the human to restart a shared server/service, the other chats on the same project keep working against a service that's mid-restart (or expected to go down). We want to surface that request to the sibling chats. Every option splits into the same two halves: a **DETECTION** signal (how we know a restart is being asked for) and a **project-level pending-restart state + UI expression** of it. The UI half is well-trodden — it rides the existing shell-projection → sidebar/banner machinery. The genuinely hard, shared sub-problem is **DETECTION**, because it's the one place the options actually disagree and the one place a wrong answer has real cost.

### Detection approaches compared

| Approach                                                                                         | Used by      | Determinism                    | Payload (which service/why) | Cost of a wrong hit         | Provider cooperation                   |
| ------------------------------------------------------------------------------------------------ | ------------ | ------------------------------ | --------------------------- | --------------------------- | -------------------------------------- |
| **NL keyword/regex classifier** in a reactor over completed `thread.message-sent`                | Opt 1, Opt 2 | Fuzzy (false pos/neg)          | Best-effort capture         | Low in passive/banner modes | None — works today                     |
| **Structured agent marker** (magic token or no-op tool) recognized in `runtimeEventToActivities` | Opt 3        | Deterministic                  | Carries reason              | High if blocking            | Needs prompt/tool registration         |
| **Dedicated `request_restart` tool** + **manual "flag this chat" fallback**                      | Opt 4        | Deterministic + human override | First-class payload         | Deterministic, so ~none     | Tool ideal, manual path covers the gap |

**Recommendation: start with the dead-simple MVP, design the state to be signal-agnostic.**

- **MVP signal (ship day 1):** a **manual "flag: needs restart" toggle** per chat, dispatching the internal command directly. Zero classifier, zero provider cooperation, zero false positives — the human (or an agent instructed to say so) sets it. This is Option 4's "manual fallback" promoted to the primary MVP signal.
- **Layer in next:** the **NL keyword classifier in a decoupled reactor** (CheckpointReactor template) so agents trigger it automatically without provider changes. Safe precisely because early UI rungs don't block.
- **Only if/when you reach the blocking rung:** upgrade to a **structured marker/tool** so a machine-set freeze fires on an explicit signal, not a regex guess.

The key architectural point: **all three feed the exact same `thread.restart-requested` command/event and the same project-level pending state.** Detection is swappable behind that seam. Pick the cheap one first; don't let detection block shipping.

## 2. The options are a ladder, not a menu

The four options are not competitors — they are **progressively stronger UI expressions of one underlying signal + one project-level pending-restart state.** Each rung reuses the same contract field, the same reactor/command, the same shell projection. You ship rung 1, and rungs 2–4 are additive on top of the same plumbing.

```
Rung 1  Passive highlight   (Opt 1)  — inform, never interrupt
Rung 2  Banner on open      (Opt 2)  — warn every sibling chat
Rung 3  Block-send + bypass (Opt 3)  — physically steer, softly
Rung 4  Coordinate / resolve(Opt 4)  — shared lock + one-click release
```

The heavy, shared cost is paid **once** at rung 1: threading a new flag end-to-end (contract → decider → projector → SQL column → snapshot query → store → summary → equality checks → component). After that, each higher rung is mostly a new UI surface reading state that already exists.

## 3. The ladder

| Rung                                | User sees                                                                                                                                                                                  | Key files to touch                                                                                                                                                                                                                                                     | Effort                          | Main risk                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Passive highlight** (Opt 1)    | Amber "Restart Requested" pill on the requesting chat + faint tint on sibling rows + in-chat header pill. Send fully open.                                                                 | `contracts/orchestration.ts`, new `RestartRequestReactor.ts`, `decider.ts`, `projector.ts`, `ProjectionPipeline.ts`, `ProjectionSnapshotQuery.ts`, `ProjectionThreads.ts`, `store.ts`, `Sidebar.logic.ts`, `ThreadStatusIndicators.tsx`, `Sidebar.tsx`, `ChatView.tsx` | L (full flag pipeline)          | Purely advisory — a user not looking at the sidebar keeps typing into a doomed chat.                                                                              |
| **2. Banner on open** (Opt 2)       | Top-of-conversation banner: strong/non-dismissible in the requester, dismissible "another agent is requesting a restart of `<service>` — hold if you can" in siblings. Still no send gate. | + new `RestartRequestBanner.tsx` at `ChatView.tsx:3768`; `versionSkew.ts` dismissal pattern                                                                                                                                                                            | +S over rung 1                  | Cries wolf → users reflex-dismiss; service-name capture is best-effort.                                                                                           |
| **3. Block-send + bypass** (Opt 3)  | Composer send hard-disabled project-wide while a restart is pending, with per-device "Send anyway" and a human-only "Restart done".                                                        | + project-level `pendingRestart` on `OrchestrationProjectShell`; all THREE send gates: `ComposerPrimaryActions.tsx:200`, `onSend` guard `ChatView.tsx:2838`, `ChatComposer.tsx:1043/1593`; clear RPC                                                                   | L (3 gates + clear + backstops) | **Stuck-blocked state** — machine-set, human-cleared; a forgotten "Restart done" freezes the whole project. Also over-blocks unrelated chats.                     |
| **4. Coordinate / resolve** (Opt 4) | Project-header chip "N agents waiting to restart", one-click "Mark restarted" clears the signal across all siblings atomically, optional "Restart now" via configured `ProjectScript`.     | + durable `project_restart_coordination` projector/row, `resolveRestartRequest(projectId)` + request RPCs in `environmentApi.ts`/`service.ts`, `Sidebar.tsx` header chip                                                                                               | L (highest surface)             | Assumes one restart concern per project; concurrent unrelated restarts collapse into one row unless keyed by service. Depends on the tool/manual flag being used. |

Cross-cutting risk for every rung: **"same project" is ambiguous** — physical `projectId` vs logical repo group (`memberProjectRefs`). Pick one deliberately or you tint/warn/block the wrong rows.

## 4. Recommendation

**Build a thin vertical slice first — one signal, one state, one UI expression — then climb the ladder.**

**MVP slice (ship this):**

1. **Signal:** manual **"flag: needs restart" toggle** per chat → new internal command (Option 4's manual path, no classifier, no provider work).
2. **State:** the new `thread.restart-requested` / `thread.restart-cleared` event + a per-thread `requestingRestart` flag, rolled up to a **project-level pending-restart field on `OrchestrationProjectShell`** so it's authoritative and rides `subscribeShell` to every device. Build this project-level rollup now even though rung 1 only needs the per-thread flag — rungs 3 and 4 both depend on it, and adding it later is a second migration.
3. **UI:** **rung 1 + rung 2** together — the sidebar pill/sibling tint _and_ the sibling "hold if you can" banner. Both are cheap once the flag exists, and the banner is what actually delivers the "steer away from the other chats" goal. Neither blocks send, so false positives are harmless.

**Natural follow-ups (in order):**

- **Add the NL keyword reactor** as a second, automatic signal source into the same command — agents now trigger it without anyone toggling. Still non-blocking, so still safe.
- **Rung 4 resolve action:** one-click "Mark restarted" that clears the project-scoped state everywhere at once, plus optional "Restart now" via `ProjectScript`. This is the coordination/handoff payoff and it's the mitigation for the next rung.
- **Rung 3 blocking, last and optional.** Only add the hard send-gate once rung 4's **resolve action already exists**, because the resolve action is exactly what prevents the stuck-blocked state: a machine-set freeze is only safe when there's a loud, one-click human release (plus "Send anyway" per-device bypass, TTL auto-expire, and auto-clear-on-next-turn as backstops). If you also promote detection to a structured marker/tool at this point, the freeze fires only on an explicit agent signal, not a regex guess. **Don't ship blocking on top of a fuzzy classifier with no resolve button — that's the one combination that can trap the user.**

**Bottom line:** the state model is the investment; the UI rungs are cheap increments on it. Ship manual-flag + sibling pill + "hold if you can" banner first (rungs 1–2, non-blocking, provider-agnostic). Add the auto-classifier and the one-click resolve next. Treat block-send as an opt-in capstone that is only safe once resolve + backstops exist.
