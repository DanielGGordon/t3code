import { memo } from "react";
import { ArrowUpIcon, CheckIcon, MicIcon, XIcon } from "lucide-react";

import { formatVoiceDictationElapsed, type VoiceDictation } from "../../voice/useVoiceDictation";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Composer voice input. Idle: a mic button. Recording: cancel, a live timer,
 * "insert" (transcript lands in the composer for review) and "send"
 * (transcript is sent straight away). Sized for touch — it is used from
 * phones and the car.
 */
export const ComposerVoiceInput = memo(function ComposerVoiceInput(props: {
  dictation: VoiceDictation;
  disabled: boolean;
  canSend: boolean;
}) {
  const { dictation } = props;

  if (dictation.phase === "transcribing") {
    return (
      <span
        className="flex h-9 items-center gap-2 px-2 text-muted-foreground text-xs sm:h-8"
        role="status"
      >
        <Spinner className="size-3.5" aria-hidden="true" />
        Transcribing…
      </span>
    );
  }

  if (dictation.phase === "recording") {
    return (
      <div
        className="flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/6 p-0.5"
        data-voice-dictation="recording"
      >
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="rounded-full text-muted-foreground"
          onClick={dictation.cancel}
          aria-label="Cancel voice input"
        >
          <XIcon className="size-4" />
        </Button>
        <span
          className="flex items-center gap-1.5 px-1 font-medium text-destructive text-xs tabular-nums"
          aria-live="off"
        >
          <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
          {formatVoiceDictationElapsed(dictation.elapsedMs)}
        </span>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="rounded-full"
          onClick={() => dictation.finish("insert")}
          aria-label="Stop and insert transcript"
        >
          <CheckIcon className="size-4" />
        </Button>
        {props.canSend ? (
          <Button
            type="button"
            size="icon"
            className="rounded-full"
            onClick={() => dictation.finish("send")}
            aria-label="Stop and send"
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="shrink-0 rounded-full text-muted-foreground/70 hover:text-foreground/80"
            onClick={dictation.start}
            disabled={props.disabled || dictation.phase === "starting"}
            aria-label="Voice input"
          />
        }
      >
        {dictation.phase === "starting" ? (
          <Spinner className="size-3.5" aria-hidden="true" />
        ) : (
          <MicIcon aria-hidden="true" className="size-4" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">Voice input</TooltipPopup>
    </Tooltip>
  );
});
