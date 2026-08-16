/**
 * Cassette format v2: the compatibility commitments, pinned as tests: v1
 * files read forever, a missing era means "legacy", unknown entry types are
 * skipped (not fatal), and files from a future format are refused loudly,
 * including by the published 0.1.x reader meeting a file written today.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CassetteWriter,
  cassetteEra,
  readCassette,
  writeCassette,
  type Cassette,
  type ChunksEntry,
} from "../src/cassette.js";
import { redactCassette, scanCassette } from "../src/redact.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-v2-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const file = (name: string) => path.join(tmpDir, name);
const write = (name: string, lines: string[]) => {
  const p = file(name);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
};
const fileLines = (p: string) =>
  fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** Byte-for-byte the kind of file mcp-cassette 0.1.x wrote. */
const V1_LINES = [
  '{"type":"header","cassetteVersion":1,"recorder":"mcp-cassette@0.1.2","startedAt":"2026-08-15T14:02:44.380Z","transport":"stdio","command":["node","tiny-server.mjs"],"redaction":{"applied":true}}',
  '{"type":"frame","t":10,"dir":"c2s","frame":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}}',
  '{"type":"frame","t":22,"dir":"s2c","frame":{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"tiny"}}}}',
  '{"type":"raw","t":30,"dir":"s2c","data":"tiny-server: ready"}',
];

describe("v1 backward compatibility", () => {
  it("reads a 0.1.x cassette with every entry intact", () => {
    const cassette = readCassette(write("v1.cassette.jsonl", V1_LINES));
    expect(cassette.header.cassetteVersion).toBe(1);
    expect(cassette.entries).toHaveLength(3);
    expect(cassette.entries.map((e) => e.type)).toEqual(["frame", "frame", "raw"]);
  });

  it("treats a missing era as legacy, and an explicit era as itself", () => {
    const { header } = readCassette(write("v1-era.cassette.jsonl", V1_LINES));
    expect(header.era).toBeUndefined();
    expect(cassetteEra(header)).toBe("legacy");
    expect(cassetteEra({ ...header, era: "modern" })).toBe("modern");
  });
});

describe("unknown entry types", () => {
  it("skips them with a warning instead of failing or silently dropping", () => {
    const p = write("unknown.cassette.jsonl", [
      `{"type":"header","cassetteVersion":2,"recorder":"mcp-cassette@9.9.9","startedAt":"2026-08-15T00:00:00Z","transport":"stdio"}`,
      '{"type":"wormhole","t":5,"payload":42}',
      '{"type":"frame","t":10,"dir":"c2s","frame":{"jsonrpc":"2.0","id":1,"method":"tools/list"}}',
    ]);
    const warnings: string[] = [];
    const cassette = readCassette(p, (m) => warnings.push(m));
    expect(cassette.entries).toHaveLength(1);
    expect(cassette.entries[0]!.type).toBe("frame");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"wormhole"');
    expect(warnings[0]).toContain("newer mcp-cassette");
  });
});

