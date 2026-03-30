import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FILTER_SCRIPT = path.resolve(__dirname, "../../scripts/filter-messages.py");

describe("whatsapp summarizer: filter-messages.py", () => {
  let tmpDir: string;
  let logDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-summarizer-test-"));
    logDir = path.join(tmpDir, "logs", "messages");
    await fs.mkdir(logDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function runFilter(lastTs: string): string {
    return execSync(`python3 "${FILTER_SCRIPT}" "${lastTs}" "${logDir}"`, {
      encoding: "utf-8",
    }).trim();
  }

  it("filters messages newer than watermark", async () => {
    const messages =
      [
        JSON.stringify({ ts: "2026-03-26T08:00:00.000Z", from: "a", text: "old" }),
        JSON.stringify({ ts: "2026-03-26T12:00:00.000Z", from: "b", text: "new" }),
        JSON.stringify({ ts: "2026-03-26T14:00:00.000Z", from: "c", text: "newer" }),
      ].join("\n") + "\n";

    await fs.writeFile(path.join(logDir, "2026-03-26.jsonl"), messages);

    const output = runFilter("2026-03-26T10:00:00.000Z");
    const lines = output.split("\n").filter(Boolean);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).text).toBe("new");
    expect(JSON.parse(lines[1]).text).toBe("newer");
  });

  it("returns empty for no messages after watermark", async () => {
    const messages =
      [JSON.stringify({ ts: "2026-03-26T08:00:00.000Z", from: "a", text: "old" })].join("\n") +
      "\n";

    await fs.writeFile(path.join(logDir, "2026-03-26.jsonl"), messages);

    const output = runFilter("2026-03-26T23:59:59.000Z");
    expect(output).toBe("");
  });

  it("reads from multiple JSONL files across days", async () => {
    await fs.writeFile(
      path.join(logDir, "2026-03-25.jsonl"),
      JSON.stringify({ ts: "2026-03-25T23:00:00.000Z", from: "a", text: "yesterday" }) + "\n",
    );
    await fs.writeFile(
      path.join(logDir, "2026-03-26.jsonl"),
      JSON.stringify({ ts: "2026-03-26T01:00:00.000Z", from: "b", text: "today" }) + "\n",
    );

    const output = runFilter("2026-03-25T20:00:00.000Z");
    const lines = output.split("\n").filter(Boolean);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).text).toBe("yesterday");
    expect(JSON.parse(lines[1]).text).toBe("today");
  });

  it("skips malformed JSON lines gracefully", async () => {
    const content =
      [
        JSON.stringify({ ts: "2026-03-26T12:00:00.000Z", from: "a", text: "good" }),
        "not valid json {{{",
        "",
        JSON.stringify({ ts: "2026-03-26T14:00:00.000Z", from: "b", text: "also good" }),
      ].join("\n") + "\n";

    await fs.writeFile(path.join(logDir, "2026-03-26.jsonl"), content);

    const output = runFilter("2026-03-26T10:00:00.000Z");
    const lines = output.split("\n").filter(Boolean);

    expect(lines).toHaveLength(2);
  });

  it("handles empty log directory", async () => {
    const output = runFilter("2026-03-26T00:00:00.000Z");
    expect(output).toBe("");
  });

  it("ignores non-jsonl files", async () => {
    await fs.writeFile(path.join(logDir, "readme.txt"), "not a log");
    await fs.writeFile(path.join(logDir, ".last_summarized"), "2026-03-26T00:00:00.000Z");

    const output = runFilter("2000-01-01T00:00:00.000Z");
    expect(output).toBe("");
  });
});

describe("whatsapp summarizer: watermark file", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-watermark-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("watermark file format is a valid ISO timestamp", async () => {
    const watermark = "2026-03-26T14:30:00.000Z";
    const watermarkFile = path.join(tmpDir, ".last_summarized");
    await fs.writeFile(watermarkFile, watermark);

    const content = await fs.readFile(watermarkFile, "utf-8");
    expect(new Date(content.trim()).toISOString()).toBe(watermark);
  });
});
