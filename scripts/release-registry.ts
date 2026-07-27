export function registryVersionListed(output: string, version: string): boolean {
  const parsed: unknown = JSON.parse(output);
  const versions = Array.isArray(parsed) ? parsed : [parsed];

  if (!versions.every((item): item is string => typeof item === "string")) {
    throw new Error("registry versions response must contain only strings");
  }

  return versions.includes(version);
}
