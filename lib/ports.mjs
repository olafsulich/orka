// Per-job dev-server ports so concurrent jobs never collide.
import { createHash } from "node:crypto";
import { createServer } from "node:net";

export const PORT_BASE = 20000;
export const PORT_SPAN = 20000;
export const PORTS_PER_JOB = 4;

function blockCount(count) {
  return Math.floor(PORT_SPAN / count);
}

export function derivePort(jobId, count = PORTS_PER_JOB) {
  const digest = createHash("sha256").update(String(jobId)).digest();
  const block = digest.readUInt32BE(0) % blockCount(count);
  return PORT_BASE + block * count;
}

export function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function allocatePorts(jobId, { taken = [], isFree = isPortFree, count = PORTS_PER_JOB } = {}) {
  const blocks = blockCount(count);
  const start = (derivePort(jobId, count) - PORT_BASE) / count;
  const used = new Set(taken.map(Number));
  for (let i = 0; i < blocks; i++) {
    const base = PORT_BASE + ((start + i) % blocks) * count;
    const ports = Array.from({ length: count }, (_, n) => base + n);
    if (ports.some((p) => used.has(p))) continue;
    let ok = true;
    for (const p of ports) {
      if (!(await isFree(p))) {
        ok = false;
        break;
      }
    }
    if (ok) return { port: base, ports };
  }
  throw new Error(`no free block of ${count} ports in ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1} for job ${jobId}`);
}

function jobPorts(job) {
  if (Array.isArray(job?.ports) && job.ports.length) return job.ports;
  return job?.port != null ? [job.port] : [];
}

export function portEnv(job) {
  const ports = jobPorts(job);
  if (!ports.length) return {};
  const port = job.port ?? ports[0];
  return { ORCA_PORT: String(port), ORCA_PORTS: ports.join(","), PORT: String(port) };
}

export function expandPortVars(str, job) {
  const ports = jobPorts(job);
  if (!ports.length || typeof str !== "string") return str;
  const port = job.port ?? ports[0];
  return str
    .replace(/\$\{ORCA_PORT_(\d+)\}/g, (m, n) => (ports[Number(n) - 1] != null ? String(ports[Number(n) - 1]) : m))
    .replaceAll("${ORCA_PORT}", String(port))
    .replaceAll("{{port}}", String(port));
}
