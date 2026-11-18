// Preserve links to the former dynamic endpoint without rendering at the edge.
export function GET(request: Request) {
  return Response.redirect(new URL("/art/og/templ-og.png", request.url), 307);
}
