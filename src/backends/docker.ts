import { run, runOk, which } from "../core/proc.ts";

export function dockerBin(): string {
  const b = which("docker") ?? which("podman");
  if (!b) throw new Error("docker (or podman) not found on PATH");
  return b;
}

export async function docker(args: string[], timeoutMs = 10 * 60_000): Promise<string> {
  return runOk(dockerBin(), args, { timeoutMs });
}

export async function containerState(name: string): Promise<"absent" | "running" | "stopped"> {
  const r = await run(dockerBin(), ["inspect", "-f", "{{.State.Running}}", name]);
  if (r.code !== 0) return "absent";
  return r.stdout.trim() === "true" ? "running" : "stopped";
}

export async function volumeExists(name: string): Promise<boolean> {
  return (await run(dockerBin(), ["volume", "inspect", name])).code === 0;
}

export async function imageExists(ref: string): Promise<boolean> {
  return (await run(dockerBin(), ["image", "inspect", ref])).code === 0;
}

const HELPER_IMAGE = "debian:bookworm-slim";

/** Copy one named volume onto another (reflink where the storage driver supports it). */
export async function copyVolume(from: string, to: string): Promise<void> {
  await docker(["volume", "create", to]);
  await docker(
    [
      "run", "--rm",
      "-v", `${from}:/from:ro`,
      "-v", `${to}:/to`,
      HELPER_IMAGE,
      "sh", "-c", "find /to -mindepth 1 -delete && cp -a --reflink=auto /from/. /to/",
    ],
    6 * 60 * 60_000,
  );
}

/** Can containers get /dev/kvm? Works on Linux and on Windows/WSL2 Docker Desktop with nested virtualization. */
export async function dockerHasKvm(): Promise<boolean> {
  const r = await run(dockerBin(), ["run", "--rm", "--device", "/dev/kvm", "busybox:latest", "test", "-c", "/dev/kvm"], {
    timeoutMs: 120_000,
  });
  return r.code === 0;
}

/** Host port Docker published for a container port (undefined when stopped/unpublished). */
export async function publishedPort(container: string, containerPort: number): Promise<number | undefined> {
  const r = await run(dockerBin(), ["port", container, `${containerPort}/tcp`]);
  if (r.code !== 0) return undefined;
  const m = /:(\d+)\s*$/m.exec(r.stdout.trim().split("\n")[0] ?? "");
  return m ? Number(m[1]) : undefined;
}

/** Host-side binding for `-p`: the preferred port if it is free right now, else let Docker pick one. */
export async function portBinding(preferred: number | undefined, containerPort: number): Promise<string> {
  const { canBind } = await import("../core/ssh.ts");
  if (preferred && (await canBind(preferred))) return `127.0.0.1:${preferred}:${containerPort}`;
  return `127.0.0.1::${containerPort}`;
}

export function isPortConflict(e: unknown): boolean {
  return /port is already allocated|address already in use|bind: /i.test(String((e as Error)?.message ?? e));
}
