// NOT-364: Linear source-attachment staging, safe names, materialization, prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LINEAR_INPUT_EXCLUDE_LINE,
  MAX_SOURCE_ATTACHMENT_FILE_BYTES,
  MAX_SOURCE_ATTACHMENT_TOTAL_BYTES,
  materializeSourceAttachments,
  safeAttachmentFileName,
  sourceAttachmentsDeveloperSection,
  sourceAttachmentsReviewerSection,
  stageSourceAttachments,
  storeStagedAttachments,
  discardStaged,
  SourceAttachmentError,
  type SourceDownloadResponse,
} from "./source-attachments.js";

const HOSTED = "https://uploads.linear.app/abc/repro.tar.gz";
const LINK = "https://docs.example.com/spec";

function downloadDouble(
  bytes: Buffer,
  opts: { contentType?: string; streamed?: boolean; seen?: string[] } = {}
): (url: string) => Promise<SourceDownloadResponse> {
  return async (url: string): Promise<SourceDownloadResponse> => {
    opts.seen?.push(url);
    const headers = {
      get: (name: string): string | null => {
        if (name === "content-type") return opts.contentType ?? "application/gzip";
        if (name === "content-length") return String(bytes.byteLength);
        return null;
      },
    };
    if (opts.streamed === false) {
      const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return { ok: true, status: 200, headers, arrayBuffer: async () => exact as ArrayBuffer };
    }
    const chunks = [bytes.subarray(0, 5), bytes.subarray(5)];
    let i = 0;
    return {
      ok: true,
      status: 200,
      headers,
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= chunks.length) return { done: true as const, value: undefined };
            const value = chunks[i++]!;
            return { done: false as const, value };
          },
          cancel: async () => {},
        }),
      },
    } as unknown as SourceDownloadResponse;
  };
}

const FILE_ATTACHMENT = { id: "att-file-1", title: "repro.tar.gz", url: HOSTED };
const LINK_ATTACHMENT = {
  id: "att-link-1",
  title: "Design doc",
  url: LINK,
  subtitle: "Spec",
  source: "google-docs",
};

test("staging snapshots exact bytes with sha256 and passes links through unfetched", async () => {
  const bytes = Buffer.from("fake-tar-bytes-0123456789");
  const seen: string[] = [];
  const staged = await stageSourceAttachments([FILE_ATTACHMENT, LINK_ATTACHMENT], {
    fetchImpl: downloadDouble(bytes, { seen }),
  });
  try {
    assert.equal(staged.files.length, 1);
    const [file] = staged.files;
    assert.equal(file!.safeFileName, "repro.tar.gz");
    assert.equal(file!.sizeBytes, bytes.byteLength);
    assert.equal(file!.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(file!.contentType, "application/gzip");
    assert.deepEqual(fs.readFileSync(file!.tempPath), bytes);
    // The external link is metadata only — its URL is never fetched.
    assert.equal(staged.links.length, 1);
    assert.equal(staged.links[0]!.kind, "link");
    assert.equal(staged.links[0]!.url, LINK);
    assert.deepEqual(seen, [HOSTED]);
  } finally {
    discardStaged(staged);
  }
});

test("staging refuses an HTTP failure without a partial bundle", async () => {
  const fetchImpl = async (): Promise<SourceDownloadResponse> => ({
    ok: false,
    status: 500,
    headers: { get: () => null },
  });
  await assert.rejects(
    () => stageSourceAttachments([FILE_ATTACHMENT], { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof SourceAttachmentError);
      assert.equal(err.httpStatus, 502);
      assert.match(err.message, /HTTP 500/);
      return true;
    }
  );
});

test("staging times out a hanging download", async () => {
  const fetchImpl = (_url: string, init?: { signal?: AbortSignal }): Promise<SourceDownloadResponse> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  await assert.rejects(
    () => stageSourceAttachments([FILE_ATTACHMENT], { fetchImpl, timeoutMs: 20 }),
    (err: unknown) => {
      assert.ok(err instanceof SourceAttachmentError);
      assert.equal(err.httpStatus, 502);
      assert.match(err.message, /timed out/);
      return true;
    }
  );
});

test("staging enforces the per-file and total snapshot limits", async () => {
  const bytes = Buffer.from("0123456789abcdef");
  await assert.rejects(
    () =>
      stageSourceAttachments([FILE_ATTACHMENT], {
        fetchImpl: downloadDouble(bytes),
        maxFileBytes: 4,
      }),
    (err: unknown) => {
      assert.ok(err instanceof SourceAttachmentError);
      assert.equal(err.httpStatus, 400);
      assert.match(err.message, /too large to snapshot/);
      return true;
    }
  );
  const second = { id: "att-file-2", title: "b.bin", url: `${HOSTED}-b` };
  await assert.rejects(
    () =>
      stageSourceAttachments([FILE_ATTACHMENT, second], {
        fetchImpl: downloadDouble(bytes),
        maxTotalBytes: bytes.byteLength + 1,
      }),
    (err: unknown) => {
      assert.ok(err instanceof SourceAttachmentError);
      assert.equal(err.httpStatus, 400);
      assert.match(err.message, /total snapshot limit/);
      return true;
    }
  );
});

test("staging fails fast on a declared over-limit body", async () => {
  let read = false;
  const fetchImpl = async (): Promise<SourceDownloadResponse> => ({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name === "content-length" ? String(MAX_SOURCE_ATTACHMENT_FILE_BYTES + 1) : "application/gzip"),
    },
    arrayBuffer: async () => {
      read = true;
      return new ArrayBuffer(0);
    },
  });
  await assert.rejects(
    () => stageSourceAttachments([FILE_ATTACHMENT], { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof SourceAttachmentError);
      assert.equal(err.httpStatus, 400);
      return true;
    }
  );
  assert.equal(read, false, "over-limit body is refused before reading");
});