describe("version gate", () => {
  it("refuses a future-version file, naming the cause and the fix", () => {
    const p = write("future.cassette.jsonl", [
      '{"type":"header","cassetteVersion":3,"recorder":"mcp-cassette@9.9.9","startedAt":"2026-08-15T00:00:00Z","transport":"stdio"}',
    ]);
    expect(() => readCassette(p)).toThrow(/version 3.*newer mcp-cassette.*supports 1, 2.*Upgrade/s);
  });

  it("a 0.1.x-style reader refuses a file this version writes, with a clear error", async () => {
    const p = file("written-now.cassette.jsonl");
    const writer = new CassetteWriter(p, ["some-server"]);
    writer.frame("c2s", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await writer.close();

    // The published 0.1.x version gate, replicated shape-for-shape: strict
    // equality against its own CASSETTE_VERSION of 1. If this stops refusing
    // our output, the version bump has been lost and old binaries would
    // silently mis-replay v2 files.
    const readWithV1Gate = () => {
      const first = JSON.parse(fs.readFileSync(p, "utf8").split("\n")[0]!) as {
        cassetteVersion: number;
      };
      if (first.cassetteVersion !== 1) {
        throw new Error(`Unsupported cassette version ${first.cassetteVersion} (supported: 1)`);
      }
    };
    expect(fileLines(p)[0]!.cassetteVersion).toBe(2);
    expect(readWithV1Gate).toThrow("Unsupported cassette version 2 (supported: 1)");
  });
});

describe("chunks and http fields", () => {
  it("round-trips chunks entries (id-bearing and id-less via:get) through writeCassette", () => {
    const postStream: ChunksEntry = {
      type: "chunks",
      t: 1204,
      dir: "s2c",
      id: 7,
      chunks: [
        { t: 1204, frame: { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } } },
        { t: 1355, frame: { jsonrpc: "2.0", id: 7, result: { content: [] } } },
      ],
    };
    const getStream: ChunksEntry = {
      type: "chunks",
      t: 900,
      dir: "s2c",
      via: "get",
      chunks: [{ t: 905, frame: { jsonrpc: "2.0", method: "notifications/resources/updated" } }],
    };
    const original: Cassette = {
      header: {
        type: "header",
        cassetteVersion: 2,
        recorder: "mcp-cassette@test",
        startedAt: "2026-08-15T09:00:00Z",
        transport: "http",
        url: "https://api.example.com/mcp",
        era: "legacy",
        sessioned: true,
        redaction: { applied: true },
      },
      entries: [postStream, getStream],
    };
    const p = file("chunks.cassette.jsonl");
    writeCassette(p, original);
    expect(readCassette(p)).toEqual(original);
  });

  it("redacts and scans secrets in chunks frames and the header url", () => {
    const dirty: Cassette = {
      header: { type: "header", cassetteVersion: 2, recorder: "r", startedAt: "t", transport: "http",
        url: "https://alice:hunter2pass@api.example.com/mcp", redaction: { applied: false } },
      entries: [{ type: "chunks", t: 1, dir: "s2c", id: 3,
        chunks: [{ t: 1, frame: { jsonrpc: "2.0", id: 3, result: { token: "sk-ant-api03-FAKEFAKEFAKE" } } }] }],
    };
    const scanned = scanCassette(dirty);
    expect(scanned.map((h) => h.path)).toContain("url");
    expect(scanned.some((h) => h.dir === "s2c")).toBe(true);
    const clean = redactCassette(dirty);
    expect(JSON.stringify(clean)).not.toMatch(/hunter2pass|FAKEFAKEFAKE/);
    expect(JSON.stringify(dirty)).toMatch(/hunter2pass/); // pure: input untouched
  });
});

describe("deferred-header writer", () => {
  it("buffers entries until the era is decided, then flushes header-first", async () => {
    const p = file("deferred.cassette.jsonl");
    const writer = new CassetteWriter(p, undefined, { applied: true },
      { transport: "http", url: "https://api.example.com/mcp", deferHeader: true });
    writer.frame("c2s", { jsonrpc: "2.0", id: 1, method: "server/discover" });
    writer.frame("s2c", { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "s" } } });
    writer.setEra("modern");
    writer.frame("c2s", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    await writer.close();

    const lines = fileLines(p);
    expect(lines[0]).toMatchObject({ type: "header", era: "modern", transport: "http", url: "https://api.example.com/mcp" });
    expect(lines.slice(1).map((l) => l.type)).toEqual(["frame", "frame", "frame"]);
    // Indistinguishable from an eagerly written file: readable as-is.
    expect(readCassette(p).entries).toHaveLength(3);
  });

  it("an empty session (no era decision) yields a valid file with era omitted", async () => {
    const p = file("empty.cassette.jsonl");
    const writer = new CassetteWriter(p, undefined, { applied: true }, { deferHeader: true });
    await writer.close();

    const cassette = readCassette(p);
    expect(cassette.entries).toHaveLength(0);
    expect(cassette.header).not.toHaveProperty("era");
    expect(cassetteEra(cassette.header)).toBe("legacy");
  });

  it("refuses setEra once the header is on disk", async () => {
    const p = file("eager.cassette.jsonl");
    const writer = new CassetteWriter(p);
    expect(() => writer.setEra("modern")).toThrow(/header already written/);
    await writer.close();
  });
});
