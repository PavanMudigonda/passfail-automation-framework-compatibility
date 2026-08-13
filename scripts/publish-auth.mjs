export function passfailRequestHeaders(environment = process.env, headers = {}) {
  const token = environment.PASSFAIL_API_TOKEN?.trim();
  const projectId = environment.PASSFAIL_PROJECT_ID?.trim() || "passfail";
  const repositoryId = environment.PASSFAIL_REPOSITORY_ID?.trim()
    || environment.GITHUB_REPOSITORY?.trim().split("/").at(-1)
    || "";
  return {
    ...headers,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(token && projectId ? { "x-passfail-project-id": projectId } : {}),
    ...(token && repositoryId ? { "x-passfail-repository-id": repositoryId } : {})
  };
}