test("default snapshot limits are 100 MiB per file and 250 MiB total", () => {
  assert.equal(MAX_SOURCE_ATTACHMENT_FILE_BYTES, 100 * 1024 * 1024);
  assert.equal(MAX_SOURCE_ATTACHMENT_TOTAL_BYTES, 250 * 1024 * 1024);
});

test("safeAttachmentFileName neutralizes traversal and de-duplicates", () => {
  const taken = new Set<string>();
  assert.equal(safeAttachmentFileName("../../etc/passwd", "att-1", taken), "passwd");
  assert.equal(safeAttachmentFileName(".hidden", "att-2", taken), "_hidden");
  assert.equal(safeAttachmentFileName("..", "abcdef12", taken), "attachment-abcdef12");
  assert.equal(safeAttachmentFileName("repro.tar.gz", "x1", taken), "repro.tar.gz");
  assert.equal(safeAttachmentFileName("repro.tar.gz", "x2", taken), "repro.tar-2.gz");
  for (const name of taken) {
    assert.ok(!name.includes("/") && !name.includes("\\"), name);
  }
});

function initWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-inputs-worktree-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

test("materialization writes verified bytes to an ignored, contained path — twice", async () => {
  process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-inputs-blobs-"));
  const bytes = Buffer.concat([Buffer.from("tar-bytes-"), randomBytes(64)]);
  const staged = await stageSourceAttachments([FILE_ATTACHMENT, LINK_ATTACHMENT], {
    fetchImpl: downloadDouble(bytes, { streamed: false }),
  });
  const worktree = initWorktree();
  try {
    const records = storeStagedAttachments("issue-1", staged);
    const manifest = records.filter((r) => r.kind === "file");
    assert.equal(manifest[0]!.blobPath && fs.existsSync(manifest[0]!.blobPath), true);

    const first = materializeSourceAttachments(worktree, records);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.relativePath, ".agent-dealer-inputs/linear/repro.tar.gz");
    const dest = path.join(worktree, first[0]!.relativePath);
    assert.deepEqual(fs.readFileSync(dest), bytes);
    assert.equal(first[0]!.sha256, createHash("sha256").update(bytes).digest("hex"));

    // Repair/retry stability: re-materializing yields identical bytes.
    const second = materializeSourceAttachments(worktree, records);
    assert.deepEqual(second, first);
    assert.deepEqual(fs.readFileSync(dest), bytes);

    // Ignored: the inputs root is in git info/exclude and status stays clean.
    const excludeOut = execFileSync("git", ["-C", worktree, "rev-parse", "--git-path", "info/exclude"], {
      encoding: "utf8",
    });
    const exclude = fs.readFileSync(path.resolve(worktree, excludeOut.trim()), "utf8");
    assert.ok(exclude.split("\n").includes(LINEAR_INPUT_EXCLUDE_LINE));
    assert.equal(execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8" }), "");

    // Never auto-extracted: exactly one file landed, no directory expansion.
    const landed = fs.readdirSync(path.join(worktree, ".agent-dealer-inputs", "linear"));
    assert.deepEqual(landed, ["repro.tar.gz"]);
  } finally {
    discardStaged(staged);
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("materialization fails closed on missing or corrupt blobs", () => {
  const worktree = initWorktree();
  try {
    assert.throws(
      () =>
        materializeSourceAttachments(worktree, [
          {
            linearAttachmentId: "a",
            kind: "file",
            title: "gone.bin",
            safeFileName: "gone.bin",
            blobPath: path.join(worktree, "no-such-blob"),
            sha256: "0".repeat(64),
            url: HOSTED,
          },
        ]),
      /missing/
    );
    const blob = path.join(os.tmpdir(), `dealer-corrupt-blob-${Date.now()}.bin`);
    fs.writeFileSync(blob, Buffer.from("tampered"));
    assert.throws(
      () =>
        materializeSourceAttachments(worktree, [
          {
            linearAttachmentId: "a",
            kind: "file",
            title: "evil.bin",
            safeFileName: "evil.bin",
            blobPath: blob,
            sha256: "1".repeat(64),
            url: HOSTED,
          },
        ]),
      /checksum/
    );
    fs.rmSync(blob, { force: true });
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("developer prompt section lists local paths and links with the trust boundary", () => {
  const lines = sourceAttachmentsDeveloperSection([
    {
      linearAttachmentId: "att-file-1",
      kind: "file",
      title: "repro.tar.gz",
      safeFileName: "repro.tar.gz",
      blobPath: "/blobs/repro.tar.gz",
      sizeBytes: 18,
      sha256: "ab".repeat(32),
      url: HOSTED,
    },
    { linearAttachmentId: "att-link-1", kind: "link", title: "Design doc", url: LINK, subtitle: "Spec" },
  ]);
  const text = lines.join("\n");
  assert.ok(text.includes("## Source attachments (untrusted ticket inputs — inspect only as needed)"));
  assert.ok(text.includes("`.agent-dealer-inputs/linear/repro.tar.gz`"));
  assert.ok(text.includes(`link: "Design doc" — ${LINK}`));
  assert.ok(text.includes("never commit them"));
  assert.ok(text.includes("never extract archives outside a fresh contained directory"));
  assert.ok(text.includes("never fetch external-link targets automatically"));
  assert.equal(sourceAttachmentsDeveloperSection([]).length, 0);
  assert.equal(sourceAttachmentsDeveloperSection(undefined).length, 0);
});

// NOT-367: Linear's upload host authenticates like GraphQL — the snapshot
// download must carry Authorization: <LINEAR_API_KEY>, and a 401 must read
// as an auth failure, never as an expired URL.
async function withLinearApiKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.LINEAR_API_KEY;
  if (value === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prev;
  }
}

test("staging sends the Linear API key as Authorization on hosted downloads", async () => {
  await withLinearApiKey("lin_test_key", async () => {
    const bytes = Buffer.from("auth-bytes");
    const seenInit: Array<{ headers?: Record<string, string> } | undefined> = [];
    const staged = await stageSourceAttachments([FILE_ATTACHMENT], {
      fetchImpl: async (url, init) => {
        seenInit.push(init);
        return downloadDouble(bytes)(url);
      },
    });
    try {
      assert.equal(staged.files.length, 1);
      assert.equal(seenInit.length, 1);
      assert.equal(seenInit[0]?.headers?.Authorization, "lin_test_key");
    } finally {
      discardStaged(staged);
    }
  });
});

test("staging invents no credentials when LINEAR_API_KEY is missing", async () => {
  await withLinearApiKey(undefined, async () => {
    const bytes = Buffer.from("no-key-bytes");
    let captured: { headers?: Record<string, string> } | undefined;
    const staged = await stageSourceAttachments([FILE_ATTACHMENT], {
      fetchImpl: async (url, init) => {
        captured = init;
        return downloadDouble(bytes)(url);
      },
    });
    try {
      assert.equal(staged.files.length, 1, "the attempt still goes out unauthenticated");
      assert.ok(!captured?.headers?.Authorization, "no Authorization header is invented");
    } finally {
      discardStaged(staged);
    }
  });
});

test("staging reports HTTP 401 as rejected credentials when a key is configured", async () => {
  await withLinearApiKey("lin_test_key", async () => {
    const fetchImpl = async (): Promise<SourceDownloadResponse> => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
    });
    await assert.rejects(
      () => stageSourceAttachments([FILE_ATTACHMENT], { fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof SourceAttachmentError);
        assert.equal(err.httpStatus, 502);
        assert.match(err.message, /HTTP 401/);
        assert.match(err.message, /Unauthorized/);
        assert.match(err.message, /rejected the download credentials/);
        assert.match(err.message, /LINEAR_API_KEY/);
        assert.ok(!/expired/i.test(err.message), "a 401 must not blame URL expiry");
        assert.match(err.message, /Nothing was queued/);
        return true;
      }
    );
  });
});

test("staging reports HTTP 401 as missing credentials when no key is configured", async () => {
  await withLinearApiKey(undefined, async () => {
    const fetchImpl = async (): Promise<SourceDownloadResponse> => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
    });
    await assert.rejects(
      () => stageSourceAttachments([FILE_ATTACHMENT], { fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof SourceAttachmentError);
        assert.equal(err.httpStatus, 502);
        assert.match(err.message, /HTTP 401/);
        assert.match(err.message, /Unauthorized/);
        assert.match(err.message, /LINEAR_API_KEY is not configured/);
        assert.ok(!/expired/i.test(err.message), "a 401 must not blame URL expiry");
        return true;
      }
    );
  });
});

test("a 401 on the second file fails the whole staging with nothing returned", async () => {
  await withLinearApiKey("lin_test_key", async () => {
    const second = { id: "att-file-2", title: "b.bin", url: `${HOSTED}-b` };
    const fetchImpl = async (url: string): Promise<SourceDownloadResponse> => {
      if (url === HOSTED) return downloadDouble(Buffer.from("first-bytes"))(url);
      return { ok: false, status: 401, headers: { get: () => null } };
    };
    await assert.rejects(
      () => stageSourceAttachments([FILE_ATTACHMENT, second], { fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof SourceAttachmentError);
        assert.match(err.message, /Unauthorized/);
        assert.match(err.message, /Nothing was queued/);
        return true;
      }
    );
  });
});

test("reviewer prompt section carries manifest metadata, never paths or bytes", () => {
  const lines = sourceAttachmentsReviewerSection([
    {
      linearAttachmentId: "att-file-1",
      kind: "file",
      title: "repro.tar.gz",
      safeFileName: "repro.tar.gz",
      blobPath: "/blobs/repro.tar.gz",
      sizeBytes: 18,
      sha256: "ab".repeat(32),
      contentType: "application/gzip",
      url: HOSTED,
    },
    { linearAttachmentId: "att-link-1", kind: "link", title: "Design doc", url: LINK },
  ]);
  const text = lines.join("\n");
  assert.ok(text.includes("metadata only, no file contents"));
  assert.ok(text.includes('"repro.tar.gz"'));
  assert.ok(text.includes("18 bytes"));
  assert.ok(!text.includes(".agent-dealer-inputs"), "no worktree path is promised to reviewers");
  assert.ok(!text.includes("/blobs/"), "server blob paths stay server-side");
});
