function isHomeDocumentRequest(request: Request): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    new URL(request.url).pathname === "/"
  );
}

function matchesEtag(value: string | null, etag: string | null): boolean {
  if (!value) return false;
  if (value.trim() === "*") return true;
  if (!etag) return false;
  const expected = etag.replace(/^W\//, "");
  return [...value.matchAll(/(?:^|,)\s*((?:W\/)?"[^"]*")\s*(?=,|$)/g)].some(
    (match) => match[1].replace(/^W\//, "") === expected,
  );
}

/** Recheck upstream conditionals against the delivered HTML representation. */
export async function fetchWithLlmsDiscovery(
  request: Request,
  fetchResponse: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const response = await fetchResponse(request);
  if (
    isHomeDocumentRequest(request) &&
    response.status === 304 &&
    (request.headers.has("If-None-Match") ||
      request.headers.has("If-Modified-Since"))
  ) {
    const headers = new Headers(request.headers);
    headers.delete("If-None-Match");
    headers.delete("If-Modified-Since");
    const unconditional = await fetchResponse(new Request(request, { headers }));
    const rewritten = withLlmsDiscovery(request, unconditional);
    if (rewritten !== unconditional) return rewritten;
    void unconditional.body?.cancel().catch(() => undefined);
    return response;
  }
  return withLlmsDiscovery(request, response);
}

/** Put the machine-readable guide at the start of the delivered home page. */
export function withLlmsDiscovery(request: Request, response: Response): Response {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (
    !isHomeDocumentRequest(request) ||
    response.status !== 200 ||
    (request.method === "GET" && !response.body) ||
    response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "text/html" ||
    (encoding && encoding !== "identity")
  )
    return response;

  const guide = new URL("/llms.txt", request.url).toString();
  const discoveryLine = `<!-- For AI assistants: a quick index of Templ and its docs is at ${guide} -->\n`;
  const headers = new Headers(response.headers);
  headers.append("Link", `<${guide}>; rel="alternate"; type="text/plain"`);
  headers.delete("Content-Length");
  headers.delete("Last-Modified");
  const upstreamEtag = headers.get("ETag");
  const tag = upstreamEtag && /^(?:W\/)?"([^"]*)"$/.exec(upstreamEtag);
  if (tag)
    headers.set(
      "ETag",
      `W/"llms-${encodeURIComponent(discoveryLine)}-${tag[1]}"`,
    );
  else headers.delete("ETag");
  if (matchesEtag(request.headers.get("If-None-Match"), headers.get("ETag"))) {
    void response.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 304, statusText: "Not Modified", headers });
  }
  if (request.method === "HEAD") {
    void response.body?.cancel().catch(() => undefined);
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const firstLine = new TextEncoder().encode(discoveryLine);
  const reader = response.body!.getReader();
  let sentFirstLine = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirstLine) {
        sentFirstLine = true;
        controller.enqueue(firstLine);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
