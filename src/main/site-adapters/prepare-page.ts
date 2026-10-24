import type { SitePlan } from "./catalog";

/** Only opens read UI. Each invocation is a separate ownership-guarded step.
 * It neither submits forms nor installs network hooks into the page. */
export function prepareSitePage(plan: SitePlan, stage: "expand" | "transcript"): { performed: boolean; reason: string } {
  if (plan.operation !== "youtube.transcript" || location.hostname !== "www.youtube.com" || new URL(location.href).searchParams.get("v") !== plan.params.id) return { performed: false, reason: "not-applicable" };
  if (plan.access?.blockedOrigins?.includes(location.origin) || plan.access?.allowedOrigins?.length && !plan.access.allowedOrigins.includes(location.origin)) return { performed: false, reason: "access-blocked" };
  if (document.querySelector("ytd-transcript-segment-renderer")) return { performed: false, reason: "already-loaded" };
  const loader = document.querySelector<any>('ytd-continuation-item-renderer[panel-target-id="engagement-panel-searchable-transcript"]');
  const command = loader?.data?.continuationEndpoint;
  if (command?.getTranscriptEndpoint && command.commandMetadata?.webCommandMetadata?.apiUrl === "/youtubei/v1/get_transcript" && typeof loader.triggerContinuation === "function") {
    if (stage === "expand") return { performed: false, reason: "page-loader-available" };
    // Reuse the site's own request context and signing. This exact endpoint
    // only reads the selected video's existing transcript.
    loader.triggerContinuation();
    return { performed: true, reason: "page-transcript-request" };
  }
  const visible = (e: Element) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest('[hidden]');
  const selector = stage === "expand" ? "ytd-watch-metadata ytd-text-inline-expander > #expand" : "ytd-watch-metadata ytd-video-description-transcript-section-renderer button";
  const node = [...document.querySelectorAll<HTMLElement>(selector)].find(visible);
  if (!node || node.getAttribute("aria-disabled") === "true") return { performed: false, reason: "control-unavailable" };
  node.click();
  return { performed: true, reason: stage };
}
