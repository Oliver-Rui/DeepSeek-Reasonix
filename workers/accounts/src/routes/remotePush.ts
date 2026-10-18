import { Hono } from "hono";
import type { AppEnv } from "../env";
import { repos } from "../db";
import { currentUser, requireRemoteWebSession } from "../http/auth";
import { ApiError } from "../http/errors";
import { enforceRateLimit } from "../http/d1RateLimit";
import { ControllerIdParam, PushCategoriesUpdateSchema, PushSubscribeSchema, parseBody } from "../lib/validation";
import { importControllerKey, pushProofMessage, verifyProof, type ControllerJwk } from "../auth/controllerProof";
import { acceptablePushEndpoint, acceptablePushKeys } from "../push/endpoint";
import { decodeKeys } from "../push/vapid";
import { REMOTE_RATE_RULES } from "../config";

// Mounted under /me. A subscription is the address a browser can be notified at,
// so it is attached only with a proof of possession of the controller's key and
// is never returned by any route.
const remotePush = new Hono<AppEnv>();

const controllerNotFound = () => new ApiError(404, "controller_not_found", "That device is unavailable.");
const hostNotFound = () => new ApiError(404, "device_not_found", "That device is unavailable.");

remotePush.get("/key", (c) => {
  currentUser(c);
  const keys = decodeKeys(c.env.VAPID_PUBLIC_KEY ?? "", c.env.VAPID_PRIVATE_KEY ?? "");
  if (!keys) throw new ApiError(503, "push_unavailable", "Notifications are not available right now.");
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY });
});

remotePush.put("/:id", async (c) => {
  const { user, session } = requireRemoteWebSession(c);
  const id = ControllerIdParam.safeParse(c.req.param("id"));
  if (!id.success) throw controllerNotFound();
  await enforceRateLimit(c.env, REMOTE_RATE_RULES.pushSubscribe, session.id);
  if (!decodeKeys(c.env.VAPID_PUBLIC_KEY ?? "", c.env.VAPID_PRIVATE_KEY ?? "")) {
    throw new ApiError(503, "push_unavailable", "Notifications are not available right now.");
  }
  const input = await parseBody(c, PushSubscribeSchema);
  const { remoteDevices, remoteControllers, remoteChallenges, remotePush: pushRepo } = repos(c.env);
  if (!(await remoteDevices.activeForUser(user.id, input.host))) throw hostNotFound();
  const controller = await remoteControllers.activeById(user.id, input.host, id.data);
  if (!controller) throw controllerNotFound();

  if (!acceptablePushEndpoint(input.subscription.endpoint)) {
    throw new ApiError(422, "invalid_endpoint", "That is not a push service address this account can use.");
  }
  if (!acceptablePushKeys(input.subscription.keys)) {
    throw new ApiError(422, "invalid_keys", "The subscription keys are not valid.");
  }
  let jwk: ControllerJwk;
  try {
    jwk = JSON.parse(controller.public_key) as ControllerJwk;
  } catch {
    throw new ApiError(422, "invalid_key", "The device key is not valid.");
  }
  const key = await importControllerKey(jwk);
  if (!key) throw new ApiError(422, "invalid_key", "The device key is not valid.");

  const consumed = await remoteChallenges.consume(input.nonce, {
    userId: user.id, hostDeviceId: input.host, sessionHash: session.id, purpose: "push",
  });
  if (consumed === "expired") throw new ApiError(403, "challenge_expired", "The challenge has expired.");
  if (consumed === "invalid") throw new ApiError(403, "challenge_invalid", "The challenge is not valid.");
  const message = await pushProofMessage({
    nonce: input.nonce, userId: user.id, hostDeviceId: input.host, controllerId: controller.id,
    endpoint: input.subscription.endpoint, p256dh: input.subscription.keys.p256dh, auth: input.subscription.keys.auth,
  });
  if (!(await verifyProof(key, message, input.signature))) {
    throw new ApiError(403, "invalid_proof", "The signature does not prove possession of the key.");
  }

  const subscription = await pushRepo.put({
    userId: user.id,
    hostDeviceId: input.host,
    controllerId: controller.id,
    endpoint: input.subscription.endpoint,
    p256dh: input.subscription.keys.p256dh,
    authSecret: input.subscription.keys.auth,
    categories: input.categories,
  });
  return c.json({ subscription });
});

remotePush.get("/:id", async (c) => {
  const user = currentUser(c);
  const id = ControllerIdParam.safeParse(c.req.param("id"));
  if (!id.success) throw controllerNotFound();
  const subscription = await repos(c.env).remotePush.get(user.id, id.data);
  if (!subscription) throw controllerNotFound();
  return c.json({ subscription });
});

remotePush.patch("/:id", async (c) => {
  const { user } = requireRemoteWebSession(c);
  const id = ControllerIdParam.safeParse(c.req.param("id"));
  if (!id.success) throw controllerNotFound();
  const { categories } = await parseBody(c, PushCategoriesUpdateSchema);
  const subscription = await repos(c.env).remotePush.setCategories(user.id, id.data, categories);
  if (!subscription) throw controllerNotFound();
  return c.json({ subscription });
});

remotePush.delete("/:id", async (c) => {
  const user = currentUser(c);
  const id = ControllerIdParam.safeParse(c.req.param("id"));
  if (!id.success) throw controllerNotFound();
  await repos(c.env).remotePush.remove(user.id, id.data);
  return c.body(null, 204);
});

export default remotePush;
