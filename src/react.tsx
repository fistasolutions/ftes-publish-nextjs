/**
 * Unstyled article renderer (SPEC-001).
 *
 * A SERVER component by design — no "use client", no state, no effects. That is the whole
 * point: the article text is in the HTML the server returns, so a JS-less AI crawler reads it.
 *
 * Deliberately unstyled: it emits correct semantics (exactly one <h1>, ordered sections, a
 * real <dl> FAQ) and leaves every visual decision to the site. Wrap it, don't fight it.
 */

import type { Article } from "./article.js";

export interface FtesArticleProps {
  article: Article;
  /** Render the pre-built `html` from FTES instead of composing from `sections`. */
  useHtml?: boolean;
  className?: string;
  /** Heading level for section titles. Default "h2" — never h1, there is only one h1. */
  sectionAs?: "h2" | "h3";
}

export function FtesArticle({
  article,
  useHtml = false,
  className,
  sectionAs = "h2",
}: FtesArticleProps) {
  const SectionHeading = sectionAs;

  return (
    <article className={className}>
      {/* Exactly one h1 per page — the article title. */}
      <h1>{article.title}</h1>

      {useHtml && article.html ? (
        <div dangerouslySetInnerHTML={{ __html: article.html }} />
      ) : (
        <>
          {article.tldr.length > 0 && (
            <ul>
              {article.tldr.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          )}

          {article.sections.map((section, i) => (
            <section key={`${section.heading}-${i}`}>
              {section.heading && <SectionHeading>{section.heading}</SectionHeading>}
              {section.content
                .split("\n\n")
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p, j) => (
                  <p key={j}>{p}</p>
                ))}
            </section>
          ))}

          {article.faq.length > 0 && (
            <section>
              <SectionHeading>FAQ</SectionHeading>
              <dl>
                {article.faq.map((f, i) => (
                  <div key={i}>
                    <dt>{f.question}</dt>
                    <dd>{f.answer}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      )}
    </article>
  );
}
