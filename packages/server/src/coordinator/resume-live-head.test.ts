// packages/server/src/coordinator/resume-live-head.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchResumeLiveHeadSha, setResumeLiveHeadReaderForTests } from "./resume-live-head.js";

test("fetchResumeLiveHeadSha returns null when the issue has no PR, without calling the reader", async () => {
  setResumeLiveHeadReaderForTests(async () => {
    throw new Error("must not be called without a PR number");
  });
  try {
    assert.equal(await fetchResumeLiveHeadSha({ prNumber: null, repo: "acme/app" }), null);
  } finally {
    setResumeLiveHeadReaderForTests(null);
  }
});

test("fetchResumeLiveHeadSha returns null when the reader throws or returns empty", async () => {
  setResumeLiveHeadReaderForTests(async () => {
    throw new Error("gh is down");
  });
  try {
    assert.equal(await fetchResumeLiveHeadSha({ prNumber: 42, repo: "acme/app" }), null);
  } finally {
    setResumeLiveHeadReaderForTests(null);
  }

  setResumeLiveHeadReaderForTests(async () => "");
  try {
    assert.equal(await fetchResumeLiveHeadSha({ prNumber: 42, repo: "acme/app" }), null);
  } finally {
    setResumeLiveHeadReaderForTests(null);
  }
});

test("fetchResumeLiveHeadSha passes the live head through", async () => {
  setResumeLiveHeadReaderForTests(async () => "d369964abcdef");
  try {
    assert.equal(await fetchResumeLiveHeadSha({ prNumber: 42, repo: "acme/app" }), "d369964abcdef");
  } finally {
    setResumeLiveHeadReaderForTests(null);
  }
});
