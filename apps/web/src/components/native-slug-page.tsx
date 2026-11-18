"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { copy as t } from "@/lib/copy";
import { ChatSkeleton } from "./loading-state";
import { SupportWorkspacePage } from "./workspace/support-workspace";
import { resolveNativeSlug } from "@/lib/native-room";

export function NativeSlugPage({ slug }: { slug: string }) {
  // The result names the slug it answers, so a slug change shows the
  // skeleton again without a synchronous reset inside the effect.
  const [result, setResult] = useState<{
    slug: string;
    id?: string;
    error?: boolean;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void resolveNativeSlug(slug, controller.signal)
      .then((id) => setResult({ slug, id }))
      .catch(() => {
        if (!controller.signal.aborted) setResult({ slug, error: true });
      });
    return () => controller.abort();
  }, [slug]);
  const current = result?.slug === slug ? result : undefined;
  if (current?.id)
    return <SupportWorkspacePage key={current.id} id={current.id} />;
  if (current?.error)
    return (
      <main
        style={{
          display: "grid",
          minHeight: "100%",
          placeItems: "center",
          padding: 24,
          textAlign: "center",
        }}
      >
        <div>
          <h1>{t("shell.slug.unavailableTitle")}</h1>
          <p>{t("shell.slug.unavailableBody")}</p>
          <Link href="/inbox">{t("shell.slug.inbox")}</Link>
        </div>
      </main>
    );
  return <ChatSkeleton header />;
}
