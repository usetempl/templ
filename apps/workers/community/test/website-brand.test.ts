import { expect, it, vi } from "vitest";
import { fetchWebsiteAsset, publicIcon, websiteUrl } from "../src/website-brand";

it("accepts website addresses from the browser and normalizes public HTTP inputs", () => {
  for (const input of [" usetempl.com ", "http://usetempl.com", "https://www.usetempl.com/"]) {
    expect(websiteUrl(input)).toBe("https://usetempl.com/");
  }
  expect(websiteUrl("http://garden.tools/guide?lang=en#setup")).toBe("https://garden.tools/guide");
  for (const input of ["https://usetempl.com/inbox", "https://community.usetempl.com/", "http://localhost/", "ftp://garden.tools/", "https://staff@usetempl.com/"]) {
    expect(() => websiteUrl(input)).toThrow();
  }
  expect(publicIcon("/favicon.svg?v=1", "https://usetempl.com/")).toBe("https://usetempl.com/favicon.svg");
});

it("reads fixed public Templ resources without forwarding cookies or following redirects", async () => {
  const remote = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://usetempl.com/inbox" } }));
  const response = await fetchWebsiteAsset("https://usetempl.com/", { maxBytes: 1024, timeoutMs: 1000, headers: { cookie: "example", authorization: "example", accept: "text/html" } }, { fetch: remote });
  expect(response.status).toBe(302);
  expect(remote).toHaveBeenCalledOnce();
  expect(remote).toHaveBeenCalledWith("https://usetempl.com/", expect.objectContaining({ method: "GET", redirect: "manual", headers: {accept:"text/html"} }));
});
