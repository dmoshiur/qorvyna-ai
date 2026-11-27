import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import {
  createGithubRepo,
  getProjectGithubBinding,
  listGithubRepos,
  saveProjectGithubBinding,
} from "@/lib/server/github";
import {
  auditGithub,
  githubCreateRepoSchema,
  githubErrorResponse,
  githubRateLimited,
  githubSaveBindingSchema,
  readGithubJson,
} from "@/lib/server/github-http";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  try {
    const projectId = req?.nextUrl?.searchParams?.get("projectId")?.trim() ?? "";
    const [repositories, savedBinding] = await Promise.all([
      listGithubRepos(user.uid),
      projectId ? getProjectGithubBinding(user.uid, projectId) : Promise.resolve(null),
    ]);
    return NextResponse.json(
      {
        repositories,
        ...(savedBinding ? { savedBinding } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "GITHUB_ERROR";
    const status = message === "GITHUB_NOT_CONNECTED" ? 409 : message.startsWith("GITHUB_401") ? 401 : 502;
    return NextResponse.json({ error: status === 409 ? "GITHUB_NOT_CONNECTED" : "GITHUB_ERROR" }, { status });
  }
}

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await readGithubJson(req);
  } catch (error) {
    return githubErrorResponse(error);
  }

  // Action 1: Persist repository + branch selection for a project
  if (rawBody && typeof rawBody === "object" && (rawBody as Record<string, unknown>).action === "save_binding") {
    try {
      const parsed = githubSaveBindingSchema.safeParse(rawBody);
      if (!parsed.success) throw new Error("TARGET_INVALID");
      const savedBinding = await saveProjectGithubBinding(
        user.uid,
        parsed.data.projectId,
        parsed.data.repository,
        parsed.data.branch,
      );
      await auditGithub(user.uid, "bind_project", "ok", savedBinding.repository, savedBinding.branch);
      return NextResponse.json({ savedBinding }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return githubErrorResponse(error);
    }
  }

  // Action 2: Create a new GitHub repository (from AI / workspace)
  if (githubRateLimited(user.uid, "repo_create")) {
    return NextResponse.json({ error: "GITHUB_RATE_LIMITED" }, { status: 429 });
  }
  let targetName = "";
  try {
    const parsed = githubCreateRepoSchema.safeParse(rawBody);
    if (!parsed.success) throw new Error("REPO_NAME_INVALID");
    targetName = parsed.data.name;
    const repository = await createGithubRepo(user.uid, {
      name: parsed.data.name,
      description: parsed.data.description,
      private: parsed.data.private,
      autoInit: parsed.data.autoInit,
    });
    let savedBinding: { repository: string; branch: string } | null = null;
    if (parsed.data.projectId) {
      savedBinding = await saveProjectGithubBinding(
        user.uid,
        parsed.data.projectId,
        repository.fullName,
        repository.defaultBranch,
      ).catch(() => null);
    }
    await auditGithub(user.uid, "repo_create", "ok", repository.fullName, repository.defaultBranch);
    return NextResponse.json(
      {
        repository,
        ...(savedBinding ? { savedBinding } : {}),
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    await auditGithub(user.uid, "repo_create", "failed", targetName);
    return githubErrorResponse(error);
  }
}
