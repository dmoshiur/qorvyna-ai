// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/components/dialogs", () => ({ useDialogs: () => ({ confirm, element: null }) }));
import { GithubConnection } from "../src/components/github-connection";

const head = "a".repeat(40);
const file = { path: "index.html", content: "new", language: "html" };
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(text)) as HTMLButtonElement;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  confirm.mockClear();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/github/status") return Response.json({ configured: true, connected: true, connection: { login: "user" } });
    if (url === "/api/github/repos") return Response.json({ repositories: [{ id: 1, fullName: "owner/repo", private: true, defaultBranch: "main", permissions: { push: true } }] });
    if (url === "/api/github/preview") return Response.json({ head, expiresAt: Date.now() + 60_000, reviewToken: "review-token", files: [{ path: file.path, before: "old", after: "new", status: "changed" }] });
    if (url === "/api/github/push" && init?.method === "POST") return Response.json({ commitSha: "b".repeat(40), commitUrl: "https://github.com/owner/repo/commit/example" });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("GitHub comparison UI", () => {
  it("requires comparison, approval and explicit confirmation before sending the snapshot", async () => {
    await act(async () => { root.render(<GithubConnection showPush files={[file, { path: "asset.png", content: "AAAA", language: "text", encoding: "base64" }]} />); });
    expect(button(container, "Push to GitHub").disabled).toBe(true);
    expect(container.textContent).toContain("binary files are not supported");
    await act(async () => { button(container, "Compare with GitHub").click(); });
    expect(container.textContent).toContain("index.html · changed");
    expect(container.textContent).toContain("old");
    expect(container.textContent).toContain("new");
    const approval = [...container.querySelectorAll('input[type="checkbox"]')].find((el) => el.parentElement?.textContent?.includes("I reviewed")) as HTMLInputElement;
    await act(async () => { approval.click(); });
    expect(button(container, "Push to GitHub").disabled).toBe(false);
    await act(async () => { button(container, "Push to GitHub").click(); });
    expect(confirm).toHaveBeenCalledOnce();
    const pushCall = fetchMock.mock.calls.find(([url]) => url === "/api/github/push")!;
    const payload = JSON.parse(String(pushCall[1]?.body));
    expect(payload.reviewToken).toBe("review-token");
    expect(payload.files).toEqual([file]);
    expect(container.textContent).toContain("Pushed commit");
  });
  it("invalidates approval when workspace file content changes", async () => {
    await act(async () => { root.render(<GithubConnection showPush files={[file]} />); });
    await act(async () => { button(container, "Compare with GitHub").click(); });
    const approval = [...container.querySelectorAll('input[type="checkbox"]')].find((el) => el.parentElement?.textContent?.includes("I reviewed")) as HTMLInputElement;
    await act(async () => { approval.click(); });
    await act(async () => { root.render(<GithubConnection showPush files={[{ ...file, content: "modified after review" }]} />); });
    expect(button(container, "Push to GitHub").disabled).toBe(true);
    expect(container.textContent).toContain("Files or target changed");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/github/push")).toBe(false);
  });
  it("imports only reviewed changed remote text after separate approval and confirmation", async () => {
    const onImport = vi.fn(async () => {});
    await act(async () => { root.render(<GithubConnection showPush files={[file]} projectId="project-1" projectRevision={4} onImport={onImport} />); });
    await act(async () => { button(container, "Compare with GitHub").click(); });
    expect(button(container, "Import reviewed remote files").disabled).toBe(true);
    const approval = [...container.querySelectorAll('input[type="checkbox"]')].find((el) => el.parentElement?.textContent?.includes("approve replacing")) as HTMLInputElement;
    await act(async () => { approval.click(); });
    await act(async () => { button(container, "Import reviewed remote files").click(); });
    expect(confirm).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledWith({ projectId: "project-1", expectedRevision: 4, files: [{ path: "index.html", content: "old" }], localFiles: [{ path: "index.html", content: "new" }] });
    expect(container.textContent).toContain("snapshot of the previous workspace");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/github/push")).toBe(false);
  });
  it("blocks import with unsaved changes and invalidates approval when selection changes", async () => {
    const onImport = vi.fn(async () => {});
    await act(async () => { root.render(<GithubConnection showPush files={[file]} projectId="p" projectRevision={4} onImport={onImport} importDisabled />); });
    await act(async () => { button(container, "Compare with GitHub").click(); });
    expect(button(container, "Import reviewed remote files").disabled).toBe(true);
    expect(container.textContent).toContain("Save pending workspace changes");
    await act(async () => { root.render(<GithubConnection showPush files={[file]} projectId="p" projectRevision={4} onImport={onImport} />); });
    const approve = [...container.querySelectorAll('input[type="checkbox"]')].find((el) => el.parentElement?.textContent?.includes("approve replacing")) as HTMLInputElement;
    await act(async () => { approve.click(); });
    const selection = [...container.querySelectorAll('input[type="checkbox"]')].find((el) => el.parentElement?.textContent?.includes("index.html")) as HTMLInputElement;
    await act(async () => { selection.click(); selection.click(); });
    expect(button(container, "Import reviewed remote files").disabled).toBe(true);
    expect(onImport).not.toHaveBeenCalled();
  });

});
