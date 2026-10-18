import type { Context } from "hono";
import type { AppEnv } from "../env";
import { repos } from "../db";
import { ApiError } from "./errors";
import { enforceRateLimit } from "./d1RateLimit";
import { REMOTE_RATE_RULES } from "../config";

// A desktop proves itself with its own device credential, not an account
// session. The same limit applies to every route a desktop calls this way.
export async function authenticateHost(c: Context<AppEnv>): Promise<{ userId: number; hostId: string }> {
  const deviceId = c.req.header("x-reasonix-device-id") ?? "";
  const credential = c.req.header("x-reasonix-device-credential") ?? "";
  if (!/^[0-9a-f]{64}$/.test(deviceId) || !/^[0-9a-f]{64}$/.test(credential)) {
    throw new ApiError(401, "invalid_device", "The device credential is invalid or revoked.");
  }
  const authenticated = await repos(c.env).remoteDevices.authenticate(deviceId, credential);
  if (!authenticated) throw new ApiError(401, "invalid_device", "The device credential is invalid or revoked.");
  await enforceRateLimit(c.env, REMOTE_RATE_RULES.hostControllers, deviceId);
  return { userId: authenticated.userId, hostId: deviceId };
}
