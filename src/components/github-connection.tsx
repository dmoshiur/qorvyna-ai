"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkCheck,
  Check,
  FolderPlus,
  GitBranch,
  Github,
  GitPullRequestArrow,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { AgentFile } from "@/lib/ai/agent";
import { GithubPullRequestBrowser } from "@/components/github-pull-request-browser";
import { GithubPullRequest } from "@/components/github-pull-request";
import { useDialogs } from "@/components/dialogs";
import { Button, Input, Select } from "@/components/ui";
import { mintSessionCookie, optionalAuthHeaders } from "@/lib/client/api";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import { useAuthLifecycle } from "@/components/auth/auth-provider";

export type GithubStatus = {
  configured: boolean;
  oauthConfigured?: boolean;
  connected: boolean;
  reauthorize?: boolean;
  upstreamDegraded?: boolean;
  configuration_error?: string;
  connection?: {
    login: string;
    name: string;
    avatarUrl: string;
    connectedAt: string;
    authMethod?: "oauth" | "pat";
  } | null;
};

type Repo = {
  id: number;
  fullName: string;
  htmlUrl?: string;
  private: boolean;
  defaultBranch: string;
  permissions: { push: boolean };
};

type GithubFile = AgentFile & { encoding?: "utf8" | "base64" };
type Review = {
  head: string;
  expiresAt: number;
  reviewToken: string;
  files: Array<{
    path: string;
    before: string | null;
    after: string;
    status: "new" | "changed" | "unchanged";
  }>;
  inputKey: string;
};

type ImportRequest = {
  files: Array<{ path: string; content: string }>;
  localFiles: Array<{ path: string; content: string }>;
  expectedRevision: number;
  projectId: string;
};

function slugifyRepoName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "qorvyna-project";
}

function targetStorageKey(projectId?: string): string {
  return `qorvyna:github-target:${projectId || "workspace"}`;
}

