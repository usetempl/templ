"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatSearchPage } from "@templ/chat/search";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "@/lib/community-client";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import { IconSearch, IconX } from "@tabler/icons-react";
import styles from "./support-inbox-search.module.css";

const SCAN_REQUESTS = 12;
const SCAN_MS = 2 * 60_000;
type SearchState = {
  query: string;
  hits: ChatSearchPage["hits"];
  indexing: boolean;
  cursor?: string | null;
  pending: boolean;
  scanning?: boolean;
  stopped?: boolean;
  waitSeconds?: number;
  error?: string;
};
type SearchProps = { room: ChatRoomId; onOpen: (id: string) => void };

function waitForSearch(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function readSearchPage(
  path: string,
  signal: AbortSignal,
  timeoutMs: number,
) {
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      communityFetch<ChatSearchPage>(path, undefined, request.signal),
      new Promise<never>((_, reject) => {
        cancel = () => {
          request.abort();
          reject(signal.reason);
        };
        signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => {
          request.abort();
          reject(new Error("Search took too long. Try continuing again."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}

export function SupportInboxSearch(props: SearchProps) {
  const sessionRevision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  return (
    <SearchForm
      key={`${props.room}:${sessionRevision}`}
      {...props}
      sessionRevision={sessionRevision}
    />
  );
}

function SearchForm({
  room,
  onOpen,
  sessionRevision,
}: SearchProps & { sessionRevision: number }) {
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<SearchState>();
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);

  const search = (query: string, previous?: SearchState) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const current = () =>
      !controller.signal.aborted &&
      sessionRevision === communitySessionRevision();
    let next: SearchState = {
      ...(previous ?? { query, hits: [], indexing: false }),
      pending: true,
      stopped: false,
      waitSeconds: undefined,
      error: undefined,
    };
    setResult(next);
    const deadline = Date.now() + SCAN_MS;
    const cursors = new Set(next.cursor ? [next.cursor] : []);
    void (async () => {
      try {
        for (let count = 0; count < SCAN_REQUESTS; count++) {
          if (!current()) return;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const params = new URLSearchParams({ scope: "support", q: query });
          if (next.cursor) params.set("cursor", next.cursor);
          let page: ChatSearchPage;
          try {
            page = await readSearchPage(
              roomPath(room, `search?${params}`),
              controller.signal,
              Math.min(20_000, remaining),
            );
          } catch (reason) {
            if (!current()) return;
            const seconds =
              reason instanceof CommunityApiError
                ? reason.retryAfterSeconds
                : null;
            if (
              reason instanceof CommunityApiError &&
              reason.status === 429 &&
              seconds !== null &&
              Number.isSafeInteger(seconds) &&
              seconds > 0 &&
              Date.now() + seconds * 1000 < deadline &&
              count + 1 < SCAN_REQUESTS
            ) {
              next = { ...next, waitSeconds: seconds };
              setResult(next);
              await waitForSearch(seconds * 1000, controller.signal);
              if (!current()) return;
              next = { ...next, waitSeconds: undefined };
              setResult(next);
              continue;
            }
            throw reason;
          }
          if (!current()) return;
          if (page.nextCursor && cursors.has(page.nextCursor))
            throw new Error("Search could not continue. Search again.");
          if (page.nextCursor) cursors.add(page.nextCursor);
          const hits = new Map(
            next.hits.map((hit) => [`${hit.channelId}:${hit.message.id}`, hit]),
          );
          for (const hit of page.hits)
            hits.set(`${hit.channelId}:${hit.message.id}`, hit);
          next = {
            ...next,
            hits: [...hits.values()],
            indexing: next.indexing || page.indexing,
            cursor: page.nextCursor ?? null,
            scanning: page.hits.length === 0 && Boolean(page.nextCursor),
          };
          setResult(next);
          // An empty continuation page is still scanning for the next globally
          // ordered result page. Stop after results arrive or the scan ends.
          if (page.hits.length || !page.nextCursor) break;
        }
        if (current()) setResult({ ...next, pending: false });
      } catch (reason) {
        if (!current()) return;
        const accessEnded =
          reason instanceof CommunityApiError &&
          [401, 403, 404].includes(reason.status);
        setResult({
          ...next,
          ...(accessEnded ? { hits: [], cursor: null, indexing: false } : {}),
          pending: false,
          waitSeconds: undefined,
          error:
            reason instanceof Error ? reason.message : "Search could not load.",
        });
      } finally {
        if (active.current === controller) active.current = undefined;
      }
    })();
  };

  return (
    <div className={styles.search}>
      <form
        className={styles.form}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          search(draft.trim());
        }}
      >
        <label className={styles.field}>
          <IconSearch size={16} aria-hidden="true" />
          <span className={styles.srOnly}>Search support messages</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={200}
            placeholder="Search messages"
          />
        </label>
        <button
          type="submit"
          className={styles.submit}
          disabled={draft.trim().length < 2}
        >
          Search
        </button>
        {result && (
          <button
            type="button"
            className={styles.clear}
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              active.current?.abort();
              setDraft("");
              setResult(undefined);
            }}
          >
            <IconX size={15} aria-hidden="true" />
          </button>
        )}
      </form>
      {result?.pending && (
        <>
          <p role="status">
            {result.waitSeconds
              ? `Search paused for ${result.waitSeconds} seconds, then it will continue.`
              : result.scanning
                ? "Searching more support history…"
                : "Searching support messages…"}
          </p>
          <button
            type="button"
            onClick={() => {
              active.current?.abort();
              setResult((previous) =>
                previous
                  ? {
                      ...previous,
                      pending: false,
                      stopped: true,
                      waitSeconds: undefined,
                    }
                  : previous,
              );
            }}
          >
            Cancel search
          </button>
        </>
      )}
      {result?.error && <p role="alert">{result.error}</p>}
      {result?.stopped && (
        <p>Search stopped. You can continue where you left off.</p>
      )}
      {result?.indexing && (
        <p>Older history is still being indexed. Search again to include it.</p>
      )}
      {result && result.hits.length > 0 && (
        <div className={styles.hits}>
          {result.hits.map((hit) => (
            <button
              type="button"
              key={`${hit.channelId}:${hit.message.id}`}
              className={styles.hit}
              onClick={() => onOpen(hit.channelId)}
            >
              {hit.snippet}
            </button>
          ))}
        </div>
      )}
      {result && !result.pending && result.cursor !== null && (
        <>
          {result.scanning && !result.error && !result.stopped && (
            <p>
              More support history remains. Continue searching to see the
              results.
            </p>
          )}
          <button type="button" onClick={() => search(result.query, result)}>
            {result.error
              ? "Retry search"
              : result.scanning || result.stopped
                ? "Continue search"
                : "More results"}
          </button>
        </>
      )}
      {result &&
        !result.pending &&
        !result.error &&
        result.cursor === null &&
        !result.hits.length && <p>No matching support messages.</p>}
    </div>
  );
}
