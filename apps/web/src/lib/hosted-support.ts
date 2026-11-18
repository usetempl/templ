import "server-only";
import { supportPageWorkspace } from "./support-page-config";
import { SITE } from "./site-environment";
export type HostedSupport = {
  workspace: string;
  name: string;
  href: string;
  frameRequired: boolean;
  verifiedSites: string[];
};
/** Public page metadata, null for a page that is off or missing, or
 * "unavailable" while the service is busy or unreachable. The widget service
 * authorizes every session separately. */
export async function readHostedSupport(
  path: string,
): Promise<HostedSupport | null | "unavailable"> {
  try {
    const response = await fetch(`${SITE.community}${path}`, {
      headers: { Origin: SITE.origin },
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) throw new Error("Support page unavailable");
    const body = (await response.json()) as Partial<HostedSupport>;
    if (!supportPageWorkspace(body.workspace) || typeof body.name !== "string")
      return null;
    return {
      workspace: body.workspace!,
      name: body.name,
      href: `${SITE.origin}/help/${body.workspace}`,
      frameRequired: body.frameRequired === true,
      verifiedSites: Array.isArray(body.verifiedSites)
        ? body.verifiedSites.filter((site) => {
            try {
              const url = new URL(site);
              return (
                url.protocol === "https:" &&
                !url.username &&
                !url.password &&
                url.origin === site
              );
            } catch {
              return false;
            }
          })
        : [],
    };
  } catch {
    console.warn(
      JSON.stringify({
        event: "TEMPL_SUPPORT_FAILURE",
        route: "hosted-support-page",
        reason: "descriptor-load",
      }),
    );
    return "unavailable";
  }
}
