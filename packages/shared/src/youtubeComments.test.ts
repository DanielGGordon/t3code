import { describe, expect, it } from "vite-plus/test";

import {
  fetchYoutubeComments,
  formatYoutubeComments,
  parseYoutubeVideoId,
  YoutubeCommentsError,
} from "./youtubeComments.ts";

const ID = "kGBLMex8zFM";

describe("parseYoutubeVideoId", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/watch?v=${ID}&t=42s&list=PLabc&si=zzz`],
    [`https://youtu.be/${ID}?si=abc&t=3`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}?rel=0`],
    [`https://www.youtube.com/live/${ID}`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}&list=RDAMVM`],
    [`youtube.com/watch?v=${ID}`],
    [`  ${ID}  `],
  ])("reads the id from %s", (input) => {
    expect(parseYoutubeVideoId(input)).toBe(ID);
  });

  it.each([
    ["https://www.youtube.com/@somechannel"],
    ["https://www.youtube.com/playlist?list=PLabc"],
    ["https://www.youtube.com/watch"],
    ["https://example.com/watch?v=" + ID],
    ["https://www.youtube.com/watch?v=short"],
    ["not a link at all"],
    [""],
  ])("rejects %s", (input) => {
    expect(() => parseYoutubeVideoId(input)).toThrowError(YoutubeCommentsError);
    try {
      parseYoutubeVideoId(input);
    } catch (error) {
      expect((error as YoutubeCommentsError).code).toBe("INVALID_URL");
    }
  });
});

function thread(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `t${n}`,
    snippet: {
      totalReplyCount: n % 2,
      topLevelComment: {
        id: `c${n}`,
        snippet: {
          authorDisplayName: `@user${n}`,
          textOriginal: `comment ${n}`,
          likeCount: 100 - n,
          publishedAt: "2026-10-18T12:00:00Z",
        },
      },
    },
    ...extra,
  };
}

interface FakeFetch {
  (input: URL | string): Promise<Response>;
  calls: URL[];
}

function fakeFetch(
  handler: (url: URL) => { status?: number; body: unknown },
): FakeFetch & typeof fetch {
  const calls: URL[] = [];
  const fn = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url);
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), { status });
  }) as FakeFetch;
  fn.calls = calls;
  return fn as FakeFetch & typeof fetch;
}

const videoBody = {
  items: [
    {
      snippet: { title: "A video", channelTitle: "A channel" },
      statistics: { commentCount: "76" },
    },
  ],
};

describe("fetchYoutubeComments", () => {
  it("returns video info and top comments, asking for relevance order", async () => {
    const f = fakeFetch((url) =>
      url.pathname.endsWith("/videos")
        ? { body: videoBody }
        : { body: { items: [thread(1), thread(2)] } },
    );
    const result = await fetchYoutubeComments({
      url: `https://youtu.be/${ID}`,
      apiKey: "k",
      limit: 5,
      fetch: f,
    });
    expect(result.video).toEqual({
      videoId: ID,
      title: "A video",
      channel: "A channel",
      commentCount: 76,
    });
    expect(result.comments.map((c) => [c.author, c.text, c.likeCount, c.replyCount])).toEqual([
      ["@user1", "comment 1", 99, 1],
      ["@user2", "comment 2", 98, 0],
    ]);
    const threadsCall = f.calls.find((u) => u.pathname.endsWith("/commentThreads"))!;
    expect(threadsCall.searchParams.get("order")).toBe("relevance");
    expect(threadsCall.searchParams.get("videoId")).toBe(ID);
    expect(threadsCall.searchParams.get("part")).toBe("snippet,replies");
    expect(result.nextPageToken).toBeUndefined();
  });

  it("pages until the limit and trims to it, exposing the next page token", async () => {
    const f = fakeFetch((url) => {
      if (url.pathname.endsWith("/videos")) return { body: videoBody };
      const first = !url.searchParams.has("pageToken");
      return {
        body: {
          items: first ? [thread(1), thread(2), thread(3)] : [thread(4), thread(5), thread(6)],
          nextPageToken: first ? "P2" : "P3",
        },
      };
    });
    const result = await fetchYoutubeComments({ url: ID, apiKey: "k", limit: 5, fetch: f });
    expect(result.comments.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(result.nextPageToken).toBe("P3");
    const sizes = f.calls
      .filter((u) => u.pathname.endsWith("/commentThreads"))
      .map((u) => u.searchParams.get("maxResults"));
    expect(sizes).toEqual(["5", "2"]);
  });

  it("includes the inline replies and can skip them", async () => {
    const f = fakeFetch((url) =>
      url.pathname.endsWith("/videos")
        ? { body: videoBody }
        : {
            body: {
              items: [
                thread(1, {
                  replies: {
                    comments: [
                      {
                        id: "r1",
                        snippet: { authorDisplayName: "@r", textDisplay: "a reply", likeCount: 3 },
                      },
                    ],
                  },
                }),
              ],
            },
          },
    );
    const withReplies = await fetchYoutubeComments({ url: ID, apiKey: "k", limit: 1, fetch: f });
    expect(withReplies.comments[0]!.topReplies.map((r) => [r.author, r.text, r.likeCount])).toEqual(
      [["@r", "a reply", 3]],
    );
    await fetchYoutubeComments({ url: ID, apiKey: "k", limit: 1, includeReplies: false, fetch: f });
    const last = f.calls.findLast((u) => u.pathname.endsWith("/commentThreads"))!;
    expect(last.searchParams.get("part")).toBe("snippet");
  });

  it("fails fast without a key, before any request", async () => {
    const f = fakeFetch(() => ({ body: {} }));
    await expect(fetchYoutubeComments({ url: ID, apiKey: "  ", fetch: f })).rejects.toMatchObject({
      code: "MISSING_API_KEY",
    });
    expect(f.calls).toEqual([]);
  });

  it("maps API failures to stable codes", async () => {
    const cases: Array<[number, unknown, string]> = [
      [
        403,
        { error: { message: "disabled", errors: [{ reason: "commentsDisabled" }] } },
        "COMMENTS_DISABLED",
      ],
      [404, { error: { message: "nf", errors: [{ reason: "videoNotFound" }] } }, "VIDEO_NOT_FOUND"],
      [403, { error: { message: "q", errors: [{ reason: "quotaExceeded" }] } }, "QUOTA_EXCEEDED"],
      [
        400,
        { error: { message: "API key not valid.", errors: [{ reason: "badRequest" }] } },
        "API_KEY_REJECTED",
      ],
      [
        403,
        { error: { message: "off", errors: [{ reason: "accessNotConfigured" }] } },
        "API_KEY_REJECTED",
      ],
      [403, { error: { message: "nope", errors: [{ reason: "forbidden" }] } }, "VIDEO_FORBIDDEN"],
      [500, { error: { message: "boom" } }, "UPSTREAM_ERROR"],
    ];
    for (const [status, body, code] of cases) {
      const f = fakeFetch((url) =>
        url.pathname.endsWith("/videos") ? { body: videoBody } : { status, body },
      );
      await expect(fetchYoutubeComments({ url: ID, apiKey: "k", fetch: f })).rejects.toMatchObject({
        code,
      });
    }
  });

  it("reports a missing video when the lookup returns no items", async () => {
    const f = fakeFetch(() => ({ body: { items: [] } }));
    await expect(fetchYoutubeComments({ url: ID, apiKey: "k", fetch: f })).rejects.toMatchObject({
      code: "VIDEO_NOT_FOUND",
    });
  });

  it("never puts the API key in an error message", async () => {
    const throwing = (async () => {
      throw new Error("connect ECONNREFUSED https://x?key=SECRETKEY");
    }) as unknown as typeof fetch;
    const error = await fetchYoutubeComments({
      url: ID,
      apiKey: "SECRETKEY",
      fetch: throwing,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YoutubeCommentsError);
    expect((error as Error).message).not.toContain("SECRETKEY");
  });
});

describe("formatYoutubeComments", () => {
  it("prints a header and one numbered line per comment, clipping long text", () => {
    const text = formatYoutubeComments(
      {
        video: { videoId: ID, title: "T", channel: "C", commentCount: 3 },
        order: "relevance",
        comments: [
          {
            id: "c1",
            author: "@a",
            text: "x".repeat(50),
            likeCount: 7,
            publishedAt: "2026-10-18T12:00:00Z",
            replyCount: 1,
            topReplies: [
              { id: "r", author: "@b", text: "hi\nthere", likeCount: 1, publishedAt: "" },
            ],
          },
        ],
      },
      { maxChars: 20, replies: 1 },
    );
    expect(text.split("\n")).toEqual([
      "T — C",
      "3 comments · showing 1 top",
      "",
      "1. [7♥] @a · 2026-10-18: xxxxxxxxxxxxxxxxxxx…  (1 reply)",
      "     ↳ [1♥] @b: hi there",
    ]);
  });
});
