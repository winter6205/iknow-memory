/**
 * Dev/prod compose split from specs/config-effective-show.md (Compose).
 * Parses the YAML files. Does not call docker or start containers.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const PRODUCTION_VOLUMES = [
  "iknow-memory-pg",
  "iknow-memory-es",
  "iknow-memory-neo4j",
] as const;

type VolumeSpec = { external?: boolean; name?: string } | null;

type ServiceSpec = {
  image?: string;
  container_name?: string;
  ports?: unknown[];
  volumes?: unknown[];
};

type ComposeFile = {
  name?: string;
  services?: Record<string, ServiceSpec>;
  volumes?: Record<string, VolumeSpec>;
};

function loadCompose(filename: string): { text: string; doc: ComposeFile } {
  const text = readFileSync(join(ROOT, filename), "utf8");
  return { text, doc: parse(text) as ComposeFile };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsKey(item, key));
  }
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((child) => containsKey(child, key));
}

function containerNames(doc: ComposeFile): string[] {
  return Object.values(doc.services ?? {})
    .map((service) => service.container_name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

function serviceNamed(doc: ComposeFile, containerName: string): ServiceSpec {
  const found = Object.values(doc.services ?? {}).find(
    (service) => service.container_name === containerName
  );
  if (!found) {
    throw new Error(`missing container ${containerName}`);
  }
  return found;
}

function publishedHostPort(entry: unknown): string {
  if (typeof entry === "string") {
    const parts = entry.split(":");
    return parts.length >= 3 ? (parts[1] ?? "") : (parts[0] ?? "");
  }
  if (isRecord(entry) && entry.published != null) {
    return String(entry.published);
  }
  return "";
}

function hostPorts(service: ServiceSpec): string[] {
  return (service.ports ?? []).map(publishedHostPort).sort();
}

function mountSource(mount: unknown): string | undefined {
  if (typeof mount === "string") return mount.split(":")[0];
  if (isRecord(mount) && typeof mount.source === "string") return mount.source;
  return undefined;
}

function withoutImageLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*image\s*:/.test(line))
    .join("\n");
}

describe("compose dev/prod split", () => {
  it("parses production volumes as the three external names and has no build key", () => {
    const { doc } = loadCompose("docker-compose.production.yml");

    expect(doc.name).toBe("iknow-memory");
    expect(containerNames(doc)).toEqual([
      "iknow-memory-es",
      "iknow-memory-neo4j",
      "iknow-memory-postgres",
    ]);
    expect(hostPorts(serviceNamed(doc, "iknow-memory-postgres"))).toEqual([
      "5432",
    ]);
    expect(hostPorts(serviceNamed(doc, "iknow-memory-neo4j"))).toEqual([
      "7474",
      "7687",
    ]);
    expect(hostPorts(serviceNamed(doc, "iknow-memory-es"))).toEqual(["9200"]);
    expect(serviceNamed(doc, "iknow-memory-neo4j").image).toBe(
      "iknow-memory-neo4j:5.26.0-gds-2.13.2"
    );
    expect(serviceNamed(doc, "iknow-memory-es").image).toBe(
      "iknow-memory-elasticsearch:8.19.20"
    );
    expect(containsKey(doc, "build")).toBe(false);
    expect(Object.keys(doc.volumes ?? {})).toEqual([...PRODUCTION_VOLUMES]);
    for (const name of PRODUCTION_VOLUMES) {
      expect(doc.volumes?.[name]).toEqual({ external: true, name });
    }
  });

  it("keeps repository compose on the dev project, containers, and host ports", () => {
    const { text, doc } = loadCompose("docker-compose.yml");

    expect(doc.name).toBe("iknow-memory-dev");
    expect(containerNames(doc)).toEqual([
      "iknow-memory-dev-es",
      "iknow-memory-dev-neo4j",
      "iknow-memory-dev-postgres",
    ]);
    expect(hostPorts(serviceNamed(doc, "iknow-memory-dev-postgres"))).toEqual([
      "5433",
    ]);
    expect(hostPorts(serviceNamed(doc, "iknow-memory-dev-neo4j"))).toEqual([
      "7475",
      "7688",
    ]);
    expect(hostPorts(serviceNamed(doc, "iknow-memory-dev-es"))).toEqual([
      "9201",
    ]);

    const volumes = doc.volumes ?? {};
    expect(Object.keys(volumes).length).toBeGreaterThan(0);
    for (const [name, volume] of Object.entries(volumes)) {
      expect(PRODUCTION_VOLUMES).not.toContain(name);
      expect(volume?.external ?? false).toBe(false);
      if (volume?.name !== undefined) {
        expect(PRODUCTION_VOLUMES).not.toContain(volume.name);
      }
    }
    for (const service of Object.values(doc.services ?? {})) {
      for (const mount of service.volumes ?? []) {
        expect(PRODUCTION_VOLUMES).not.toContain(mountSource(mount));
      }
    }
    const body = withoutImageLines(text);
    for (const name of PRODUCTION_VOLUMES) {
      expect(body).not.toContain(name);
    }
  });
});
