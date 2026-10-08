/**
 * Expected verdict: 3 passed.
 *
 * A stdio cassette registers no hooks at all, so the handle has to be right on
 * its own: the argv it hands back, the HTTP-shaped accessors it refuses, and
 * the replay a client actually gets when it spawns that argv.
 */
import { describe, expect, it } from "@jest/globals";
import { spawn } from "node:child_process";
import { useCassette } from "mcp-cassette/jest";

describe("stdio cassettes hand back a command instead of a server", () => {
  const tape = useCassette(new URL("../stdio-tape.jsonl", import.meta.url).pathname);

  it("names node, the built CLI, and the cassette", () => {
    expect(tape.command[0]).toBe(process.execPath);
    expect(tape.command[1]).toMatch(/cli\.js$/);
    expect(tape.command.slice(2, 3)).toEqual(["replay"]);
    expect(tape.command[3]).toMatch(/stdio-tape\.jsonl$/);
  });

  it("refuses the HTTP-shaped accessors, by name", () => {
    expect(() => tape.url).toThrow(/stdio cassette/);
    expect(() => tape.server).toThrow(/no in-process server/);
  });

  it("actually replays over stdio when spawned", async () => {
    const child = spawn(tape.command[0], tape.command.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    const answer = new Promise((resolve) => {
      let buf = "";
      child.stdout.on("data", (c) => {
        buf += c.toString("utf8");
        const line = buf.split("\n").find((l) => l.trim().length > 0);
        if (line) resolve(line);
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
    const line = await answer;
    child.stdin.end();
    child.kill();
    expect(JSON.parse(line)).toMatchObject({ id: 1, result: { tools: [{ name: "echo" }] } });
  });
});
