/**
 * Top comments for a YouTube video, via the official YouTube Data API v3
 * (`commentThreads.list`, 1 quota unit per call, 10,000 units/day by default).
 *
 * Why the API and not scraping: yt-dlp is answered with "Sign in to confirm
 * you're not a bot" from datacenter IPs (verified on the T3 host 2026-10-19),
 * while the API is keyed and IP-independent.
 *
 * Dependency-free on purpose (global `fetch` only): the `ytcomments` CLI
 * (scripts/ytcomments.ts) and any server-side caller share this one module.
 *
 * @module youtubeComments
 */

export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const PATH_PREFIXES = new Set(["shorts", "embed", "live", "v", "e"]);

export type YoutubeCommentsErrorCode =
  | "INVALID_URL"
  | "MISSING_API_KEY"
  | "API_KEY_REJECTED"
  | "VIDEO_NOT_FOUND"
  | "COMMENTS_DISABLED"
  | "VIDEO_FORBIDDEN"
  | "QUOTA_EXCEEDED"
  | "UPSTREAM_ERROR";

export class YoutubeCommentsError extends Error {
  readonly code: YoutubeCommentsErrorCode;
  constructor(code: YoutubeCommentsErrorCode, message: string) {
    super(message);
    this.name = "YoutubeCommentsError";
    this.code = code;
  }
}

/**
 * Extract the 11-character video id from any common YouTube link (watch,
 * youtu.be, shorts, embed, live, with or without `&t=`, `&list=`, `&si=`) or
 * from a bare id. Throws `INVALID_URL` for channels, playlists and other hosts.
 */
export function parseYoutubeVideoId(input: string): string {
  const text = input.trim();
  if (VIDEO_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new YoutubeCommentsError("INVALID_URL", `Not a YouTube link: ${input}`);
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  let candidate: string | undefined;
  if (host === "youtu.be" || host === "www.youtu.be") {
    candidate = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === "watch") candidate = url.searchParams.get("v") ?? undefined;
    else if (segments[0] !== undefined && PATH_PREFIXES.has(segments[0])) candidate = segments[1];
  }
  if (candidate === undefined || !VIDEO_ID.test(candidate)) {
    throw new YoutubeCommentsError(
      "INVALID_URL",
      `No video id in ${input} (channel, playlist and search links have no comments to read)`,
    );
  }
  return candidate;
}

export interface YoutubeReply {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly likeCount: number;
  readonly publishedAt: string;
}

export interface YoutubeComment extends YoutubeReply {
  readonly replyCount: number;
  /** Replies the API inlines with the thread (at most 5); `replyCount` is the real total. */
  readonly topReplies: ReadonlyArray<YoutubeReply>;
}

export interface YoutubeVideoInfo {
  readonly videoId: string;
  readonly title: string;
  readonly channel: string;
  readonly commentCount: number | null;
}

export interface YoutubeCommentsResult {
  readonly video: YoutubeVideoInfo;
  readonly order: "relevance" | "time";
  readonly comments: ReadonlyArray<YoutubeComment>;
  /** Present when the video has more comments than were requested. */
  readonly nextPageToken?: string;
}

export interface FetchYoutubeCommentsInput {
  readonly url: string;
  readonly apiKey: string | undefined;
  /** 1..500; the API serves 100 per call, so a large limit costs several units. */
  readonly limit?: number;
  /** `relevance` is YouTube's "Top comments"; `time` is newest first. */
  readonly order?: "relevance" | "time";
  readonly includeReplies?: boolean;
  readonly pageToken?: string;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

interface ApiThread {
  readonly id: string;
  readonly snippet?: {
    readonly totalReplyCount?: number;
    readonly topLevelComment?: { readonly id: string; readonly snippet?: ApiCommentSnippet };
  };
  readonly replies?: {
    readonly comments?: ReadonlyArray<{
      readonly id: string;
      readonly snippet?: ApiCommentSnippet;
    }>;
  };
}
interface ApiCommentSnippet {
  readonly authorDisplayName?: string;
  readonly textOriginal?: string;
  readonly textDisplay?: string;
  readonly likeCount?: number;
  readonly publishedAt?: string;
}

function toReply(comment: { id: string; snippet?: ApiCommentSnippet }): YoutubeReply {
  const snippet = comment.snippet ?? {};
  return {
    id: comment.id,
    author: snippet.authorDisplayName ?? "unknown",
    text: snippet.textOriginal ?? snippet.textDisplay ?? "",
    likeCount: snippet.likeCount ?? 0,
    publishedAt: snippet.publishedAt ?? "",
  };
}

function errorFromResponse(status: number, body: unknown): YoutubeCommentsError {
  const error = (body as { error?: { message?: string; errors?: Array<{ reason?: string }> } })
    ?.error;
  const reason = error?.errors?.[0]?.reason ?? "";
  const message = error?.message ?? `HTTP ${status}`;
  if (reason === "commentsDisabled") {
    return new YoutubeCommentsError("COMMENTS_DISABLED", "Comments are turned off for this video.");
  }
  if (reason === "videoNotFound" || status === 404) {
    return new YoutubeCommentsError(
      "VIDEO_NOT_FOUND",
      "Video not found (deleted, private or the id is wrong).",
    );
  }
  if (reason === "quotaExceeded" || reason === "rateLimitExceeded" || status === 429) {
    return new YoutubeCommentsError(
      "QUOTA_EXCEEDED",
      "YouTube API quota exceeded (10,000 units/day by default, resets at midnight Pacific).",
    );
  }
  if (
    reason === "keyInvalid" ||
    reason === "API_KEY_INVALID" ||
    reason === "accessNotConfigured" ||
    reason === "ipRefererBlocked" ||
    (status === 400 && /api key/i.test(message))
  ) {
    return new YoutubeCommentsError(
      "API_KEY_REJECTED",
      `YouTube rejected the API key (${reason || message}). Check YOUTUBE_API_KEY and that "YouTube Data API v3" is enabled for its project.`,
    );
  }
  if (status === 403) {
    return new YoutubeCommentsError(
      "VIDEO_FORBIDDEN",
      `YouTube refused to share this video's comments (${reason || message}).`,
    );
  }
  return new YoutubeCommentsError("UPSTREAM_ERROR", `YouTube API error: ${message}`);
}

async function getJson(
  doFetch: typeof fetch,
  path: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<unknown> {
  const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("key", apiKey);
  let response: Response;
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (cause) {
    // The key rides in the query string, so never echo the URL.
    throw new YoutubeCommentsError(
      "UPSTREAM_ERROR",
      `Could not reach the YouTube API: ${cause instanceof Error ? cause.name : "network error"}`,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body: fall through to the status.
  }
  if (!response.ok) throw errorFromResponse(response.status, body);
  return body;
}

/** Fetch a video's title/channel and its top (or newest) comments. */
export async function fetchYoutubeComments(
  input: FetchYoutubeCommentsInput,
): Promise<YoutubeCommentsResult> {
  const videoId = parseYoutubeVideoId(input.url);
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new YoutubeCommentsError(
      "MISSING_API_KEY",
      "No YouTube API key. Set YOUTUBE_API_KEY (YouTube Data API v3 key from console.cloud.google.com/apis/credentials).",
    );
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 20)));
  const order = input.order ?? "relevance";
  const doFetch = input.fetch ?? fetch;

