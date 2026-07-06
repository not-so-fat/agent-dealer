import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  source: string;
  className?: string;
};

/** Rendered markdown for plan / artifact reading surfaces. */
export default function MarkdownBody({ source, className = "" }: Props) {
  if (!source.trim()) {
    return <p className="text-sm text-white/40 italic">Empty</p>;
  }

  return (
    <div className={`markdown-body ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
