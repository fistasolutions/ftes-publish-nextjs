/**
 * @ftes/publish-nextjs — receive and publish FTES.AI articles on your Next.js site.
 *
 * Server-safe entry point: no "use client" anywhere in this module graph, so the article can
 * never accidentally become client-rendered (which would hide it from AI crawlers and defeat
 * the purpose of publishing).
 */

export { createPublishRoute, timingSafeEqual } from "./route.js";
export type {
  ArticleStore,
  PublishRouteConfig,
  UpsertResult,
} from "./route.js";

export { parseArticle, articleWordCount } from "./article.js";
export type { Article, ArticleFaq, ArticleSection, ParseResult } from "./article.js";

export {
  articleJsonLd,
  articleMetadata,
  articleUrl,
  faqJsonLd,
  ftesSitemapEntries,
} from "./seo.js";
export type { JsonLdOptions, SitemapEntry, SiteOptions } from "./seo.js";