  const videoBody = (await getJson(
    doFetch,
    "videos",
    { part: "snippet,statistics", id: videoId },
    apiKey,
  )) as {
    items?: Array<{
      snippet?: { title?: string; channelTitle?: string };
      statistics?: { commentCount?: string };
    }>;
  };
  const item = videoBody.items?.[0];
  if (!item) {
    throw new YoutubeCommentsError(
      "VIDEO_NOT_FOUND",
      "Video not found (deleted, private or the id is wrong).",
    );
  }
  const video: YoutubeVideoInfo = {
    videoId,
    title: item.snippet?.title ?? "",
    channel: item.snippet?.channelTitle ?? "",
    commentCount:
      item.statistics?.commentCount !== undefined ? Number(item.statistics.commentCount) : null,
  };

  const comments: YoutubeComment[] = [];
  let pageToken = input.pageToken;
  let nextPageToken: string | undefined;
  while (comments.length < limit) {
    const page = (await getJson(
      doFetch,
      "commentThreads",
      {
        part: input.includeReplies === false ? "snippet" : "snippet,replies",
        videoId,
        order,
        textFormat: "plainText",
        maxResults: String(Math.min(100, limit - comments.length)),
        ...(pageToken ? { pageToken } : {}),
      },
      apiKey,
    )) as { items?: ApiThread[]; nextPageToken?: string };
    for (const thread of page.items ?? []) {
      const top = thread.snippet?.topLevelComment;
      if (!top) continue;
      comments.push({
        ...toReply(top),
        replyCount: thread.snippet?.totalReplyCount ?? 0,
        topReplies: (thread.replies?.comments ?? []).map(toReply),
      });
      if (comments.length >= limit) break;
    }
    nextPageToken = page.nextPageToken;
    if (!nextPageToken || (page.items ?? []).length === 0) break;
    pageToken = nextPageToken;
  }
  return {
    video,
    order,
    comments,
    ...(nextPageToken && comments.length >= limit ? { nextPageToken } : {}),
  };
}

/** Compact terminal rendering: header, then `N. [likes] author · date: text (replies: n)`. */
export function formatYoutubeComments(
  result: YoutubeCommentsResult,
  options: { readonly maxChars?: number; readonly replies?: number } = {},
): string {
  const maxChars = options.maxChars ?? 400;
  const replyLines = options.replies ?? 0;
  const clip = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
  };
  const date = (iso: string) => iso.slice(0, 10);
  const { video } = result;
  const lines = [
    `${video.title} — ${video.channel}`,
    `${video.commentCount ?? "?"} comments · showing ${result.comments.length} ${
      result.order === "relevance" ? "top" : "newest"
    }`,
    "",
  ];
  result.comments.forEach((comment, index) => {
    lines.push(
      `${index + 1}. [${comment.likeCount}♥] ${comment.author} · ${date(comment.publishedAt)}: ${clip(comment.text)}` +
        (comment.replyCount > 0
          ? `  (${comment.replyCount} repl${comment.replyCount === 1 ? "y" : "ies"})`
          : ""),
    );
    for (const reply of comment.topReplies.slice(0, replyLines)) {
      lines.push(`     ↳ [${reply.likeCount}♥] ${reply.author}: ${clip(reply.text)}`);
    }
  });
  return lines.join("\n");
}
