import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

/**
 * Short runtime-mode labels for the touch layout's folded controls trigger,
 * where the whole state has to read at a glance in one line.
 */
const RUNTIME_MODE_SHORT_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-edits",
  auto: "Auto",
  "full-access": "Full",
};

export function formatComposerInteractionModeLabel(mode: ProviderInteractionMode): string {
  return mode === "plan" ? "Plan" : "Build";
}

/**
 * Summary shown on the touch layout's folded controls trigger, e.g.
 * "High · 1M · Full · Build". The model name is left out when the model
 * picker sits beside the trigger as its own segment.
 */
export function buildComposerControlsSummary(input: {
  modelLabel?: string | null | undefined;
  traitsLabel?: string | null | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode | null;
}): string {
  const parts = [
    input.modelLabel,
    input.traitsLabel,
    RUNTIME_MODE_SHORT_LABELS[input.runtimeMode],
    input.interactionMode ? formatComposerInteractionModeLabel(input.interactionMode) : null,
  ];
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/**
 * Footer compactness. The touch layout always folds the rarely-changed
 * controls into the compact menu and keeps full-width primary action labels,
 * regardless of what the footer width measurement says.
 */
export function resolveComposerFooterCompactness(input: {
  touchLayout: boolean;
  measuredFooterCompact: boolean;
  measuredPrimaryActionsCompact: boolean;
}): { footerCompact: boolean; primaryActionsCompact: boolean } {
  if (input.touchLayout) {
    return { footerCompact: true, primaryActionsCompact: false };
  }
  return {
    footerCompact: input.measuredFooterCompact,
    primaryActionsCompact: input.measuredPrimaryActionsCompact,
  };
}
