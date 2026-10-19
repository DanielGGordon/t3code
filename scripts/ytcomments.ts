// Top comments of a YouTube video from the command line.
//
//   node scripts/ytcomments.ts <url|id> [-n 20] [--newest] [--replies 2] [--json]
//
// Uses the YouTube Data API v3 (shared module packages/shared/src/youtubeComments.ts).
// Key: YOUTUBE_API_KEY from the environment, else the value ~/.profile assigns
// (read in a throwaway subshell, the way model-run.sh reads XAI_API_KEY), so it
// works even when the line has no `export`. The key is never printed.
// Exit: 0 ok · 1 API/network error · 2 usage / bad link · 3 no API key.

import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  fetchYoutubeComments,
  formatYoutubeComments,
  YoutubeCommentsError,
} from "@t3tools/shared/youtubeComments";

const USAGE = `usage: ytcomments <youtube-url|video-id> [-n 20] [--newest] [--replies N] [--json]
  -n, --limit N     comments to fetch (default 20, max 500; each 100 costs 1 API unit)
  --newest          newest first instead of YouTube's "top comments"
  --replies N       also show up to N replies under each comment (max 5)
  --json            machine-readable output`;

/** YOUTUBE_API_KEY from the env, else what ~/.profile assigns (never printed). */
export function resolveYoutubeApiKey(
  env: NodeJS.ProcessEnv = process.env,
  profile: string = NodePath.join(NodeOS.homedir(), ".profile"),
): string | undefined {
  const fromEnv = env.YOUTUBE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const result = NodeChildProcess.spawnSync(
    "bash",
    ["-c", '. "$1" >/dev/null 2>&1 </dev/null; printf %s "${YOUTUBE_API_KEY:-}"', "_", profile],
    { encoding: "utf8", timeout: 10_000 },
  );
  const key = result.status === 0 ? result.stdout.trim() : "";
  return key || undefined;
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const { values, positionals } = (() => {
    try {
      return NodeUtil.parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: {
          limit: { type: "string", short: "n" },
          newest: { type: "boolean" },
          replies: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (error) {
      console.error(`ytcomments: ${error instanceof Error ? error.message : error}\n${USAGE}`);
      return { values: null, positionals: [] as string[] };
    }
  })();
  if (values === null) return 2;
  if (values.help || positionals.length !== 1) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  const limit = values.limit === undefined ? 20 : Number(values.limit);
  const replies = values.replies === undefined ? 0 : Number(values.replies);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(replies) || replies < 0) {
    console.error(`ytcomments: -n and --replies must be whole numbers\n${USAGE}`);
    return 2;
  }
  try {
    const result = await fetchYoutubeComments({
      url: positionals[0]!,
      apiKey: resolveYoutubeApiKey(),
      limit,
      order: values.newest ? "time" : "relevance",
      includeReplies: replies > 0,
    });
    console.log(
      values.json
        ? JSON.stringify(result, null, 2)
        : formatYoutubeComments(result, { replies: Math.min(5, replies) }),
    );
    return 0;
  } catch (error) {
    if (!(error instanceof YoutubeCommentsError)) throw error;
    console.error(`ytcomments: ${error.message}`);
    if (error.code === "INVALID_URL") return 2;
    if (error.code === "MISSING_API_KEY") return 3;
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
