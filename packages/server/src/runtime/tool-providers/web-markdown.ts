import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

/**
 * Main-content extraction for `fetch_url`.
 *
 * Defuddle (the extractor behind Obsidian Web Clipper) runs locally against a
 * linkedom DOM, so the markdown path costs one HTTP request and no API key --
 * it replaces the Exa Contents call this used to make. Kept out of
 * `network.ts` so the DOM dependencies stay behind one import boundary and can
 * be exercised on their own in tests.
 */

export type ExtractedArticle = {
  markdown: string;
  title: string;
  author: string;
  published: string;
  site: string;
  wordCount: number;
  extractorType?: string;
};

/**
 * Extract the readable body of an HTML page as markdown.
 *
 * Returns `undefined` when there is nothing worth returning -- an empty
 * extraction is a signal to fall back to the raw response, not an error.
 */
export async function extractArticleMarkdown(
  html: string,
  url: string,
  signal?: AbortSignal,
): Promise<ExtractedArticle | undefined> {
  const { document } = parseHTML(html);
  const result = await Defuddle(document, url, {
    markdown: true,
    // Site-specific extractors (YouTube transcripts, Reddit comments) may make
    // their own requests; route them through a fetch that honours our timeout.
    fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? signal }),
  });

  const markdown = typeof result.content === "string" ? result.content.trim() : "";
  if (!markdown) return undefined;

  return {
    markdown,
    title: stringOrEmpty(result.title),
    author: stringOrEmpty(result.author),
    published: stringOrEmpty(result.published),
    site: stringOrEmpty(result.site),
    wordCount: typeof result.wordCount === "number" ? result.wordCount : 0,
    extractorType: result.extractorType,
  };
}

/**
 * Whether a response body should be handed to the extractor.
 *
 * Content-type is the answer when the server gives one; sniffing is the
 * fallback for the servers that send `application/octet-stream` or nothing.
 */
export function looksLikeHtml(contentType: string | null, body: string) {
  if (contentType) {
    const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (mediaType) return mediaType === "text/html" || mediaType === "application/xhtml+xml";
  }
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(body.slice(0, 1000));
}

function stringOrEmpty(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
