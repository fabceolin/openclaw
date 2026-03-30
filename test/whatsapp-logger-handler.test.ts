import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The handler exports are pure functions we can test directly.
// We import the module using a relative path from the test location.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const handlerModule = await import("../../hooks/whatsapp-logger/handler.js");
const { buildEntry, cleanupOldLogs, resolveLogDir } = handlerModule;
const logMessage = handlerModule.default as (event: Record<string, unknown>) => Promise<void>;

describe("whatsapp-logger handler", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-logger-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("buildEntry", () => {
    it("extracts fields from a well-formed message:received event", () => {
      const event = {
        type: "message",
        action: "received",
        timestamp: new Date("2026-03-26T14:30:00Z"),
        context: {
          from: "+5511999999999",
          content: "Bom dia!",
          channelId: "whatsapp",
          conversationId: "120363123456@g.us",
          messageId: "msg-001",
          timestamp: 1742998200000,
          metadata: {
            provider: "whatsapp",
            surface: "whatsapp-web",
            senderId: "5511999999999@s.whatsapp.net",
            senderName: "Joao",
            senderE164: "+5511999999999",
            channelName: "Familia",
            threadId: undefined,
          },
        },
      };

      const entry = buildEntry(event);

      expect(entry.channel).toBe("whatsapp");
      expect(entry.from).toBe("+5511999999999");
      expect(entry.fromName).toBe("Joao");
      expect(entry.group).toBe("Familia");
      expect(entry.groupId).toBe("120363123456@g.us");
      expect(entry.text).toBe("Bom dia!");
      expect(entry.messageId).toBe("msg-001");
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("uses fallback values for missing fields", () => {
      const event = {
        type: "message",
        action: "received",
        timestamp: new Date("2026-03-26T14:30:00Z"),
        context: {},
      };

      const entry = buildEntry(event);

      expect(entry.channel).toBe("unknown");
      expect(entry.from).toBe("unknown");
      expect(entry.fromName).toBe("");
      expect(entry.group).toBe("");
      expect(entry.text).toBe("");
    });

    it("handles DM messages (no group info)", () => {
      const event = {
        type: "message",
        action: "received",
        timestamp: new Date("2026-03-26T14:30:00Z"),
        context: {
          from: "+5511888888888",
          content: "Oi",
          channelId: "whatsapp",
          conversationId: "+5511888888888",
          messageId: "dm-001",
          metadata: {
            provider: "whatsapp",
            senderName: "Maria",
            senderE164: "+5511888888888",
          },
        },
      };

      const entry = buildEntry(event);

      expect(entry.group).toBe("");
      expect(entry.groupId).toBe("+5511888888888");
      expect(entry.from).toBe("+5511888888888");
      expect(entry.fromName).toBe("Maria");
    });

    it("prefers context.timestamp over event.timestamp", () => {
      const event = {
        type: "message",
        action: "received",
        timestamp: new Date("2026-01-01T00:00:00Z"),
        context: {
          timestamp: 1742998200000, // 2025-03-26T14:30:00Z
        },
      };

      const entry = buildEntry(event);

      // Context timestamp should win
      expect(entry.ts).toContain("2025-03-26");
    });
  });

  describe("cleanupOldLogs", () => {
    it("removes JSONL files older than retention period", async () => {
      const logDir = path.join(tmpDir, "logs");
      await fs.mkdir(logDir, { recursive: true });

      // Create an old file and a recent file
      await fs.writeFile(path.join(logDir, "2025-01-01.jsonl"), '{"test":true}\n');
      await fs.writeFile(path.join(logDir, "2026-03-25.jsonl"), '{"test":true}\n');

      const removed = await cleanupOldLogs(logDir, 30);

      expect(removed).toBe(1);

      const files = await fs.readdir(logDir);
      expect(files).toContain("2026-03-25.jsonl");
      expect(files).not.toContain("2025-01-01.jsonl");
    });

    it("ignores non-JSONL files", async () => {
      const logDir = path.join(tmpDir, "logs");
      await fs.mkdir(logDir, { recursive: true });

      await fs.writeFile(path.join(logDir, "readme.txt"), "hello");
      await fs.writeFile(path.join(logDir, ".last_summarized"), "2026-03-26T00:00:00Z");

      const removed = await cleanupOldLogs(logDir, 0);

      expect(removed).toBe(0);
      const files = await fs.readdir(logDir);
      expect(files).toContain("readme.txt");
      expect(files).toContain(".last_summarized");
    });

    it("returns 0 for non-existent directory", async () => {
      const removed = await cleanupOldLogs(path.join(tmpDir, "nonexistent"), 30);
      expect(removed).toBe(0);
    });
  });

  describe("resolveLogDir", () => {
    it("uses provided stateDir", () => {
      const dir = resolveLogDir("/custom/state");
      expect(dir).toBe(path.join("/custom/state", "logs", "messages"));
    });

    it("uses OPENCLAW_STATE_DIR env var when no stateDir provided", () => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/env/state");
      const dir = resolveLogDir();
      expect(dir).toBe(path.join("/env/state", "logs", "messages"));
    });

    it("falls back to ~/.openclaw when no env or param", () => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "");
      const dir = resolveLogDir();
      expect(dir).toBe(path.join(os.homedir(), ".openclaw", "logs", "messages"));
    });
  });

  describe("logMessage (default export)", () => {
    it("ignores non-message events", async () => {
      // Should not throw or write anything
      await logMessage({ type: "command", action: "new" });
      await logMessage({ type: "message", action: "sent" });
    });

    it("writes a JSONL entry for message:received events", async () => {
      const logDir = path.join(tmpDir, "logs", "messages");
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);

      const event = {
        type: "message",
        action: "received",
        timestamp: new Date("2026-03-26T14:30:00Z"),
        context: {
          from: "+5511999999999",
          content: "Hello world",
          channelId: "whatsapp",
          conversationId: "120363123456@g.us",
          messageId: "msg-001",
          metadata: {
            provider: "whatsapp",
            senderName: "Joao",
            senderE164: "+5511999999999",
            channelName: "Test Group",
          },
        },
      };

      await logMessage(event);

      const files = await fs.readdir(logDir);
      expect(files).toContain("2026-03-26.jsonl");

      const content = await fs.readFile(path.join(logDir, "2026-03-26.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.channel).toBe("whatsapp");
      expect(parsed.from).toBe("+5511999999999");
      expect(parsed.fromName).toBe("Joao");
      expect(parsed.group).toBe("Test Group");
      expect(parsed.text).toBe("Hello world");
      expect(parsed.messageId).toBe("msg-001");
    });

    it("appends multiple messages to the same file", async () => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);

      const baseEvent = {
        type: "message",
        action: "received",
        timestamp: new Date("2026-03-26T14:30:00Z"),
        context: {
          from: "+55111",
          content: "msg1",
          channelId: "whatsapp",
          metadata: { provider: "whatsapp" },
        },
      };

      await logMessage(baseEvent);
      await logMessage({
        ...baseEvent,
        context: { ...baseEvent.context, content: "msg2" },
      });

      const logDir = path.join(tmpDir, "logs", "messages");
      const content = await fs.readFile(path.join(logDir, "2026-03-26.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).text).toBe("msg1");
      expect(JSON.parse(lines[1]).text).toBe("msg2");
    });
  });
});
