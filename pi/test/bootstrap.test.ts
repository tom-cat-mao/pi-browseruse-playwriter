import { beforeEach, describe, expect, it, vi } from "vitest";
import { RelayError } from "../extensions/relay-client.ts";
import * as bootstrap from "../extensions/bootstrap.ts";
import { parseSessionId } from "../extensions/bootstrap.ts";

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  getExtensionStatus: vi.fn(),
  createSession: vi.fn(),
  getCapabilities: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock("../extensions/relay-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/relay-client.ts")>();
  return {
    ...actual,
    getVersion: mocks.getVersion,
    getExtensionStatus: mocks.getExtensionStatus,
    createSession: mocks.createSession,
    getCapabilities: mocks.getCapabilities,
    deleteSession: mocks.deleteSession,
  };
});

function makePi(execImpl?: ReturnType<typeof vi.fn>) {
  const fn = execImpl ?? vi.fn();
  return {
    exec: fn as (command: string, args: string[], options?: unknown) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>,
  };
}

function makeCtx(sessionId = "abcdef123456") {
  return { sessionManager: { getSessionId: () => sessionId } } as never;
}

const caps404 = { sessionGroups: false, consent: false, audit: false, closeTabs: false };

beforeEach(() => {
  vi.clearAllMocks();
  bootstrap.reset();
  mocks.getCapabilities.mockResolvedValue(caps404);
  mocks.deleteSession.mockResolvedValue(true);
});

describe("ensureSession", () => {
  it("creates a session over HTTP named pi-<id8> when the relay is reachable", async () => {
    mocks.getVersion.mockResolvedValue("0.4.0");
    mocks.getExtensionStatus.mockResolvedValue({ connected: true, activeTargets: 1, browser: "Chrome", playwriterVersion: "0.4.0" });
    mocks.createSession.mockResolvedValue({ id: "42", mode: "extension" });

    const s = await bootstrap.ensureSession(makePi(), makeCtx("abcdef123456"));
    expect(s).toEqual({ id: "42", name: "pi-abcdef12" });
    expect(mocks.createSession).toHaveBeenCalledWith(expect.any(String), {
      name: "pi-abcdef12",
      groupTitle: undefined,
    });
    expect(bootstrap.boundCapabilities()).toEqual(caps404);
    expect(mocks.getCapabilities).toHaveBeenCalledTimes(1);
  });

  it("passes the remembered group title into session creation", async () => {
    mocks.getVersion.mockResolvedValue("0.4.0");
    mocks.getExtensionStatus.mockResolvedValue({ connected: true, activeTargets: 0, browser: "Chrome", playwriterVersion: null });
    mocks.createSession.mockResolvedValue({ id: "1", mode: "extension" });

    await bootstrap.ensureSession(makePi(), makeCtx("abcdef123456"), { groupTitle: "TikTok ads task" });
    expect(mocks.createSession).toHaveBeenCalledWith(expect.any(String), {
      name: "pi-abcdef12",
      groupTitle: "TikTok ads task",
    });
  });

  it("auto-starts the relay via global CLI and parses the session id when unreachable", async () => {
    mocks.getVersion.mockResolvedValue(null);
    const exec = vi.fn().mockResolvedValue({ stdout: "1\n", stderr: "", code: 0, killed: false });

    const s = await bootstrap.ensureSession(makePi(exec), makeCtx("abcdef123456"));
    expect(exec).toHaveBeenCalledWith("playwriter", ["session", "new"], expect.objectContaining({ timeout: 90_000 }));
    expect(s.id).toBe("1");
    expect(bootstrap.boundCapabilities()).toEqual(caps404);
  });

  it("falls back to npx -y playwriter@latest when the global CLI is missing", async () => {
    mocks.getVersion.mockResolvedValue(null);
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "command not found", code: 127, killed: false })
      .mockResolvedValueOnce({ stdout: "Session 7 created\n", stderr: "", code: 0, killed: false });

    const s = await bootstrap.ensureSession(makePi(exec), makeCtx("abcdef123456"));
    expect(exec).toHaveBeenNthCalledWith(2, "npx", ["-y", "playwriter@latest", "session", "new"], expect.anything());
    expect(s.id).toBe("7");
  });

  it("throws extension-disconnected when the relay is up but no extension is attached", async () => {
    mocks.getVersion.mockResolvedValue("0.4.0");
    mocks.getExtensionStatus.mockResolvedValue({ connected: false, activeTargets: 0, browser: null, playwriterVersion: null });

    await expect(bootstrap.ensureSession(makePi(), makeCtx("abcdef123456"))).rejects.toMatchObject({
      category: "extension-disconnected",
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("recreates the session after invalidateSession (session-invalid recovery)", async () => {
    mocks.getVersion.mockResolvedValue("0.4.0");
    mocks.getExtensionStatus.mockResolvedValue({ connected: true, activeTargets: 0, browser: "Chrome", playwriterVersion: null });
    mocks.createSession.mockResolvedValue({ id: "1", mode: "extension" });

    await bootstrap.ensureSession(makePi(), makeCtx("abcdef123456"));
    expect(bootstrap.boundSessionId()).toBe("1");

    bootstrap.invalidateSession();
    mocks.createSession.mockResolvedValue({ id: "2", mode: "extension" });
    const s = await bootstrap.ensureSession(makePi(), makeCtx("abcdef123456"));
    expect(s.id).toBe("2");
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
  });

  it("reuses the bound session on subsequent calls without recreating", async () => {
    mocks.getVersion.mockResolvedValue("0.4.0");
    mocks.getExtensionStatus.mockResolvedValue({ connected: true, activeTargets: 0, browser: "Chrome", playwriterVersion: null });
    mocks.createSession.mockResolvedValue({ id: "1", mode: "extension" });

    await bootstrap.ensureSession(makePi(), makeCtx("abcdef123456"));
    await bootstrap.ensureSession(makePi(), makeCtx("abcdef123456"));
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("raises a RelayError with a helpful message when both CLI paths fail", async () => {
    mocks.getVersion.mockResolvedValue(null);
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "not found", code: 127, killed: false });

    await expect(bootstrap.ensureSession(makePi(exec), makeCtx("abcdef123456"))).rejects.toMatchObject({
      category: "relay-unreachable",
    });
  });
});

describe("closeSession", () => {
  it("deletes the relay session and resets module state", async () => {
    mocks.getVersion.mockResolvedValue("0.4.0");
    mocks.getExtensionStatus.mockResolvedValue({ connected: true, activeTargets: 0, browser: "Chrome", playwriterVersion: null });
    mocks.createSession.mockResolvedValue({ id: "9", mode: "extension" });

    await bootstrap.ensureSession(makePi(), makeCtx("abcdef123456"));
    await bootstrap.closeSession();

    expect(mocks.deleteSession).toHaveBeenCalledWith("9");
    expect(bootstrap.boundSessionId()).toBeUndefined();
  });
});

describe("parseSessionId", () => {
  it("parses a bare number line", () => {
    expect(parseSessionId("1\n")).toBe("1");
  });
  it("parses 'Session N created' style output", () => {
    expect(parseSessionId("Session 7 created\n")).toBe("7");
  });
  it("returns null on garbage", () => {
    expect(parseSessionId("error\n")).toBeNull();
  });
});