function readLocalTarget(projectId?: string): { repository: string; branch: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(targetStorageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { repository?: string; branch?: string };
    if (typeof parsed.repository === "string" && parsed.repository.includes("/")) {
      return {
        repository: parsed.repository,
        branch: typeof parsed.branch === "string" && parsed.branch ? parsed.branch : "main",
      };
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function writeLocalTarget(projectId: string | undefined, repository: string, branch: string) {
  if (typeof window === "undefined" || !repository) return;
  try {
    window.localStorage.setItem(targetStorageKey(projectId), JSON.stringify({ repository, branch }));
  } catch {
    // ignore storage errors
  }
}

async function githubFetch(url: string, init?: RequestInit): Promise<Response> {
  const authHeaders = await optionalAuthHeaders();
  const hasAuth = Object.keys(authHeaders).length > 0;
  const mergedInit: RequestInit | undefined =
    init || hasAuth
      ? {
          ...init,
          headers: {
            ...authHeaders,
            ...(init?.headers ?? {}),
          },
        }
      : undefined;

  let response = mergedInit ? await fetch(url, mergedInit) : await fetch(url);
  if (response.status === 401 && firebaseBrowserConfigured) {
    try {
      const current = fbAuth().currentUser;
      if (current) {
        await mintSessionCookie(current, { forceRefresh: true });
        const retryAuth = await optionalAuthHeaders(true);
        response = await fetch(url, {
          ...init,
          headers: {
            ...retryAuth,
            ...(init?.headers ?? {}),
          },
        });
      }
    } catch {
      // preserve original 401 response
    }
  }
  return response;
}

export function GithubConnection({
  files = [],
  showPush = false,
  projectRevision,
  projectId,
  importDisabled = false,
  onImport,
  suggestedRepoName,
  suggestedRepoDescription,
  autoOpenCreateRepo = false,
}: {
  files?: GithubFile[];
  showPush?: boolean;
  projectRevision?: number;
  projectId?: string;
  importDisabled?: boolean;
  onImport?: (request: ImportRequest) => Promise<void>;
  suggestedRepoName?: string;
  suggestedRepoDescription?: string;
  autoOpenCreateRepo?: boolean;
}) {
  const dialogs = useDialogs();
  const authLifecycle = useAuthLifecycle();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [statusLoadFailed, setStatusLoadFailed] = useState(false);
  const [connectHref, setConnectHref] = useState("/api/github/connect");

  useEffect(() => {
    const path = window.location.pathname;
    if (
      /^\/chat(?:\/[a-zA-Z0-9_-]{1,128})?$/.test(path) ||
      path === "/settings" ||
      path === "/terminal" ||
      /^\/projects\/[a-zA-Z0-9_-]{1,128}$/.test(path)
    ) {
      setConnectHref(`/api/github/connect?next=${encodeURIComponent(path)}`);
    }
  }, []);

  const [repos, setRepos] = useState<Repo[]>([]);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("Apply QORVYNA Agent changes");
  const [prBranch, setPrBranch] = useState("qorvyna/agent-changes");
  const [prTitle, setPrTitle] = useState("Apply QORVYNA Agent changes");
  const [prTitleEdited, setPrTitleEdited] = useState(false);
  const [prBody, setPrBody] = useState("Reviewed code changes pushed via Pull Request from QORVYNA AI.");
  const [prRefreshTick, setPrRefreshTick] = useState(0);

  const [reviewed, setReviewed] = useState(false);
  const [importApproved, setImportApproved] = useState(false);
  const [preview, setPreview] = useState<Review | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [commitUrl, setCommitUrl] = useState<string | null>(null);
  const [createdPr, setCreatedPr] = useState<{ number: number; url: string; branch: string } | null>(null);

  // Personal Access Token save form
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [savingToken, setSavingToken] = useState(false);

  // Create repository from AI / workspace
  const [showCreateRepo, setShowCreateRepo] = useState(autoOpenCreateRepo);
  const [newRepoName, setNewRepoName] = useState(() =>
    suggestedRepoName ? slugifyRepoName(suggestedRepoName) : "",
  );
  const [newRepoDescription, setNewRepoDescription] = useState(
    suggestedRepoDescription ?? "Created with QORVYNA AI",
  );
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [newRepoAutoInit, setNewRepoAutoInit] = useState(true);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [savingTarget, setSavingTarget] = useState(false);

  const sawUnauthBeforeReady = useRef(false);
  const popupTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (autoOpenCreateRepo) setShowCreateRepo(true);
  }, [autoOpenCreateRepo]);

  useEffect(() => {
    if (suggestedRepoName) setNewRepoName(slugifyRepoName(suggestedRepoName));
  }, [suggestedRepoName]);

  useEffect(() => {
    if (suggestedRepoDescription) setNewRepoDescription(suggestedRepoDescription);
  }, [suggestedRepoDescription]);

  useEffect(() => {
    if (!prTitleEdited) setPrTitle(message);
  }, [message, prTitleEdited]);

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.fullName === repository),
    [repos, repository],
  );
  // Binary workspace assets are not text: never send their base64 as file text.
  const selectedFiles = files.filter(
    (file) => file.encoding !== "base64" && !excluded.includes(file.path),
  );
  const inputKey = JSON.stringify([
    repository,
    branch,
    projectRevision,
    selectedFiles.map((file) => [file.path, file.content]),
  ]);
  const previewCurrent = preview?.inputKey === inputKey && preview.expiresAt > Date.now();

  const loadStatus = useCallback(async () => {
    try {
      const response = await githubFetch("/api/github/status", { cache: "no-store" });
      if (response.status === 401) {
        if (
          firebaseBrowserConfigured &&
          (authLifecycle.status === "INITIALIZING" || authLifecycle.status === "PROFILE_LOADING")
        ) {
          sawUnauthBeforeReady.current = true;
          return;
        }
        setStatus((prev) => prev ?? { configured: true, connected: false });
        setStatusLoadFailed(false);
        return;
      }
      if (!response.ok) {
        setStatusLoadFailed(true);
        setNotice("GitHub status could not be loaded. Try again.");
        return;
      }
      const data = (await response.json()) as GithubStatus;
      sawUnauthBeforeReady.current = false;
      setStatusLoadFailed(false);
      setStatus(data);
      if (data.reauthorize) {
        setNotice("Your GitHub session expired or was revoked. Reconnect GitHub to continue.");
      }
    } catch {
      setStatusLoadFailed(true);
      setNotice("GitHub status could not be loaded. Try again.");
    }
  }, [authLifecycle.status]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (
      authLifecycle.status === "READY" &&
      (sawUnauthBeforeReady.current || status === null || statusLoadFailed)
    ) {
      sawUnauthBeforeReady.current = false;
      void loadStatus();
    }
  }, [authLifecycle.status, status, statusLoadFailed, loadStatus]);

  const loadRepos = useCallback(async () => {
    try {
      const response = await githubFetch("/api/github/repos", { cache: "no-store" });
      if (!response.ok) throw new Error("repos");
      const data = (await response.json()) as {
        repositories?: Repo[];
        savedBinding?: { repository: string; branch: string };
      };
      const next = data.repositories ?? [];
      setRepos(next);
      const saved = data.savedBinding ?? readLocalTarget(projectId);
      if (saved && next.some((item) => item.fullName === saved.repository)) {
        setRepository((value) => value || saved.repository);
        setBranch((value) => value || saved.branch);
      } else if (next[0]) {
        setRepository((value) => value || next[0].fullName);
        setBranch((value) => value || next[0].defaultBranch);
      }
    } catch {
      setNotice("Your repositories could not be loaded. Reconnect GitHub and try again.");
    }
  }, [projectId]);

  useEffect(() => {
    if (!showPush || !status?.connected) return;
    let cancelled = false;
    void loadRepos().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [showPush, status?.connected, loadRepos]);

  useEffect(() => {
    function handlePopupMessage(event: MessageEvent) {
      if (typeof window !== "undefined" && event.origin !== window.location.origin) return;
      const payload = event.data as { type?: string; status?: string } | null;
      if (!payload || payload.type !== "qorvyna:github-oauth") return;
      if (payload.status === "connected") {
        setNotice("GitHub connected and saved.");
        void loadStatus();
      } else if (payload.status) {
        setNotice(`GitHub connection status: ${payload.status}.`);
      }
    }
    window.addEventListener("message", handlePopupMessage);
    return () => {
      window.removeEventListener("message", handlePopupMessage);
      if (popupTimerRef.current !== null) {
        window.clearInterval(popupTimerRef.current);
      }
    };
  }, [loadStatus]);

  useEffect(() => {
    if (repository && branch) {
      writeLocalTarget(projectId, repository, branch);
    }
  }, [projectId, repository, branch]);

  function handleConnectClick(event: React.MouseEvent<HTMLAnchorElement>) {
    if (typeof window === "undefined") return;
    const separator = connectHref.includes("?") ? "&" : "?";
    const popup = window.open(
      `${connectHref}${separator}mode=popup`,
      "qorvyna_github_oauth",
      "popup=yes,width=620,height=720",
    );
    if (!popup) return;
    event.preventDefault();
    setNotice("Completing GitHub authorization…");
    if (popupTimerRef.current !== null) {
      window.clearInterval(popupTimerRef.current);
    }
    popupTimerRef.current = window.setInterval(() => {
      if (popup.closed) {
        if (popupTimerRef.current !== null) {
          window.clearInterval(popupTimerRef.current);
          popupTimerRef.current = null;
        }
        void loadStatus();
      }
    }, 800);
  }

  async function savePersonalAccessToken() {
    const trimmed = tokenInput.trim();
    if (trimmed.length < 20) {
      setNotice("Enter a valid GitHub Personal Access Token (at least 20 characters).");
      return;
    }
    setSavingToken(true);
    setNotice(null);
    try {
      const response = await githubFetch("/api/github/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: trimmed }),
      });
      const data = (await response.json().catch(() => ({}))) as GithubStatus & { error?: string };
      if (!response.ok || !data.connected) {
        setNotice(
          data.error === "GITHUB_TOKEN_UNAUTHORIZED"
            ? "GitHub rejected that token. Ensure it is active and has repo + read:user permissions."
            : data.error === "GITHUB_NOT_CONFIGURED"
              ? "Server token encryption key is missing (set GITHUB_TOKEN_ENCRYPTION_KEY or PROVIDER_SECRET_KEY)."
              : "Could not verify and save that GitHub token.",
        );
        return;
      }
      setTokenInput("");
      setShowTokenForm(false);
      setStatus(data);
      setStatusLoadFailed(false);
      setNotice(`Saved GitHub connection for @${data.connection?.login ?? "account"}.`);
    } catch {
      setNotice("Could not save GitHub token right now. Try again.");
    } finally {
      setSavingToken(false);
    }
  }

  async function disconnect() {
    const confirmed = await dialogs.confirm({
      title: "Disconnect GitHub?",
      body: "QORVYNA loses access to your repositories. Files already generated or pushed are not deleted.",
      confirmLabel: "Disconnect",
    });
    if (!confirmed) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await githubFetch("/api/github/status", { method: "DELETE" });
      if (!response.ok) throw new Error("disconnect");
      setStatus((current) => ({ configured: current?.configured ?? true, connected: false }));
      setRepos([]);
      setPreview(null);
      setReviewed(false);
      setCommitUrl(null);
      setCreatedPr(null);
    } catch {
      setNotice("GitHub could not be disconnected. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function suggestRepoFromContext() {
    if (suggestedRepoName) {
      setNewRepoName(slugifyRepoName(suggestedRepoName));
      if (suggestedRepoDescription) setNewRepoDescription(suggestedRepoDescription);
      return;
    }
    const pkgFile = files.find((f) => f.path === "package.json" && f.encoding !== "base64");
    if (pkgFile) {
      try {
        const pkg = JSON.parse(pkgFile.content) as { name?: string; description?: string };
        if (pkg.name) setNewRepoName(slugifyRepoName(pkg.name));
        if (pkg.description) setNewRepoDescription(pkg.description.slice(0, 200));
        return;
      } catch {
        // ignore invalid json
      }
    }
    const readme = files.find((f) => /^readme\.md$/i.test(f.path) && f.encoding !== "base64");
    const heading = readme?.content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading) {
      setNewRepoName(slugifyRepoName(heading));
      setNewRepoDescription(`${heading} — built with QORVYNA AI`);
      return;
    }
    setNewRepoName(`qorvyna-app-${new Date().toISOString().slice(0, 10)}`);
    setNewRepoDescription("Generated and managed with QORVYNA AI");
  }

  async function createRepository() {
    const cleanName = newRepoName.trim();
    if (!cleanName) {
      setNotice("Enter a repository name first.");
      return;
    }
    setCreatingRepo(true);
    setNotice(null);
    try {
      const response = await githubFetch("/api/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cleanName,
          description: newRepoDescription.trim(),
          private: newRepoPrivate,
          autoInit: newRepoAutoInit,
          ...(projectId ? { projectId } : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        repository?: Repo;
        error?: string;
      };
      if (!response.ok || !data.repository) {
        setNotice(
          data.error === "REPO_NAME_INVALID"
            ? "Repository name may only contain letters, numbers, hyphens, underscores, or periods."
            : "GitHub could not create that repository (check if the name already exists).",
        );
        return;
      }
      const created = data.repository;
      setRepos((prev) => [created, ...prev.filter((item) => item.fullName !== created.fullName)]);
      setRepository(created.fullName);
      setBranch(created.defaultBranch || "main");
      writeLocalTarget(projectId, created.fullName, created.defaultBranch || "main");
      setShowCreateRepo(false);
      setReviewed(false);
      setPreview(null);
      setNotice(`Created repository ${created.fullName} and selected ${created.defaultBranch || "main"}.`);
    } catch {
      setNotice("Could not create repository right now. Try again.");
    } finally {
      setCreatingRepo(false);
    }
  }

  async function saveRepositoryTarget() {
    if (!repository || !branch) return;
    writeLocalTarget(projectId, repository, branch);
    if (!projectId) {
      setNotice(`Saved target ${repository} (${branch}).`);
      return;
    }
    setSavingTarget(true);
    setNotice(null);
    try {
      const response = await githubFetch("/api/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_binding",
          projectId,
          repository,
          branch,
        }),
      });
      if (!response.ok) throw new Error("save_binding");
      setNotice(`Saved ${repository} (${branch}) for this project.`);
    } catch {
      setNotice(`Saved ${repository} (${branch}) locally.`);
    } finally {
      setSavingTarget(false);
    }
  }

  async function loadPreview() {
    if (!repository || !branch || !selectedFiles.length) return;
    setBusy(true);
    setNotice(null);
    setReviewed(false);
    setImportApproved(false);
    setPreview(null);
    try {
      const response = await githubFetch("/api/github/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, branch, files: selectedFiles }),
      });
      const data = (await response.json().catch(() => ({}))) as Omit<Review, "inputKey"> & {
        error?: string;
      };
      if (!response.ok || !data.reviewToken) throw new Error(data.error || "preview");
      setPreview({ ...data, inputKey });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setNotice(
        code === "GITHUB_RATE_LIMITED"
          ? "Too many GitHub requests. Wait a minute before comparing again."
          : code === "FILES_SENSITIVE"
            ? "Deselect environment files and private-key files before reviewing."
            : code === "GITHUB_REMOTE_FILE_UNSUPPORTED" || code === "GITHUB_REMOTE_FILES_TOO_LARGE"
              ? "A remote file is binary, executable, a symlink, too large or otherwise unsupported. Review it in GitHub instead."
              : code === "GITHUB_PUSH_FORBIDDEN"
                ? "This account does not have push permission for the selected repository."
                : "Could not load a complete comparison. Check the repository and branch, then try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function push() {
    if (
      !reviewed ||
      !previewCurrent ||
      !preview ||
      !repository ||
      !branch ||
      !message.trim() ||
      !selectedFiles.length
    ) {
      return;
    }
    const confirmed = await dialogs.confirm({
      title: `Push ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} to ${branch}?`,
      body: `Commit to ${repository} on ${branch} at reviewed HEAD ${preview.head.slice(0, 7)} with message: ${message.trim()}`,
      confirmLabel: "Push",
      tone: "primary",
    });
    if (!confirmed) return;
    setBusy(true);
    setNotice(null);
    setCommitUrl(null);
    setCreatedPr(null);
    try {
      const response = await githubFetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "agent",
          repository,
          branch,
          message: message.trim(),
          files: selectedFiles,
          reviewToken: preview.reviewToken,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        commitUrl?: string;
        commitSha?: string;
      };
      if (!response.ok || !data.commitUrl) throw new Error(data.error || "push");
      setCommitUrl(data.commitUrl);
      setNotice(`Pushed commit ${data.commitSha?.slice(0, 7) ?? "successfully"}.`);
      setReviewed(false);
      setPreview(null);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "GITHUB_HEAD_CHANGED" || code === "GITHUB_REVIEW_REQUIRED") {
        setPreview(null);
        setReviewed(false);
      }
      setNotice(
        code === "GITHUB_RATE_LIMITED"
          ? "Too many push attempts. Wait a minute before retrying."
          : code === "GITHUB_HEAD_CHANGED"
            ? "The remote branch changed since review. Refresh the comparison before pushing."
            : code === "GITHUB_REVIEW_REQUIRED"
              ? "The review expired or changed. Refresh the comparison before pushing."
              : code === "FILES_SENSITIVE"
                ? "Remove environment files or private-key material before pushing."
                : code === "FILES_INVALID" || code === "FILES_TOO_LARGE"
                  ? "Review the file paths and size limits before pushing."
                  : code.includes("409") || code.includes("422")
                    ? "GitHub rejected the update. Refresh the branch, review changes and try again."
                    : "The push could not be confirmed. Check the branch and repository access before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function pushViaPullRequest() {
    const cleanHead = prBranch.trim();
    const cleanTitle = (prTitle.trim() || message.trim()).slice(0, 160);
    if (
      !reviewed ||
      !previewCurrent ||
      !preview ||
      !repository ||
      !branch ||
      !cleanHead ||
      !cleanTitle ||
      !message.trim() ||
      !selectedFiles.length
    ) {
      return;
    }
    if (cleanHead === branch) {
      setNotice("Pull request branch must be different from the base branch.");
      return;
    }
    const confirmed = await dialogs.confirm({
      title: `Create Pull Request (${cleanHead} → ${branch})?`,
      body: `Create branch ${cleanHead} from reviewed HEAD ${preview.head.slice(0, 7)}, commit ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"}, and open Pull Request "${cleanTitle}" on ${repository}.`,
      confirmLabel: "Create Pull Request",
      tone: "primary",
    });
    if (!confirmed) return;

    setBusy(true);
    setNotice(null);
    setCommitUrl(null);
    setCreatedPr(null);
    try {
      const response = await githubFetch("/api/github/pull-requests/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "agent",
          repository,
          baseBranch: branch,
          headBranch: cleanHead,
          title: cleanTitle,
          body: prBody,
          message: message.trim(),
          files: selectedFiles,
          reviewToken: preview.reviewToken,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        commitSha?: string;
        commitUrl?: string;
        prNumber?: number;
        prUrl?: string;
        branch?: string;
      };
      if (!response.ok || !data.prUrl || !data.prNumber) throw new Error(data.error || "push_pr");
      setCommitUrl(data.commitUrl ?? null);
      setCreatedPr({
        number: data.prNumber,
        url: data.prUrl,
        branch: data.branch ?? cleanHead,
      });
      setPrRefreshTick((tick) => tick + 1);
      setPrBranch(`qorvyna/agent-changes-${Date.now().toString(36).slice(-4)}`);
      setNotice(
        `Created Pull Request #${data.prNumber} (${cleanHead} → ${branch}) with commit ${data.commitSha?.slice(0, 7) ?? "confirmed"}.`,
      );
      setReviewed(false);
      setPreview(null);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setPreview(null);
      setReviewed(false);
      setNotice(
        code === "GITHUB_BRANCH_EXISTS"
          ? "That PR branch already exists on GitHub with different commits. Pick a new PR branch name and compare again."
          : code === "GITHUB_HEAD_CHANGED"
            ? "The base branch changed since review. Compare with GitHub again before creating the PR."
            : code === "GITHUB_REVIEW_REQUIRED"
              ? "The review expired or changed. Compare with GitHub again before creating the PR."
              : code === "GITHUB_RATE_LIMITED"
                ? "Too many GitHub requests. Wait a minute before retrying."
                : "Pull request creation could not be confirmed. Check GitHub Pull Requests before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function importRemote() {
    if (
      !onImport ||
      !projectId ||
      !importApproved ||
      importDisabled ||
      !previewCurrent ||
      !preview ||
      projectRevision === undefined
    ) {
      return;
    }
    const changed = preview.files.filter((file) => file.before !== null && file.status === "changed");
    if (!changed.length) return;
    const revision = projectRevision;
    const confirmed = await dialogs.confirm({
      title: `Import ${changed.length} remote file${changed.length === 1 ? "" : "s"}?`,
      body: `Replace the selected workspace files with the versions shown at ${repository} commit ${preview.head.slice(0, 12)}. A snapshot is saved first. Imported code is untrusted and may run in a project preview.`,
      confirmLabel: "Import reviewed files",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    setNotice(null);
    try {
      await onImport({
        files: changed.map((file) => ({ path: file.path, content: file.before! })),
        localFiles: changed.map((file) => ({ path: file.path, content: file.after })),
        expectedRevision: revision,
        projectId,
      });
      setPreview(null);
      setReviewed(false);
      setImportApproved(false);
      setNotice(
        `Imported ${changed.length} reviewed file${changed.length === 1 ? "" : "s"}. A snapshot of the previous workspace was saved.`,
      );
    } catch {
      setPreview(null);
      setReviewed(false);
      setImportApproved(false);
      setNotice(
        "Import could not be confirmed or the workspace changed. Check the workspace, reload if necessary, and compare again before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    if (statusLoadFailed) {
      return (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2 p-4 text-xs text-ink-2">
          <span>GitHub connection status could not be loaded right now.</span>
          <Button
            variant="secondary"
            onClick={() => {
              setStatusLoadFailed(false);
              void loadStatus();
            }}
          >
            <RefreshCw size={13} /> Retry
          </Button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-ink-3">
        <Loader2 className="animate-spin" size={15} /> Checking GitHub connection…
      </div>
    );
  }

  const renderTokenSaveBox = () =>
    showTokenForm ? (
      <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface p-3">
        <label htmlFor="github-pat-input" className="block text-xs font-medium text-ink-2">
          Personal Access Token (<span className="font-mono">repo</span>, <span className="font-mono">read:user</span>)
        </label>
        <Input
          id="github-pat-input"
          type="password"
          value={tokenInput}
          onChange={(event) => setTokenInput(event.target.value)}
          placeholder="ghp_... or github_pat_..."
          autoComplete="off"
        />
        <p className="text-[11px] text-ink-3">
          Verified live against GitHub and saved AES-256-GCM encrypted in Firestore so your connection persists across refreshes.
        </p>
        <Button
          onClick={() => void savePersonalAccessToken()}
          disabled={savingToken || tokenInput.trim().length < 20}
          className="w-full"
        >
          {savingToken ? <Loader2 className="animate-spin" size={14} /> : <KeyRound size={14} />}
          Save GitHub connection
        </Button>
      </div>
    ) : null;

  if (!status.configured) {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning-soft p-4">
        <p className="text-sm font-semibold text-warning">GitHub OAuth redirect is not configured</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-2">
          The administrator must configure GitHub OAuth credentials, NEXT_PUBLIC_APP_URL and the matching callback URL for OAuth sign-in, or you can save a Personal Access Token directly.
          {status.configuration_error ? ` (${status.configuration_error})` : ""}
        </p>
        <div className="mt-3">
          <Button variant="secondary" onClick={() => setShowTokenForm((prev) => !prev)}>
            <KeyRound size={14} /> {showTokenForm ? "Hide token form" : "Connect & save token"}
          </Button>
        </div>
        {renderTokenSaveBox()}
        {notice ? <p className="mt-2 text-xs text-ink-2">{notice}</p> : null}
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="rounded-xl border border-border bg-surface-2 p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border-strong bg-surface">
            <Github size={18} />
          </span>
          <div>
            <p className="text-sm font-semibold text-ink">Connect GitHub</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">
              Authorise repository access to create repositories and push code via Pull Request. QORVYNA encrypts and persists the token server-side across sessions.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <a
            href={connectHref}
            onClick={handleConnectClick}
            className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-medium text-bg hover:bg-ink-2"
          >
            <Github size={15} /> Continue with GitHub
          </a>
          <Button variant="secondary" onClick={() => setShowTokenForm((prev) => !prev)}>
            <KeyRound size={14} /> {showTokenForm ? "Hide token" : "Save token"}
          </Button>
        </div>
        {renderTokenSaveBox()}
        {notice ? <p className="mt-2 text-xs text-ink-2">{notice}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {status.connection?.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={status.connection.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
          ) : (
            <Github size={18} />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">@{status.connection?.login}</p>
            <p className="flex items-center gap-1 text-[11px] text-success">
              <ShieldCheck size={11} /> Connected securely
              {status.upstreamDegraded ? " · cached" : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              if (!showCreateRepo && !newRepoName) suggestRepoFromContext();
              setShowCreateRepo((prev) => !prev);
            }}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-ink hover:bg-surface-2"
          >
            <FolderPlus size={13} /> {showCreateRepo ? "Close" : "Create repo"}
          </button>
          <button
            type="button"
            onClick={() => void disconnect()}
            disabled={busy}
            className="grid h-9 w-9 place-items-center rounded-lg text-ink-3 hover:bg-surface hover:text-danger"
            aria-label="Disconnect GitHub"
            title="Disconnect GitHub"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>

      {showCreateRepo ? (
        <section
          className="space-y-2.5 rounded-xl border border-border bg-surface-2 p-3"
          aria-label="Create GitHub repository"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-ink">Create GitHub Repository</p>
            <button
              type="button"
              onClick={suggestRepoFromContext}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-ink-2 hover:text-ink"
            >
              <Sparkles size={11} /> Suggest from AI
            </button>
          </div>
          <div>
            <label htmlFor="new-repo-name" className="mb-1 block text-xs font-medium text-ink-2">
              Repository name
            </label>
            <Input
              id="new-repo-name"
              value={newRepoName}
              onChange={(event) => setNewRepoName(event.target.value)}
              placeholder="qorvyna-my-project"
              disabled={creatingRepo}
              maxLength={100}
            />
          </div>
          <div>
            <label htmlFor="new-repo-description" className="mb-1 block text-xs font-medium text-ink-2">
              Description
            </label>
            <Input
              id="new-repo-description"
              value={newRepoDescription}
              onChange={(event) => setNewRepoDescription(event.target.value)}
              placeholder="Created from QORVYNA AI"
              disabled={creatingRepo}
              maxLength={350}
            />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs text-ink-2">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={newRepoPrivate}
                onChange={(event) => setNewRepoPrivate(event.target.checked)}
                disabled={creatingRepo}
              />
              <span>Private repository</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={newRepoAutoInit}
                onChange={(event) => setNewRepoAutoInit(event.target.checked)}
                disabled={creatingRepo}
              />
              <span>Initialize default branch (README)</span>
            </label>
          </div>
          <Button
            onClick={() => void createRepository()}
            disabled={creatingRepo || !newRepoName.trim()}
            className="w-full"
          >
            {creatingRepo ? <Loader2 className="animate-spin" size={14} /> : <FolderPlus size={14} />}
            Create repository on GitHub
          </Button>
        </section>
      ) : null}

      {showPush ? (
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label htmlFor="agent-repository" className="block text-xs font-medium text-ink-2">
                Repository
              </label>
              <button
                type="button"
                onClick={() => void saveRepositoryTarget()}
                disabled={busy || savingTarget || !repository || !branch}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-2 hover:text-ink disabled:opacity-50"
              >
                <BookmarkCheck size={12} /> {savingTarget ? "Saving…" : "Save target"}
              </button>
            </div>
            <Select
              id="agent-repository"
              value={repository}
              onChange={(event) => {
                const nextRepo = repos.find((item) => item.fullName === event.target.value);
                setRepository(event.target.value);
                if (nextRepo) setBranch(nextRepo.defaultBranch);
                setReviewed(false);
                setImportApproved(false);
              }}
              disabled={busy || repos.length === 0}
            >
              {repos.length === 0 ? (
                <option value="">No writable repositories found — click Create repo above</option>
              ) : (
                repos.map((repo) => (
                  <option key={repo.id} value={repo.fullName}>
                    {repo.fullName}
                    {repo.private ? " · private" : ""}
                  </option>
                ))
              )}
            </Select>
          </div>
          <div>
            <label htmlFor="agent-branch" className="mb-1.5 block text-xs font-medium text-ink-2">
              Branch
            </label>
            <Input
              id="agent-branch"
              value={branch}
              onChange={(event) => {
                setBranch(event.target.value);
                setReviewed(false);
                setImportApproved(false);
              }}
              disabled={busy}
              placeholder="main"
            />
          </div>
          <div>
            <label htmlFor="agent-commit" className="mb-1.5 block text-xs font-medium text-ink-2">
              Commit message
            </label>
            <Input
              id="agent-commit"
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                setReviewed(false);
              }}
              disabled={busy}
              maxLength={160}
            />
          </div>

          <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <GitBranch size={13} /> Pull Request Push Options
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="agent-pr-branch" className="mb-1 block text-[11px] font-medium text-ink-2">
                  PR head branch (created from {branch || "base"})
                </label>
                <Input
                  id="agent-pr-branch"
                  value={prBranch}
                  onChange={(event) => setPrBranch(event.target.value)}
                  disabled={busy}
                  placeholder="qorvyna/feature-branch"
                />
              </div>
              <div>
                <label htmlFor="agent-pr-title" className="mb-1 block text-[11px] font-medium text-ink-2">
                  Pull request title
                </label>
                <Input
                  id="agent-pr-title"
                  value={prTitle}
                  onChange={(event) => {
                    setPrTitleEdited(true);
                    setPrTitle(event.target.value);
                  }}
                  disabled={busy}
                  maxLength={160}
                />
              </div>
            </div>
            <div>
              <label htmlFor="agent-pr-body" className="mb-1 block text-[11px] font-medium text-ink-2">
                PR description
              </label>
              <Input
                id="agent-pr-body"
                value={prBody}
                onChange={(event) => setPrBody(event.target.value)}
                disabled={busy}
                maxLength={1000}
              />
            </div>
          </div>

          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-xs font-medium text-ink-2">Files to review and push</legend>
            <div className="max-h-44 space-y-2 overflow-auto">
              {files.map((file) => (
                <label key={file.path} className="flex items-start gap-2 text-xs text-ink-2">
                  <input
                    type="checkbox"
                    disabled={busy || file.encoding === "base64"}
                    checked={file.encoding !== "base64" && !excluded.includes(file.path)}
                    onChange={(event) => {
                      setExcluded((current) =>
                        event.target.checked
                          ? current.filter((path) => path !== file.path)
                          : [...current, file.path],
                      );
                      setReviewed(false);
                      setImportApproved(false);
                    }}
                  />
                  <span className="break-all">
                    {file.path}
                    {file.encoding === "base64" ? " · binary files are not supported" : ""}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Button
            onClick={() => void loadPreview()}
            disabled={busy || !selectedFiles.length || !repository || !branch}
            variant="secondary"
            className="w-full"
          >
            {busy ? <Loader2 className="animate-spin" size={15} /> : null} Compare with GitHub
          </Button>
          {preview && previewCurrent ? (
            <section className="space-y-2" aria-label="GitHub comparison">
              <p className="text-xs text-ink-2">
                Remote HEAD: <span className="font-mono">{preview.head.slice(0, 12)}</span>. Compare the remote and staged versions before approving. Deletions are not included.
              </p>
              {preview.files.map((file) => (
                <details key={file.path} className="rounded-lg border border-border p-2">
                  <summary className="cursor-pointer break-all text-xs font-medium text-ink">
                    {file.path} · {file.status}
                  </summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div>
                      <p className="mb-1 text-xs text-ink-3">Remote</p>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-xs">
                        {file.before === null ? "(new file)" : file.before}
                      </pre>
                    </div>
                    <div>
                      <p className="mb-1 text-xs text-ink-3">Staged</p>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-xs">
                        {file.after}
                      </pre>
                    </div>
                  </div>
                </details>
              ))}
            </section>
          ) : preview ? (
            <p className="text-xs text-warning">
              Files or target changed, or the review expired. Compare again.
            </p>
          ) : null}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-xs leading-relaxed text-ink-2">
            <input
              type="checkbox"
              checked={reviewed && Boolean(previewCurrent)}
              disabled={!previewCurrent || busy}
              onChange={(event) => setReviewed(event.target.checked)}
              className="mt-0.5 accent-current"
            />
            <span>
              I reviewed the comparison for all {selectedFiles.length} selected file
              {selectedFiles.length === 1 ? "" : "s"} and approve this commit.
            </span>
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              onClick={() => void pushViaPullRequest()}
              disabled={
                busy ||
                !reviewed ||
                !previewCurrent ||
                !selectedFiles.length ||
                !repository ||
                !branch ||
                !prBranch.trim() ||
                prBranch.trim() === branch ||
                !message.trim()
              }
              className="w-full"
            >
              {busy ? <Loader2 className="animate-spin" size={15} /> : <GitPullRequestArrow size={15} />}
              Create Pull Request
            </Button>
            <Button
              variant="secondary"
              onClick={() => void push()}
              disabled={
                busy ||
                !reviewed ||
                !previewCurrent ||
                !selectedFiles.length ||
                !repository ||
                !branch ||
                !message.trim()
              }
              className="w-full"
            >
              {busy ? <Loader2 className="animate-spin" size={15} /> : <Github size={15} />}
              Push to GitHub
            </Button>
          </div>
          {!selectedFiles.length ? (
            <p className="text-center text-xs text-ink-3">Select at least one text file to review.</p>
          ) : null}
          {onImport && preview && previewCurrent ? (
            <section
              className="space-y-2 rounded-lg border border-warning/30 p-3"
              aria-label="Import remote files"
            >
              <p className="text-xs leading-relaxed text-ink-2">
                You can instead replace the selected changed workspace text files with the remote versions shown above. Remote-only files, deletions and merges are not included. Imported code is untrusted and may run in preview.
              </p>
              <label className="flex items-start gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={importApproved}
                  disabled={busy || importDisabled}
                  onChange={(event) => setImportApproved(event.target.checked)}
                />
                <span>
                  I reviewed the remote versions and approve replacing the corresponding workspace files.
                </span>
              </label>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => void importRemote()}
                disabled={
                  busy ||
                  importDisabled ||
                  !importApproved ||
                  !preview.files.some((file) => file.before !== null && file.status === "changed")
                }
              >
                Import reviewed remote files
              </Button>
              {importDisabled ? (
                <p className="text-xs text-warning">
                  Save pending workspace changes or resolve the save error before importing.
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {showPush && selectedRepo ? (
        <GithubPullRequestBrowser
          key={`browse:${selectedRepo.fullName}:${prRefreshTick}`}
          repository={repository}
        />
      ) : null}
      {showPush && selectedRepo ? (
        <GithubPullRequest
          key={selectedRepo.fullName}
          repository={repository}
          defaultBranch={selectedRepo.defaultBranch}
          sourceBranch={branch}
        />
      ) : null}

      {notice ? (
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            {commitUrl || createdPr ? <Check size={12} className="text-success" /> : null}
            {notice}
          </span>
          {createdPr ? (
            <a
              href={createdPr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 inline-flex items-center gap-1 font-medium text-accent hover:underline"
            >
              <Link2 size={11} /> View PR #{createdPr.number}
            </a>
          ) : null}
          {commitUrl ? (
            <a
              href={commitUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 inline-flex items-center gap-1 font-medium text-accent hover:underline"
            >
              <Link2 size={11} /> View commit
            </a>
          ) : null}
        </div>
      ) : null}
      {dialogs.element}
    </div>
  );
}
