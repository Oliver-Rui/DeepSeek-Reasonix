import { describe, expect, it } from "vitest";
import {
  REVALIDATE_MS,
  CLOSE_IDLE,
  CLOSE_REAUTH_REQUIRED,
  CLOSE_REVOKED,
  CONTROLLER_IDLE_MS,
  leaseEnd,
  nextDeadline,
  readLease,
  verdictEnd,
  type SocketLease,
} from "./lease";

const controller: SocketLease = {
  role: "controller", userId: 7, deviceId: "a".repeat(64), scopes: ["desktop"], connectionId: "c".repeat(32),
  sessionId: "d".repeat(64), admittedAt: 0, lastActiveAt: 0, reauthAt: 10 * CONTROLLER_IDLE_MS,
};

describe("account re-check interval", () => {
  it("is fifteen minutes: every re-check wakes the object and asks the account service, so it is the main cost of an idle connection", () => {
    expect(REVALIDATE_MS).toBe(15 * 60 * 1000);
  });
});

describe("connection lease", () => {
  it("slides with the latest activity, including runtime-answered heartbeats", () => {
    expect(leaseEnd(controller, CONTROLLER_IDLE_MS - 1, null)).toBeNull();
    expect(leaseEnd(controller, CONTROLLER_IDLE_MS, null)?.code).toBe(CLOSE_IDLE);
    expect(leaseEnd(controller, CONTROLLER_IDLE_MS, new Date(1))).toBeNull();
    expect(nextDeadline(controller, new Date(5))).toBe(5 + CONTROLLER_IDLE_MS);
  });

  it("ends at the re-authentication time however active the connection is", () => {
    const active = { ...controller, lastActiveAt: controller.reauthAt! };
    expect(leaseEnd(active, controller.reauthAt!, null)?.code).toBe(CLOSE_REAUTH_REQUIRED);
    expect(nextDeadline(active, null)).toBe(controller.reauthAt);
  });

  it("gives revocation and sign-in their own close codes", () => {
    expect(verdictEnd("revoked")?.code).toBe(CLOSE_REVOKED);
    expect(verdictEnd("reauth_required")?.code).toBe(CLOSE_REAUTH_REQUIRED);
    expect(verdictEnd("active")).toBeNull();
    expect(new Set([CLOSE_IDLE, CLOSE_REAUTH_REQUIRED, CLOSE_REVOKED]).size).toBe(3);
  });

  it("rejects an attachment that is not a lease", () => {
    expect(readLease(null)).toBeNull();
    expect(readLease({ role: "controller", userId: 7 })).toBeNull();
    expect(readLease(controller)).toEqual(controller);
    expect(readLease({ ...controller, reauthAt: null })).toBeNull();
  });
});
