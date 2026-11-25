import { Fragment } from "react";

/**
 * Safe React-element Markdown renderer for specs, plans, rationales, and summaries.
 * Supports headings (#, ##, ###), bullet lists (- / *), fenced code blocks (```),
 * inline `code`, and **bold** spans without interpreting raw HTML.
 */
export function SafeMarkdown({ markdown }: { markdown: string }) {
  const chunks = markdown.split(/(```[\s\S]*?```)/g);
  return (
    <div className="flex flex-col gap-1.5 text-[13px] leading-6 text-ink">
      {chunks.map((chunk, ci) => {
        if (chunk.startsWith("```") && chunk.endsWith("```")) {
          const inner = chunk.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "");
          return (
            <pre
              key={ci}
              className="my-1 overflow-x-auto rounded-lg border border-[var(--border-hairline)] bg-cream-2 px-3 py-2 text-[12px] leading-5 text-ink"
            >
              {inner}
            </pre>
          );
        }
        const lines = chunk.split("\n");
        return (
          <Fragment key={ci}>
            {lines.map((line, li) => {
              const trimmed = line.trim();
              if (!trimmed) return null;
              if (trimmed.startsWith("### ")) {
                return (
                  <h4 key={li} className="m-0 mt-1 text-[13px] font-semibold text-ink">
                    <InlineMarkdown text={trimmed.slice(4)} />
                  </h4>
                );
              }
              if (trimmed.startsWith("## ")) {
                return (
                  <h3 key={li} className="m-0 mt-1.5 text-[15px] font-semibold text-ink">
                    <InlineMarkdown text={trimmed.slice(3)} />
                  </h3>
                );
              }
              if (trimmed.startsWith("# ")) {
                return (
                  <h2 key={li} className="m-0 mt-1.5 text-[15px] font-semibold text-ink">
                    <InlineMarkdown text={trimmed.slice(2)} />
                  </h2>
                );
              }
              if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                return (
                  <div key={li} className="flex items-baseline gap-2 pl-2">
                    <span className="text-muted">•</span>
                    <span className="min-w-0 flex-1">
                      <InlineMarkdown text={trimmed.slice(2)} />
                    </span>
                  </div>
                );
              }
              return (
                <p key={li} className="m-0">
                  <InlineMarkdown text={line} />
                </p>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code
              key={i}
              className="rounded-lg border border-[var(--border-hairline)] bg-cream-2 px-1 py-0.5 text-[12px] text-ink"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <strong key={i} className="font-semibold text-ink">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
