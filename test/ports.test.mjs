import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { PORT_BASE, PORT_SPAN, PORTS_PER_JOB, allocatePorts, derivePort, expandPortVars, isPortFree, portEnv } from "../lib/ports.mjs";

const ID = "20261007110730597-lifecycle-delayed-cleanu";
const yes = async () => true;

test("derivePort is deterministic", () => {
  assert.equal(derivePort(ID), derivePort(ID));
});

test("derivePort is in range and block aligned", () => {
  for (let i = 0; i < 200; i++) {
    const p = derivePort(`job-${i}`);
    assert.ok(p >= PORT_BASE && p + PORTS_PER_JOB <= PORT_BASE + PORT_SPAN);
    assert.equal((p - PORT_BASE) % PORTS_PER_JOB, 0);
  }
});

test("different ids usually get different blocks", () => {
  const set = new Set(Array.from({ length: 50 }, (_, i) => derivePort(`id-${i}`)));
  assert.ok(set.size > 40);
});

test("allocatePorts uses the derived block when free", async () => {
  const r = await allocatePorts(ID, { isFree: yes });
  assert.equal(r.port, derivePort(ID));
  assert.deepEqual(r.ports, Array.from({ length: PORTS_PER_JOB }, (_, i) => r.port + i));
});

test("taken ports move to the next block", async () => {
  const base = derivePort(ID);
  const r = await allocatePorts(ID, { taken: [base + 2], isFree: yes });
  assert.equal(r.port, base + PORTS_PER_JOB);
});

test("isFree false moves on", async () => {
  const base = derivePort(ID);
  const r = await allocatePorts(ID, { isFree: async (p) => p !== base + 1 });
  assert.equal(r.port, base + PORTS_PER_JOB);
});

test("wraps around the range", async () => {
  const last = PORT_BASE + PORT_SPAN - PORTS_PER_JOB;
  let id;
  for (let i = 0; ; i++) if (derivePort(`w-${i}`) === last) { id = `w-${i}`; break; }
  const r = await allocatePorts(id, { taken: [last], isFree: yes });
  assert.equal(r.port, PORT_BASE);
});

test("full sweep throws", async () => {
  await assert.rejects(allocatePorts(ID, { isFree: async () => false }), /no free block/);
});

test("portEnv", () => {
  const env = portEnv({ port: 20008, ports: [20008, 20009, 20010, 20011] });
  assert.deepEqual(env, { ORCA_PORT: "20008", ORCA_PORTS: "20008,20009,20010,20011", PORT: "20008" });
  assert.deepEqual(portEnv({}), {});
});

test("expandPortVars", () => {
  const job = { port: 20008, ports: [20008, 20009, 20010, 20011] };
  assert.equal(
    expandPortVars("http://localhost:${ORCA_PORT}/ {{port}} ${ORCA_PORT_1} ${ORCA_PORT_2} ${ORCA_PORT_9}", job),
    "http://localhost:20008/ 20008 20008 20009 ${ORCA_PORT_9}",
  );
});

test("isPortFree sees a bound port", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  assert.equal(await isPortFree(port), false);
  await new Promise((r) => server.close(r));
  assert.equal(await isPortFree(port), true);
});
