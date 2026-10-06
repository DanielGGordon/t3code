import { memo } from "react";
import { ArrowUpIcon, CheckIcon, MicIcon, XIcon } from "lucide-react";

import { formatVoiceDictationElapsed, type VoiceDictation } from "../../voice/useVoiceDictation";
import { Button } from "../ui/button";
import { ComposerTouchButton } from "./ComposerTouchButton";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Composer voice input. Idle: a mic button. Recording: cancel, a live timer,
 * "insert" (transcript lands in the composer for review) and "send"
 * (transcript is sent straight away). Sized for touch — it is used from
 * phones and the car.
 *
 * The touch layout (`touchLayout`) makes the idle mic a big labelled "Speak"
 * button and spreads the recording controls across the whole footer: cancel
 * on the driver's (left) side, a large timer, then labelled insert and send on
 * the far right, so cancel and send are never next to each other.
 */
export const ComposerVoiceInput = memo(function ComposerVoiceInput(props: {
  dictation: VoiceDictation;
  disabled: boolean;
  canSend: boolean;
  touchLayout?: boolean;
}) {
  const { dictation } = props;

  if (props.touchLayout) {
    return <TouchComposerVoiceInput {...props} />;
  }

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

const TouchComposerVoiceInput = memo(function TouchComposerVoiceInput(props: {
  dictation: VoiceDictation;
  disabled: boolean;
  canSend: boolean;
}) {
  const { dictation } = props;

  if (dictation.phase === "transcribing") {
    return (
      <span
        className="flex h-16 min-w-0 flex-1 items-center justify-center gap-3 font-medium text-foreground text-lg"
        role="status"
      >
        <Spinner className="size-6" aria-hidden="true" />
        Transcribing…
      </span>
    );
  }

  if (dictation.phase === "recording") {
    return (
      <div
        className="flex min-w-0 flex-1 items-center gap-3 rounded-full border border-destructive/30 bg-destructive/6 p-1"
        data-voice-dictation="recording"
      >
        <ComposerTouchButton size="icon" onClick={dictation.cancel} aria-label="Cancel voice input">
          <XIcon className="size-7" />
        </ComposerTouchButton>
        <span
          className="flex min-w-0 flex-1 items-center justify-center gap-3 font-semibold text-3xl text-destructive tabular-nums"
          aria-live="off"
        >
          <span className="size-3 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
          {formatVoiceDictationElapsed(dictation.elapsedMs)}
        </span>
        <ComposerTouchButton
          tone="outline"
          onClick={() => dictation.finish("insert")}
          aria-label="Stop and insert transcript"
        >
          <CheckIcon />
          Insert
        </ComposerTouchButton>
        {props.canSend ? (
          <ComposerTouchButton
            tone="primary"
            className="min-w-36"
            onClick={() => dictation.finish("send")}
            aria-label="Stop and send"
          >
            <ArrowUpIcon />
            Send
          </ComposerTouchButton>
        ) : null}
      </div>
    );
  }

  return (
    <ComposerTouchButton
      tone="primary"
      size="large"
      onClick={dictation.start}
      disabled={props.disabled || dictation.phase === "starting"}
      aria-label="Speak (voice input)"
    >
      {dictation.phase === "starting" ? (
        <Spinner className="size-6" aria-hidden="true" />
      ) : (
        <MicIcon aria-hidden="true" className="size-7" />
      )}
      Speak
    </ComposerTouchButton>
  );
});
