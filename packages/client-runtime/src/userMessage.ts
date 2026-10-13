import { type OrchestrationV2Actor, ScheduledTaskId } from "@t3tools/contracts";
import { isCacheKeepAliveMessageId } from "@t3tools/shared/cacheKeepAlive";

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

/** Older scheduled messages stored their attribution in the prompt itself. */
export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly scheduledTaskId?: ScheduledTaskId;
}) {
  if (message.role !== "user") {
    return {
      text: message.text,
      isAutomation: false,
      isCacheKeepAlive: false,
      scheduledTaskId: undefined,
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      isAutomation: true,
      isCacheKeepAlive: false,
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  // Fork: the server's prompt-cache keep-alive ping (system-sent, fixed id prefix).
  if (message.createdBy === "system" && isCacheKeepAliveMessageId(message.id)) {
    return {
      text: message.text,
      isAutomation: false,
      isCacheKeepAlive: true,
      scheduledTaskId: undefined,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  const isAutomation =
    legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent");
  return {
    text: isAutomation ? message.text.slice(legacyPrefix[0].length) : message.text,
    isAutomation,
    isCacheKeepAlive: false,
    scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
  };
}
