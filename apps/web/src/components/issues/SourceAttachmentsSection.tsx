// NOT-364: the Issue Detail "Source attachments" summary — durable Linear
// file snapshots (safe name, size, checksum) and external links (labeled
// metadata only) with the correct distinction. Read-only: the ticket in
// Linear stays the only authoring surface.
import type { SourceAttachmentRecord } from "@agent-dealer/shared";

export function formatSourceAttachmentSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return "unknown size";
  return `${sizeBytes.toLocaleString("en-US")} bytes`;
}

export default function SourceAttachmentsSection({
  attachments,
}: {
  attachments?: SourceAttachmentRecord[];
}) {
  if (!attachments?.length) return null;
  const files = attachments.filter((a) => a.kind === "file");
  const links = attachments.filter((a) => a.kind === "link");
  return (
    <div
      className="mb-4 p-3 rounded border border-white/10 bg-white/[0.03] space-y-1"
      data-testid="source-attachments"
    >
      <p className="text-xs text-white/45 font-medium uppercase tracking-wide">Source attachments</p>
      {files.map((f) => (
        <p key={f.linearAttachmentId} className="text-sm text-white/85" data-testid="source-attachment-file">
          <span className="text-cyber-teal">file</span> {f.safeFileName ?? f.title}
          <span className="text-white/45">
            {" "}
            · {formatSourceAttachmentSize(f.sizeBytes)}
            {f.sha256 ? ` · sha256:${f.sha256.slice(0, 16)}…` : ""}
            {f.contentType ? ` · ${f.contentType}` : ""}
          </span>
        </p>
      ))}
      {links.map((l) => (
        <p key={l.linearAttachmentId} className="text-sm text-white/85" data-testid="source-attachment-link">
          <span className="text-amber-300">link</span> {l.title}
          <span className="text-white/45">
            {" "}
            · {l.url}
            {l.subtitle ? ` · ${l.subtitle}` : ""}
          </span>
        </p>
      ))}
      <p className="text-xs text-white/40">
        Files are Dealer-stored snapshots — the Builder reads local bytes, never the expiring Linear
        URL. Links are metadata only, never downloaded. Files uploaded only inside Linear comments
        are not imported.
      </p>
    </div>
  );
}
